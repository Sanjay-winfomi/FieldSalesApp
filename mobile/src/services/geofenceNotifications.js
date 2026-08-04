import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

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
  await Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(), channelId: 'geofence-alerts' },
  });
}
