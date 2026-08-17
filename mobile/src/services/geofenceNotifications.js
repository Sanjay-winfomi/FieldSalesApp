import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { captureException } from './crashReporter';

/**
 * geofenceNotifications.js — pushes a local device notification for dealer
 * geofence events instead of a blocking Alert.alert, so a rep mid-visit
 * isn't interrupted by a modal they must dismiss before doing anything else.
 */
export async function configureGeofenceNotificationChannel() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('geofence-alerts', {
      name: 'Dealer visit alerts',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

export async function sendGeofenceNotification({ title, body }) {
  // Callers (App.js, geofenceTask.js, assignedDealerGeofence.js) don't
  // await/catch this — without a try/catch here, a scheduling failure (e.g.
  // notification permission revoked, missing channel on some OEM skin) would
  // silently drop a safety-relevant "leaving dealer premises"/"time to log
  // out" alert with zero log output and zero telemetry.
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(), channelId: 'geofence-alerts' },
    });
  } catch (error) {
    console.error('Failed to schedule geofence notification:', error);
    captureException(error, { area: 'geofence-notification', title });
  }
}

export async function configureArrivalNotificationChannel() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('dealer-arrivals', {
      name: 'Dealer arrival alerts',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

/**
 * Fired by assignedDealerGeofence.js's background task the moment the OS
 * detects the rep has entered an assigned-but-not-yet-checked-in dealer's
 * radius — works even if the app is backgrounded/closed, unlike
 * DealerNavigationScreen's own foreground-only arrival poll. The `data`
 * payload carries everything App.js needs to jump straight into the
 * existing (unmodified) Check-In flow when the notification is tapped,
 * without having to look the assignment up again.
 * @param {object} assignment
 * @param {number} assignment.assignmentId
 * @param {number} assignment.dealerId
 * @param {string} assignment.dealerName
 * @param {string} [assignment.dealerAddress]
 * @param {number} assignment.dealerLat
 * @param {number} assignment.dealerLng
 * @param {number} [assignment.radiusMeters]
 */
export async function sendArrivalNotification(assignment) {
  // Same reasoning as sendGeofenceNotification above — callers don't
  // await/catch this either.
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `You've arrived at ${assignment.dealerName}`,
        body: 'Tap to log in',
        data: { type: 'assignment_arrival', ...assignment },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(), channelId: 'dealer-arrivals' },
    });
  } catch (error) {
    console.error('Failed to schedule arrival notification:', error);
    captureException(error, { area: 'arrival-notification', dealerId: assignment.dealerId });
  }
}
