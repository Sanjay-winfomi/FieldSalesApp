import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { api } from './api';

const QUEUE_KEY = '@offline_action_queue';
const MAX_RETRIES = 8;

let unsubscribeNetInfo = null;
let flushInFlight = null;

// Called once (by App.js) whenever a queued action turns out to conflict
// with state the server already has (e.g. a retried/offline check-out racing
// one that already succeeded) — so the app can refresh from the server
// instead of the UI silently drifting out of sync with what was dropped.
let conflictHandler = null;
export const setConflictHandler = (fn) => {
  conflictHandler = fn;
};

/**
 * Enqueue an API request to be processed later.
 * @param {string} method - e.g., 'post', 'put'
 * @param {string} url - endpoint, e.g., '/visits/check-in'
 * @param {object} data - payload
 * @param {object} [opts]
 * @param {string} [opts.localId] - temp id this action's response should resolve
 *   (e.g. the 'offline-<ts>' id assigned to an offline-created attendance/visit).
 *   Later queued actions referencing that same temp id get rewritten to the
 *   real server id once this action syncs successfully.
 * @param {'attendance'|'visit'} [opts.resolves] - which id field the response maps to.
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
 * Discard the queue outright. Used on logout — without this, any actions
 * queued by the current user but not yet synced would sit until the next
 * login on this device and then flush under whichever employee logs in
 * next, misattributing the data.
 */
export const clearQueue = async () => {
  await AsyncStorage.removeItem(QUEUE_KEY);
};

// Fields that may hold a temp 'offline-...' id needing rewrite before send.
const ID_FIELDS = ['attendance_id', 'visit_id'];

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
      // Actions not yet processed this pass — persisted to storage after
      // every single action settles (not just once at the end), so that if
      // the app is killed mid-flush, an already-synced action can't still be
      // sitting in the persisted queue and get resubmitted (duplicate
      // check-in/check-out records) on the next flush attempt.
      let remaining = [...queue];
      const persistRemaining = () => AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));

      for (const action of queue) {
        // This action is being attempted now — drop it from `remaining`
        // up front; failure paths below push it back on if it should still
        // be retried.
        remaining = remaining.filter((a) => a.id !== action.id);

        // Rewrite any temp id references using ids resolved earlier in this pass.
        const data = { ...action.data };
        let blockedOnDependency = false;

        for (const field of ID_FIELDS) {
          const val = data[field];
          if (typeof val === 'string' && val.startsWith('offline-')) {
            if (idMap[val]) {
              data[field] = idMap[val];
            } else {
              blockedOnDependency = true;
            }
          }
        }

        if (blockedOnDependency) {
          // The action this depends on hasn't synced yet (or failed) —
          // keep it queued and try again on the next flush.
          remaining.push(action);
          await persistRemaining();
          continue;
        }

        try {
          const response = await api.request({ method: action.method, url: action.url, data });

          if (action.localId && action.resolves === 'attendance') {
            idMap[action.localId] = response.data.attendance?.id;
          } else if (action.localId && action.resolves === 'visit') {
            idMap[action.localId] = response.data.visit?.id;
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
          } else if (error.response?.status === 409) {
            // Conflict with state the server already has (duplicate day
            // check-in, a check-out/check-in racing one that already synced,
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
              remaining.push({ ...action, retryCount });
            } else {
              console.error(`Discarding queued action ${action.id} after ${MAX_RETRIES} failed retries:`, error.message);
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

  // Kick off an initial attempt in case there's already a backlog.
  flushQueue();

  return unsubscribeNetInfo;
};

export const stopAutoSync = () => {
  if (unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
  }
};
