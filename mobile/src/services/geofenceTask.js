import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { api } from './api';
import { enqueueAction } from './syncManager';

/**
 * geofenceTask.js — background radius monitoring for an open dealer visit.
 *
 * visitMonitor.js only samples location while the app is foregrounded, which
 * leaves a manager-facing status stuck at whatever it was the last time the
 * rep had the app open — often the login moment, for the entire visit,
 * since reps log in and pocket the phone. Geofencing is the OS primitive
 * built for exactly this: register a circular region around the dealer and
 * the OS wakes this task on ENTER/EXIT even if the app is fully closed, with
 * no persistent notification required (unlike continuous background location
 * updates, which Android forces a foreground-service notification for).
 *
 * The task must be defined at module scope, and this module must be imported
 * unconditionally at app startup (see index.js) — TaskManager needs the task
 * name registered before the OS can invoke it in a headless relaunch.
 */
export const DEALER_GEOFENCE_TASK = 'dealer-geofence-task';

TaskManager.defineTask(DEALER_GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('Dealer geofence task error:', error.message);
    return;
  }

  const { eventType, region } = data;
  if (eventType !== Location.GeofencingEventType.Enter && eventType !== Location.GeofencingEventType.Exit) {
    return;
  }

  const visitId = region?.identifier;
  if (!visitId) return;

  try {
    const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const payload = { lat: location.coords.latitude, lng: location.coords.longitude };
    try {
      await api.post(`/visits/${visitId}/location-check`, payload);
    } catch (postError) {
      if (!postError.response) {
        // Offline while backgrounded — queue like any other action, flushed
        // by the normal sync manager once connectivity returns.
        await enqueueAction('post', `/visits/${visitId}/location-check`, payload);
      } else {
        console.warn('Background geofence location-check failed:', postError.message);
      }
    }
  } catch (locationError) {
    // Best-effort — a missed background reading isn't worth surfacing to the
    // rep, and the next foreground open or geofence crossing will retry.
    console.warn('Background geofence GPS read failed:', locationError.message);
  }
});

/**
 * Starts monitoring a single circular region around the dealer for this
 * visit. Requires background location permission — if it isn't granted this
 * silently no-ops and the visit falls back to foreground-only checks.
 * @param {{id: number|string}} visit
 * @param {{latitude: number|string, longitude: number|string, radius_meters?: number}} dealer
 */
export async function startDealerGeofence(visit, dealer) {
  if (!visit?.id || dealer?.latitude == null || dealer?.longitude == null) return;

  const { status } = await Location.getBackgroundPermissionsAsync();
  if (status !== 'granted') return;

  await stopDealerGeofence();

  await Location.startGeofencingAsync(DEALER_GEOFENCE_TASK, [
    {
      identifier: String(visit.id),
      latitude: parseFloat(dealer.latitude),
      longitude: parseFloat(dealer.longitude),
      radius: dealer.radius_meters ?? 200,
      notifyOnEnter: true,
      notifyOnExit: true,
    },
  ]);
}

export async function stopDealerGeofence() {
  const started = await TaskManager.isTaskRegisteredAsync(DEALER_GEOFENCE_TASK);
  if (started) {
    await Location.stopGeofencingAsync(DEALER_GEOFENCE_TASK);
  }
}
