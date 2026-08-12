import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { api } from './api';

const QUEUE_KEY = '@offline_action_queue';
const MAX_RETRIES = 8;
// Backoff for genuine-client-error retries (not network-error requeues, which
// retry on the very next connectivity edge instead) — without this, a
// transient 5xx got hammered on every single flush attempt.
const BASE_RETRY_DELAY_MS = 30 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
// Belt-and-suspenders alongside the NetInfo offline->online edge trigger in
// startAutoSync: a device can report "online" while requests keep failing
// (flaky wifi, a server blip) — without a periodic sweep the queue only
// retries on the next full disconnect/reconnect cycle, which may never come.
const PERIODIC_RETRY_MS = 60 * 1000;

let unsubscribeNetInfo = null;
let periodicRetryTimer = null;
let flushInFlight = null;

// Called once (by App.js) whenever a queued action turns out to conflict
// with state the server already has (e.g. a retried/offline logout racing
// one that already succeeded) — so the app can refresh from the server
// instead of the UI silently drifting out of sync with what was dropped.
let conflictHandler = null;
export const setConflictHandler = (fn) => {
  conflictHandler = fn;
};

/**
 * Enqueue an API request to be processed later.
 * @param {string} method - e.g., 'post', 'put'
 * @param {string} url - endpoint, e.g., '/visits/login'
 * @param {object} data - payload
 * @param {object} [opts]
 * @param {string} [opts.localId] - temp id this action's response should resolve
 *   (e.g. the 'offline-<ts>' id assigned to an offline-created attendance/visit).
 *   Later queued actions referencing that same temp id get rewritten to the
 *   real server id once this action syncs successfully.
 * @param {'attendance'|'visit'|'reminder'} [opts.resolves] - which id field the response maps to.
 */
export const enqueueAction = async (method, url, data, opts = {}) => {
  try {
    const queue = await getQueue();

    queue.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      method,
      url,
      data,
      localId: opts.localId || null,
      resolves: opts.resolves || null,
      retryCount: 0,
      timestamp: new Date().toISOString(),
      // Generated ONCE here (same format api.js's own interceptor would
      // otherwise generate per-request) and reused on every retry of this
      // action — api.js's request interceptor only fills in a key when one
      // isn't already present on the config, so passing this explicitly
      // below keeps it stable across retries. Without this, a network drop
      // after the server already processed a write (exactly the scenario
      // this queue exists for) is indistinguishable from a fresh request on
      // retry, and idempotency.js can't catch the resulting duplicate.
      idempotencyKey: Date.now().toString(36) + Math.random().toString(36).slice(2),
    });

    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    console.log(`Action queued: ${method} ${url}`);
  } catch (error) {
    console.error('Failed to enqueue action:', error);
  }
};

const getQueue = async () => {
  const queueJson = await AsyncStorage.getItem(QUEUE_KEY);
  return queueJson ? JSON.parse(queueJson) : [];
};

/**
 * Number of actions still waiting to sync — for a UI indicator.
 */
export const getPendingCount = async () => {
  const queue = await getQueue();
  return queue.length;
};

/**
 * Full queue contents — for a "what's stuck" inspector UI. Callers must
 * treat this as read-only; go through removeQueuedAction to mutate.
 */
export const getQueueSnapshot = async () => getQueue();

/**
 * Drop a single queued action without attempting to send it — the manual
 * "discard" side of the sync-queue inspector, for a record the user has
 * decided isn't worth retrying (e.g. it's already stuck past MAX_RETRIES).
 */
export const removeQueuedAction = async (actionId) => {
  const queue = await getQueue();
  const next = queue.filter((a) => a.id !== actionId);
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(next));
};

/**
 * Discard the queue outright. Used on logout — without this, any actions
 * queued by the current user but not yet synced would sit until the next
 * login on this device and then flush under whichever employee logs in
 * next, misattributing the data.
 */
export const clearQueue = async () => {
  await AsyncStorage.removeItem(QUEUE_KEY);
};

// Fields that may hold a temp 'offline-...' id needing rewrite before send.
const ID_FIELDS = ['attendance_id', 'visit_id', 'reminder_id'];

// Some queued actions have no id-bearing body field at all — a
// location-check ping (POST /visits/:id/location-check) or a notification-id
// patch (PATCH /reminders/:id/notifications) address the record purely via
// its URL path segment, with the temp id baked directly into that string at
// enqueue time (e.g. `/visits/offline-1699999999999/location-check`). Those
// need the exact same localId -> real-id rewrite ID_FIELDS does for body
// fields, just applied to the URL instead.
const OFFLINE_ID_IN_URL = /offline-\d+/;

