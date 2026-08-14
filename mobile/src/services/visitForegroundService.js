import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { captureException } from './crashReporter';

/**
 * visitForegroundService.js — holds a real Android foreground service open
 * for the duration of an open dealer visit.
 *
 * geofenceTask.js's startDealerGeofence deliberately avoided a foreground
 * service (see its own comment) to skip the persistent notification Android
 * requires for one. That was the right call for battery/UX on its own, but
 * it has a real cost: with no foreground service, this app's process
 * priority (oom_adj) sits in the same range as any other backgrounded app —
 * exactly what OEM background-killers (MIUI's LockScreenClean/SwipeUpClean,
 * confirmed via adb logcat) target. A killed process doesn't just lose the
 * geofence's live JS context (the OS geofence itself survives — Google Play
 * Services re-launches this app headlessly on a crossing regardless); what
 * the rep actually experiences is the whole app cold-starting from Splash
 * the next time they reopen it, since MIUI didn't just background it, it
 * killed it outright.
 *
 * A real foreground service is the standard Android-documented way to keep
 * a process's priority low enough that OEM cleaners generally leave it
 * alone — at the cost of a persistent, user-visible notification for as
 * long as it runs. Scoped tightly to only the open-visit window (started/
 * stopped alongside startDealerGeofence/stopDealerGeofence in App.js) so
 * that cost is paid only when it matters, not for the whole work day.
 *
 * The location stream this registers is intentionally unused — actual
 * radius monitoring already happens via visitMonitor.js (foreground poll)
 * and geofenceTask.js (OS geofence Enter/Exit). This task's only job is to
 * be the reason Android grants a foreground service, and the priority boost
 * that comes with it.
 */
export const VISIT_FOREGROUND_LOCATION_TASK = 'visit-foreground-location-task';

TaskManager.defineTask(VISIT_FOREGROUND_LOCATION_TASK, ({ error }) => {
  if (error) {
    console.warn('Visit foreground location task error:', error.message);
    captureException(error, { area: 'visit-foreground-location-task' });
  }
  // No-op by design — see module comment above.
});

/**
 * @param {number|string} visitId - only used to no-op safely if there's
 *   nothing open; the location stream itself isn't tied to visitId.
 */
export async function startVisitForegroundService(visitId) {
  if (!visitId) return;
  try {
    const { status } = await Location.getBackgroundPermissionsAsync();
    if (status !== 'granted') return;

    const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(VISIT_FOREGROUND_LOCATION_TASK).catch(() => false);
    if (alreadyStarted) return;

    await Location.startLocationUpdatesAsync(VISIT_FOREGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      // Sparse on purpose — this stream isn't consumed for anything, so
      // there's no reason to spend battery sampling it often. The
      // foreground service (and the notification/priority it requires)
      // stays up regardless of how rarely a new location actually arrives.
      timeInterval: 5 * 60 * 1000,
      distanceInterval: 200,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Tracking your location',
        notificationBody: 'Winfomi is tracking your location for dealer visit alerts while this visit is open.',
        notificationColor: '#1B7F5A',
      },
    });
  } catch (error) {
    console.warn('Failed to start visit foreground service:', error.message);
    captureException(error, { area: 'visit-foreground-service-start' });
  }
}

export async function stopVisitForegroundService() {
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(VISIT_FOREGROUND_LOCATION_TASK).catch(() => false);
    if (started) {
      await Location.stopLocationUpdatesAsync(VISIT_FOREGROUND_LOCATION_TASK);
    }
  } catch (error) {
    console.warn('Failed to stop visit foreground service:', error.message);
    captureException(error, { area: 'visit-foreground-service-stop' });
  }
}
