import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl, Pressable, Alert } from 'react-native';
import { Plus, BellRing, ChevronRight } from 'lucide-react-native';
import { api } from '../src/services/api';
import { enqueueAction, isNetworkError } from '../src/services/syncManager';
import { cancelReminderNotifications } from '../src/services/reminderNotifications';
import { AppHeader, LoadingCard, EmptyState, FadeSlideIn, Card } from '../src/components';
import { colors, typography, spacing, serifFontFamily } from '../src/theme';

// reminder_date is a plain 'YYYY-MM-DD' string from the backend — parsed as
// local-time components (not `new Date(iso)`, which treats a bare date as
// UTC midnight and can display a day early in timezones ahead of UTC).
function formatReminderDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function preview(note) {
  const firstLine = note.split('\n')[0];
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

export default function RemindersScreen({ navigation }) {
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const fetchReminders = useCallback(async () => {
    try {
      const res = await api.get('/reminders');
      setReminders(res.data.reminders || []);
      setError('');
    } catch (err) {
      console.error('Failed to fetch reminders:', err);
      setError('Could not load reminders.');
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setLoading(true);
      fetchReminders().finally(() => setLoading(false));
    });
    return unsubscribe;
  }, [navigation, fetchReminders]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchReminders();
    setRefreshing(false);
  };

  const handleDelete = (reminder) => {
    Alert.alert('Delete reminder', 'Are you sure you want to delete this reminder?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelReminderNotifications({
              notifIdDayBefore: reminder.notif_id_day_before,
              notifIdDayOf: reminder.notif_id_day_of,
            });
            await api.delete(`/reminders/${reminder.id}`);
            setReminders((prev) => prev.filter((r) => r.id !== reminder.id));
          } catch (err) {
            if (isNetworkError(err)) {
              await enqueueAction('delete', `/reminders/${reminder.id}`);
              setReminders((prev) => prev.filter((r) => r.id !== reminder.id));
              Alert.alert('Offline Mode', 'Delete saved locally and will sync when online.');
              return;
            }
            console.error('Failed to delete reminder:', err);
            Alert.alert('Error', 'Could not delete this reminder.');
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <AppHeader
        title="Reminders"
        onBack={() => navigation.goBack()}
        rightAction={
          <Pressable
            onPress={() => navigation.navigate('ReminderEditor', {})}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="New reminder"
          >
            <Plus size={22} color={colors.primary} />
          </Pressable>
        }
      />

      <ScrollView
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && <LoadingCard message="Loading reminders..." />}

        {!loading && !!error && (
          <EmptyState icon={<BellRing size={40} color={colors.textMuted} />} title="Something went wrong" subtitle={error} />
        )}

        {!loading && !error && reminders.length === 0 && (
          <EmptyState
            icon={<BellRing size={40} color={colors.textMuted} />}
            title="No reminders yet"
            subtitle='Tap "+" to set a reminder for a dealer.'
          />
        )}

        {!loading && reminders.map((reminder, index) => (
          <FadeSlideIn key={reminder.id} delay={Math.min(index, 6) * 25}>
            <Pressable onLongPress={() => handleDelete(reminder)}>
              <Card style={styles.reminderCard}>
                <View style={styles.reminderRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.dealerName} numberOfLines={1}>{reminder.dealer_name || `Dealer #${reminder.dealer_id}`}</Text>
                    <Text style={styles.notePreview} numberOfLines={2}>{preview(reminder.note)}</Text>
                    <Text style={styles.reminderDate}>{formatReminderDate(reminder.reminder_date)}</Text>
                  </View>
                  <ChevronRight size={18} color={colors.textMuted} />
                </View>
              </Card>
            </Pressable>
          </FadeSlideIn>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  listContainer: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  reminderCard: { marginBottom: spacing.cardGap },
  reminderRow: { flexDirection: 'row', alignItems: 'center' },
  dealerName: { ...typography.cardTitle, fontSize: 16, color: colors.text },
  notePreview: { ...typography.body, fontFamily: serifFontFamily, color: colors.textSecondary, marginTop: 2 },
  reminderDate: { ...typography.caption, color: colors.textMuted, marginTop: 4 },
});