// A real HTTP response (even an error one) means the request reached the
// server and isn't a connectivity problem — defer to that first. Only when
// there's no response at all do we check for the specific codes/messages a
// dropped connection, DNS failure, timeout, or airplane mode actually surface
// as; axios's generic 'ERR_NETWORK'/'Network Error' alone missed several of
// these, silently discarding a queued action instead of retrying it.
export const isNetworkError = (error) => {
  if (error.response) return false;
  if (['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'ERR_INTERNET_DISCONNECTED'].includes(error.code)) {
    return true;
  }
  return typeof error.message === 'string' && /network|timeout/i.test(error.message);
};

// A 404 on a queued delete means the record is already gone — from the
// user's perspective that IS the desired end state, not a failure, so
// treat it as success rather than burning retries and firing a false
// "gave up syncing" alert to the manager for something that isn't broken.
// The same applies to an edit (put/patch) racing a delete from another
// device/session: there's nothing left to apply the edit to, and the
// record being gone already satisfies "the user's local copy no longer
// needs to exist on the server" close enough to resolve it silently.
const isIdempotentNotFound = (action, error) =>
  error.response?.status === 404 && ['delete', 'put', 'patch'].includes(action.method);

/**
 * Attempt to flush the queue to the server, in original order, rewriting
 * any temp ids to their real server ids as earlier queued actions resolve.
 * Safe to call multiple times concurrently — collapses into one in-flight run.
 */
export const flushQueue = async () => {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    try {
      const queue = await getQueue();
      if (queue.length === 0) return;

      console.log(`Flushing ${queue.length} offline actions...`);

      const idMap = {};       // localId -> real server id
      // localIds whose owning action was discarded this pass after
      // exhausting MAX_RETRIES — a dependent action blocked on one of these
      // can NEVER resolve (the parent it needs is never coming), so it must
      // be discarded too rather than requeued forever with no user-visible
      // sign anything is stuck.
      const failedLocalIds = new Set();
      // Actions not yet processed this pass — persisted to storage after
      // every single action settles (not just once at the end), so that if
      // the app is killed mid-flush, an already-synced action can't still be
      // sitting in the persisted queue and get resubmitted (duplicate
      // login/logout records) on the next flush attempt.
      let remaining = [...queue];
      const persistRemaining = () => AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));

      for (const action of queue) {
        // This action is being attempted now — drop it from `remaining`
        // up front; failure paths below push it back on if it should still
        // be retried.
        remaining = remaining.filter((a) => a.id !== action.id);

        // Rewrite any temp id references using ids resolved earlier in this pass.
        const data = { ...action.data };
        let url = action.url;
        let blockedOnDependency = false;
        let blockedOnFailedDependency = false;

        for (const field of ID_FIELDS) {
          const val = data[field];
          if (typeof val === 'string' && val.startsWith('offline-')) {
            if (idMap[val]) {
              data[field] = idMap[val];
            } else if (failedLocalIds.has(val)) {
              blockedOnFailedDependency = true;
            } else {
              blockedOnDependency = true;
            }
          }
        }

        const urlIdMatch = url.match(OFFLINE_ID_IN_URL);
        if (urlIdMatch) {
          const tempId = urlIdMatch[0];
          if (idMap[tempId]) {
            url = url.replace(tempId, idMap[tempId]);
          } else if (failedLocalIds.has(tempId)) {
            blockedOnFailedDependency = true;
          } else {
            blockedOnDependency = true;
          }
        }

        if (blockedOnFailedDependency) {
          // The action this depends on was just permanently discarded (see
          // the MAX_RETRIES branch below) — it will never sync, so this one
          // never can either. Discard it too instead of leaving it queued
          // forever with no way for the user to ever notice or clear it.
          console.error(`Discarding queued action ${action.id}: depends on an action that failed permanently.`);
          api.post('/sync-failures', { method: action.method, url: action.url, error: 'dependency failed permanently' })
            .catch(() => {});
          await persistRemaining();
          continue;
        }

        if (blockedOnDependency) {
          // The action this depends on hasn't synced yet (or failed) —
          // keep it queued and try again on the next flush.
          remaining.push(action);
          await persistRemaining();
          continue;
        }

        if (action.nextRetryAt && Date.now() < action.nextRetryAt) {
          // Backed off after a prior genuine-client-error retry — leave it
          // queued untouched rather than hammering the same failing request
          // on every flush attempt (each connectivity edge, and now also
          // every periodic sweep — see startAutoSync).
          remaining.push(action);
          await persistRemaining();
          continue;
        }

        try {
          const response = await api.request({
            method: action.method,
            url,
            data,
            headers: action.idempotencyKey ? { 'Idempotency-Key': action.idempotencyKey } : undefined,
          });

          if (action.localId && action.resolves === 'attendance') {
            idMap[action.localId] = response.data.attendance?.id;
          } else if (action.localId && action.resolves === 'visit') {
            idMap[action.localId] = response.data.visit?.id;
          } else if (action.localId && action.resolves === 'reminder') {
            idMap[action.localId] = response.data.reminder?.id;
          }

          console.log(`Synced queued action: ${action.method} ${action.url}`);
          await persistRemaining();
        } catch (error) {
          // Only a genuine network failure (offline, DNS, timeout) should retry
          // unbounded — an auth failure (e.g. missing/expired refresh token)
          // surfaces with a real `.response` (401 from /auth/refresh), so
          // isNetworkError already excludes it; retrying that forever would
          // just silently drain the queue without ever telling the user they
          // need to log in again, so it correctly falls through to the
          // bounded path below instead.
          if (isNetworkError(error)) {
            // Still offline / network dropped mid-flush — keep as-is, retry later.
            remaining.push(action);
          } else if (isIdempotentNotFound(action, error)) {
            console.log(`Queued action ${action.id} resolved: server already has no such record (404) — treating as done.`);
          } else if (error.response?.status === 409) {
            // Conflict with state the server already has (duplicate day
            // login, a logout/login racing one that already synced,
            // an interrupt report for a visit already closed, ...). Reconcile
            // rather than silently drop: resolve any dependent queued actions
            // against whatever id the server gave us, and hand the
            // authoritative record to the app so its in-memory state (and
            // any UI showing a now-stale "pending" row) gets refreshed to
            // match the server truth instead of quietly going out of sync.
            const body = error.response.data || {};
            const existingId = body.attendance_id || body.attendance?.id || body.visit?.id;
            if (action.localId && existingId) idMap[action.localId] = existingId;

            console.warn(`Reconciling conflicting queued action ${action.id} against server state:`, body.error);
            if (conflictHandler) {
              try {
                conflictHandler({ action, serverError: body.error, attendance: body.attendance, visit: body.visit });
              } catch (handlerError) {
                console.error('Conflict handler threw:', handlerError.message);
              }
            }
          } else {
            // Genuine client error (4xx) — retry a bounded number of times in
            // case it was transient, then give up so a bad record can't wedge the queue forever.
            const retryCount = (action.retryCount || 0) + 1;
            if (retryCount <= MAX_RETRIES) {
              // Exponential backoff (30s, 60s, 120s, ... capped at 30min) —
              // otherwise this gets retried on every single flush (every
              // connectivity edge and every periodic sweep) instead of
              // giving a transient failure a moment to clear.
              const delayMs = Math.min(BASE_RETRY_DELAY_MS * 2 ** (retryCount - 1), MAX_RETRY_DELAY_MS);
              remaining.push({ ...action, retryCount, nextRetryAt: Date.now() + delayMs });
            } else {
              console.error(`Discarding queued action ${action.id} after ${MAX_RETRIES} failed retries:`, error.message);
              // Otherwise this vanishes with only a console log nobody sees —
              // report it so a manager gets an actual notification instead.
              // Best-effort: if this call itself fails, the discard still
              // proceeds (nothing further to retry it against).
              api.post('/sync-failures', { method: action.method, url: action.url, error: error.message })
                .catch(() => {});
              // Anything still queued that depends on this action's localId
              // can never resolve now — see blockedOnFailedDependency above.
              if (action.localId) failedLocalIds.add(action.localId);
            }
          }
          await persistRemaining();
        }
      }
    } catch (error) {
      console.error('Error during flush queue:', error);
    } finally {
      flushInFlight = null;
    }
  })();

  return flushInFlight;
};

