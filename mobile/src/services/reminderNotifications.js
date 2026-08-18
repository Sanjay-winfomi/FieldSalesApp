import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

/**
 * reminderNotifications.js — schedules the two local device notifications
 * ("N days left") for a dealer reminder: one the day before the reminder
 * date, one on the day itself, both at 7:00 AM local time. These are
 * scheduled entirely on-device (no FCM/backend push involved) — the
 * reminder_date is fixed at creation time, so there's nothing a server
 * needs to trigger later.
 */
const NOTIFICATION_HOUR = 7;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function configureNotificationHandler() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('reminders', {
      name: 'Dealer reminders',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  await Notifications.requestPermissionsAsync();
}

// reminderDate is a 'YYYY-MM-DD' string (as returned by the backend). Parsed
// as local-time components (not Date.parse, which treats bare YYYY-MM-DD as
// UTC midnight) so the 7 AM trigger lands on the intended local calendar day.
function atSevenAM(dateStr, dayOffset) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day + dayOffset, NOTIFICATION_HOUR, 0, 0, 0);
}

/**
 * Schedules the day-before and day-of notifications. Skips any trigger time
 * that has already passed (e.g. the reminder is created on its own day after
 * 7 AM, or the day before has already elapsed) — this is what guarantees a
 * reminder set for Aug 3 never fires on Aug 1 or after Aug 3.
 */
export async function scheduleReminderNotifications({ dealerName, reminderDate }) {
  const now = new Date();
  const triggers = [
    { date: atSevenAM(reminderDate, -1), daysLeft: 1 },
    { date: atSevenAM(reminderDate, 0), daysLeft: 0 },
  ];

  const [notifIdDayBefore, notifIdDayOf] = await Promise.all(
    triggers.map(({ date, daysLeft }) => {
      if (date <= now) return Promise.resolve(null);
      return Notifications.scheduleNotificationAsync({
        content: {
          title: `Follow up: ${dealerName}`,
          body: daysLeft === 0
            ? `Your reminder for ${dealerName} is due today.`
            : `Your reminder for ${dealerName} is due tomorrow.`,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: 'reminders' },
      });
    })
  );

  return { notifIdDayBefore, notifIdDayOf };
}

export async function cancelReminderNotifications({ notifIdDayBefore, notifIdDayOf }) {
  await Promise.all(
    [notifIdDayBefore, notifIdDayOf]
      .filter(Boolean)
      .map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => {}))
  );
}
