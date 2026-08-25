import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sendArrivalNotification } from './geofenceNotifications';
import { haversineMeters } from './location';
import { captureException } from './crashReporter';

/**
 * assignedDealerGeofence.js — proactive background arrival detection for
 * TODAY's manager-assigned dealers, not just the one visit currently open.
 *
 * geofenceTask.js already covers "watch the dealer of an OPEN visit for
 * exit/still-inside" (post-check-in). This is the pre-check-in counterpart —
 * arrival at a dealer the rep hasn't checked into yet, detected regardless
 * of whether the app is even open. A separate task (rather than folding
 * these regions into geofenceTask.js's
 * existing task) keeps the two concerns fully independent — Location's
 * startGeofencingAsync REPLACES a task's whole region set on every call, so
 * sharing one task would mean every check-in/checkout had to carefully
 * re-merge both region lists instead of two tasks each owning their own.
 *
 * The background task runs headless (no React tree, possibly no app UI at
 * all) — it can't read live component state, so the assignment details it
 * needs to build the notification are cached to AsyncStorage by
 * startAssignedDealersGeofence() and read back here on each Enter event.
 *
 * The OS geofence alone is NOT enough on its own: Android/iOS deliberately
 * throttle background region-monitoring to save battery, so "arrived" can
 * take anywhere from ~30s to several minutes to actually fire — the rep
 * spends the whole drive in the native Maps app, so there's no foreground
 * poll running to catch it sooner. checkArrivalNow() is the
 * fallback for that gap: App.js calls it the instant the app returns to the
 * foreground, doing one immediate GPS check against every still-pending
 * dealer instead of passively waiting on the OS to get around to it.
 */
export const ASSIGNED_DEALER_ARRIVAL_TASK = 'assigned-dealer-arrival-task';
const CACHE_KEY = '@assigned_dealers_geofence_cache';
// Assignment regionIds already notified — shared between the background
// task and checkArrivalNow() so whichever fires first "wins" and the rep
// isn't notified twice for the same arrival.
const NOTIFIED_KEY = '@assigned_dealers_geofence_notified';

async function getNotifiedIds() {
  const json = await AsyncStorage.getItem(NOTIFIED_KEY);
  return new Set(json ? JSON.parse(json) : []);
}

async function markNotified(regionId) {
  const ids = await getNotifiedIds();
  ids.add(regionId);
  await AsyncStorage.setItem(NOTIFIED_KEY, JSON.stringify([...ids]));
}

TaskManager.defineTask(ASSIGNED_DEALER_ARRIVAL_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('Assigned dealer arrival task error:', error.message);
    captureException(error, { area: 'assigned-dealer-arrival-task' });
    return;
  }

  // Only entering matters here — exiting a dealer the rep never checked
  // into isn't a meaningful event worth a notification.
  if (data?.eventType !== Location.GeofencingEventType.Enter) return;

  const regionId = data.region?.identifier;
  if (!regionId) return;

  try {
    const cacheJson = await AsyncStorage.getItem(CACHE_KEY);
    const cached = cacheJson ? JSON.parse(cacheJson) : [];
    const assignment = cached.find((a) => a.regionId === regionId);
    // A stale region from a cache that's since been cleared/replaced (e.g.
    // the rep already checked in and startAssignedDealersGeofence dropped
    // it) — the OS can still deliver one last Enter event for the old
    // region right as it's being torn down.
    if (!assignment) return;

    const notified = await getNotifiedIds();
    if (notified.has(regionId)) return; // checkArrivalNow() already caught this one

    await sendArrivalNotification(assignment);
    await markNotified(regionId);
  } catch (err) {
    console.warn('Assigned dealer arrival task failed:', err.message);
    captureException(err, { area: 'assigned-dealer-arrival-task' });
  }
});

/**
 * Registers one geofence region per pending assigned dealer (anything not
 * yet completed/cancelled) so arrival is detected by the OS itself. Safe to
 * call repeatedly — each call replaces the previously registered region set
 * with the current one, so call it again whenever the pending list changes
 * (a check-in, today's assignments loading/reloading, ...).
 * @param {Array<{id, dealer_id, dealer_name, dealer_address, dealer_lat, dealer_lng, radius_meters}>} assignments
 * @returns {Promise<boolean>} whether geofencing actually started (false if
 *   there was nothing to watch, or background location isn't granted)
 */