/**
 * Start listening for connectivity changes and auto-flush the queue whenever
 * the device transitions from offline to online. Also does an initial flush
 * attempt immediately (covers the case where the queue has items from a
 * previous session and the app is already online at launch).
 * @returns {() => void} unsubscribe function
 */
export const startAutoSync = () => {
  if (unsubscribeNetInfo) return unsubscribeNetInfo;

  let wasOffline = false;

  unsubscribeNetInfo = NetInfo.addEventListener((state) => {
    const isOnline = Boolean(state.isConnected && state.isInternetReachable !== false);

    if (isOnline && wasOffline) {
      flushQueue();
    }
    wasOffline = !isOnline;
  });

  // Also sweep periodically regardless of connectivity edges — NetInfo can
  // report "online" while requests keep failing (flaky wifi, a server
  // blip), and without this the queue would only get another chance on the
  // next full offline->online transition, which may not come for a while.
  // flushQueue() itself is cheap to call when there's nothing due (empty
  // queue, or every item still backed off) — it just re-persists a same-size
  // list — so a 1-minute interval is safe to leave running for the session.
  periodicRetryTimer = setInterval(() => flushQueue(), PERIODIC_RETRY_MS);

  // Kick off an initial attempt in case there's already a backlog.
  flushQueue();

  return unsubscribeNetInfo;
};

export const stopAutoSync = () => {
  if (unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
  }
  if (periodicRetryTimer) {
    clearInterval(periodicRetryTimer);
    periodicRetryTimer = null;
  }
};
