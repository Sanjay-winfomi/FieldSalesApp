import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sendArrivalNotification } from './geofenceNotifications';

/**
 * assignedDealerGeofence.js — proactive background arrival detection for
 * TODAY's manager-assigned dealers, not just the one visit currently open.
 *
 * geofenceTask.js already covers "watch the dealer of an OPEN visit for
 * exit/still-inside" (post-check-in). This is the pre-check-in counterpart:
 * without it, arrival was only ever detected by DealerNavigationScreen's own
 * 15s poll — which only runs while that screen happens to be open. A
 * separate task (rather than folding these regions into geofenceTask.js's
 * existing task) keeps the two concerns fully independent — Location's
 * startGeofencingAsync REPLACES a task's whole region set on every call, so
 * sharing one task would mean every check-in/checkout had to carefully
 * re-merge both region lists instead of two tasks each owning their own.
 *
 * The background task runs headless (no React tree, possibly no app UI at
 * all) — it can't read live component state, so the assignment details it
 * needs to build the notification are cached to AsyncStorage by
 * startAssignedDealersGeofence() and read back here on each Enter event.
 */
export const ASSIGNED_DEALER_ARRIVAL_TASK = 'assigned-dealer-arrival-task';
const CACHE_KEY = '@assigned_dealers_geofence_cache';

TaskManager.defineTask(ASSIGNED_DEALER_ARRIVAL_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('Assigned dealer arrival task error:', error.message);
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

    await sendArrivalNotification(assignment);
  } catch (err) {
    console.warn('Assigned dealer arrival task failed:', err.message);
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
}