export async function startAssignedDealersGeofence(assignments) {
  const withCoords = (assignments || []).filter((a) => a.dealer_lat != null && a.dealer_lng != null);

  if (withCoords.length === 0) {
    await stopAssignedDealersGeofence();
    return false;
  }

  const { status } = await Location.getBackgroundPermissionsAsync();
  if (status !== 'granted') return false;

  const cache = withCoords.map((a) => ({
    regionId: `assignment-${a.id}`,
    assignmentId: a.id,
    dealerId: a.dealer_id,
    dealerName: a.dealer_name,
    dealerAddress: a.dealer_address,
    dealerLat: parseFloat(a.dealer_lat),
    dealerLng: parseFloat(a.dealer_lng),
    radiusMeters: a.radius_meters ?? 200,
  }));
  await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache));

  // Prune the notified-set down to only regions still pending — keeps it
  // from growing forever, while still remembering "already notified" for
  // anything that's still on today's list (so a re-registration triggered
  // by an unrelated status change elsewhere doesn't cause a duplicate ping).
  const currentRegionIds = new Set(cache.map((a) => a.regionId));
  const notified = await getNotifiedIds();
  const prunedNotified = [...notified].filter((id) => currentRegionIds.has(id));
  await AsyncStorage.setItem(NOTIFIED_KEY, JSON.stringify(prunedNotified));

  await Location.startGeofencingAsync(
    ASSIGNED_DEALER_ARRIVAL_TASK,
    cache.map((a) => ({
      identifier: a.regionId,
      latitude: a.dealerLat,
      longitude: a.dealerLng,
      radius: a.radiusMeters,
      notifyOnEnter: true,
      notifyOnExit: false,
    }))
  );
  return true;
}

export async function stopAssignedDealersGeofence() {
  const started = await TaskManager.isTaskRegisteredAsync(ASSIGNED_DEALER_ARRIVAL_TASK);
  if (started) {
    await Location.stopGeofencingAsync(ASSIGNED_DEALER_ARRIVAL_TASK);
  }
  await AsyncStorage.removeItem(CACHE_KEY);
  await AsyncStorage.removeItem(NOTIFIED_KEY);
}

/**
 * Read-only counterpart to checkArrivalNow, for driving UI (Home's "Dealer
 * login" card) instead of firing a push notification. Deliberately doesn't
 * consult or mutate the notified-set: checkArrivalNow is one-shot-per-
 * assignment by design (a push should only fire once), but a UI affordance
 * should keep showing for as long as the rep is actually standing inside
 * the radius, including after the notification for the same arrival has
 * already fired.
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{regionId, assignmentId, dealerId, dealerName, dealerAddress, dealerLat, dealerLng, radiusMeters}|null>}
 */
export async function findNearbyAssignedDealer(lat, lng) {
  if (lat == null || lng == null) return null;
  try {
    const cacheJson = await AsyncStorage.getItem(CACHE_KEY);
    const cached = cacheJson ? JSON.parse(cacheJson) : [];
    for (const assignment of cached) {
      const distanceMeters = haversineMeters(lat, lng, assignment.dealerLat, assignment.dealerLng);
      if (distanceMeters <= assignment.radiusMeters) return assignment;
    }
    return null;
  } catch (err) {
    console.warn('Nearby assigned dealer check failed:', err.message);
    captureException(err, { area: 'find-nearby-assigned-dealer' });
    return null;
  }
}

/**
 * Immediate foreground fallback for the OS geofence's inherent detection
 * lag — checks the given GPS reading against every still-pending assigned
 * dealer right now, instead of waiting for a background Enter event that
 * may not fire for minutes. Intended to be called from App.js's AppState
 * 'active' listener (app just came back to the foreground), which is
 * exactly the moment a rep who drove via the native Maps app would next be
 * looking at our app again.
 * @param {number} lat
 * @param {number} lng
 */
export async function checkArrivalNow(lat, lng) {
  if (lat == null || lng == null) return;
  try {
    const cacheJson = await AsyncStorage.getItem(CACHE_KEY);
    const cached = cacheJson ? JSON.parse(cacheJson) : [];
    if (cached.length === 0) return;

    const notified = await getNotifiedIds();

    for (const assignment of cached) {
      if (notified.has(assignment.regionId)) continue;
      const distanceMeters = haversineMeters(lat, lng, assignment.dealerLat, assignment.dealerLng);
      if (distanceMeters <= assignment.radiusMeters) {
        await sendArrivalNotification(assignment);
        await markNotified(assignment.regionId);
      }
    }
  } catch (err) {
    console.warn('Foreground arrival check failed:', err.message);
    captureException(err, { area: 'check-arrival-now' });
  }
}
