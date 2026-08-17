import React, { useState } from 'react';
import { StyleSheet, Text, View, TextInput, Pressable, Platform, KeyboardAvoidingView } from 'react-native';
import { ChevronDown, CalendarDays } from 'lucide-react-native';
import { api } from '../src/services/api';
import { enqueueAction, isNetworkError } from '../src/services/syncManager';
import { scheduleReminderNotifications } from '../src/services/reminderNotifications';
import { showAlert } from '../src/services/themedAlert';
import { getErrorMessage } from '../src/services/apiError';
import { AppHeader, PrimaryButton, DealerPickerModal, DatePickerSheet, FadeSlideIn } from '../src/components';
import { colors, typography, spacing, radius, serifFontFamily } from '../src/theme';

const MIN_NOTE_LENGTH = 20;

function toDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * New reminder form — pick a dealer, a date (today or later), and write a
 * 20-character-minimum note. On save, the reminder is persisted to the
 * backend and two local device notifications (day-before + day-of, 7 AM)
 * are scheduled via reminderNotifications.js.
 */
export default function ReminderEditorScreen({ navigation }) {
  const [dealer, setDealer] = useState(null);
  const [date, setDate] = useState(null);
  const [note, setNote] = useState('');
  const [showDealerPicker, setShowDealerPicker] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pendingDate, setPendingDate] = useState(new Date());
  const [saving, setSaving] = useState(false);

  const trimmedLength = note.trim().length;
  const canSave = !!dealer && !!date && trimmedLength >= MIN_NOTE_LENGTH && !saving;

  const openDatePicker = () => {
    setPendingDate(date || new Date());
    setShowDatePicker(true);
  };

  const confirmPickedDate = (picked) => {
    setDate(picked);
    setShowDatePicker(false);
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    const reminderDate = toDateString(date);
    try {
      const res = await api.post('/reminders', {
        dealer_id: dealer.id,
        reminder_date: reminderDate,
        note,
      });
      const reminder = res.data.reminder;

      const { notifIdDayBefore, notifIdDayOf } = await scheduleReminderNotifications({
        dealerName: dealer.name,
        reminderDate,
      });

      if (notifIdDayBefore || notifIdDayOf) {
        // Queue instead of just logging on failure — without this, an
        // online request that fails for any reason other than a dropped
        // connection (a transient 5xx, a timeout) leaves these two
        // already-scheduled local notifications with no id recorded
        // server-side, so RemindersScreen's delete flow can never cancel
        // them and they fire after the reminder itself is deleted.
        await api.patch(`/reminders/${reminder.id}/notifications`, {
          notif_id_day_before: notifIdDayBefore,
          notif_id_day_of: notifIdDayOf,
        }).catch(async (err) => {
          console.error('Failed to persist notification ids, queuing for retry:', err);
          await enqueueAction('patch', `/reminders/${reminder.id}/notifications`, {
            notif_id_day_before: notifIdDayBefore,
            notif_id_day_of: notifIdDayOf,
          });
        });
      }

      navigation.goBack();
    } catch (err) {
      if (isNetworkError(err)) {
        // Offline — queue the create so the note/dealer/date the user
        // entered isn't lost, and still schedule the local device
        // notifications now (they don't need a server id yet). The create
        // gets a localId so the queued notifications PATCH below can be
        // rewritten to the real reminder id once the create itself syncs
        // (see syncManager.js's URL-id rewrite) — without this, the
        // notification ids are never persisted server-side, so deleting
        // this reminder later can never cancel the two already-scheduled
        // OS notifications.
        const localId = 'offline-' + Date.now();
        await enqueueAction('post', '/reminders', { dealer_id: dealer.id, reminder_date: reminderDate, note }, { localId, resolves: 'reminder' });
        const { notifIdDayBefore, notifIdDayOf } = await scheduleReminderNotifications({ dealerName: dealer.name, reminderDate });
        if (notifIdDayBefore || notifIdDayOf) {
          await enqueueAction('patch', `/reminders/${localId}/notifications`, {
            notif_id_day_before: notifIdDayBefore,
            notif_id_day_of: notifIdDayOf,
          });
        }
        showAlert('Offline Mode', 'Reminder saved locally and will sync when online.');
        navigation.goBack();
        return;
      }
      const serverError = err.response?.data?.error;
      if (serverError === 'note_too_short') {
        showAlert('Note too short', `Reminders need at least ${MIN_NOTE_LENGTH} characters.`);
      } else if (serverError === 'reminder_date_in_past') {
        showAlert('Invalid date', 'The reminder date cannot be in the past.');
      } else {
        console.error('Failed to save reminder:', err);
        showAlert('Error', getErrorMessage(err, 'Could not save this reminder. Please try again.'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AppHeader title="New reminder" onBack={() => navigation.goBack()} />

      <FadeSlideIn style={styles.form}>
        <Text style={styles.label}>Dealer</Text>
        <Pressable
          style={styles.selector}
          onPress={() => setShowDealerPicker(true)}
          accessibilityRole="button"
          accessibilityLabel="Select dealer"
        >
          <Text style={[styles.selectorText, !dealer && styles.placeholderText]} numberOfLines={1}>
            {dealer ? dealer.name : 'Select a dealer'}
          </Text>
          <ChevronDown size={18} color={colors.textMuted} />
        </Pressable>

        <Text style={[styles.label, { marginTop: spacing.lg }]}>Date</Text>
        <Pressable
          style={styles.selector}
          onPress={openDatePicker}
          accessibilityRole="button"
          accessibilityLabel="Select date"
        >
          <Text style={[styles.selectorText, !date && styles.placeholderText]}>
            {date ? formatDisplayDate(date) : 'Select a date'}
          </Text>
          <CalendarDays size={18} color={colors.textMuted} />
        </Pressable>

        <Text style={[styles.label, { marginTop: spacing.lg }]}>Note</Text>
        <TextInput
          style={styles.noteInput}
          multiline
          value={note}
          onChangeText={setNote}
          placeholder="What do you need to follow up on?"
          placeholderTextColor={colors.textMuted}
          textAlignVertical="top"
        />
        <Text style={[styles.counter, trimmedLength < MIN_NOTE_LENGTH && styles.counterShort]}>
          {trimmedLength} / {MIN_NOTE_LENGTH} characters minimum
        </Text>
      </FadeSlideIn>

      <FadeSlideIn delay={60} style={styles.footer}>
        <PrimaryButton title="Save reminder" onPress={handleSave} disabled={!canSave} loading={saving} />
      </FadeSlideIn>

      <DealerPickerModal
        visible={showDealerPicker}
        onClose={() => setShowDealerPicker(false)}
        onSelect={(selected) => {
          setDealer(selected);
          setShowDealerPicker(false);
        }}
      />

      <DatePickerSheet
        visible={showDatePicker}
        initialDate={pendingDate}
        minDate={new Date()}
        onConfirm={confirmPickedDate}
        onCancel={() => setShowDatePicker(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  form: { flex: 1, padding: spacing.screenHorizontal },
  label: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 52,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.input,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
  },
  selectorText: { ...typography.body, color: colors.text, flex: 1, marginRight: spacing.sm },
  placeholderText: { color: colors.textMuted },
  noteInput: {
    minHeight: 140,
    fontFamily: serifFontFamily,
    fontSize: 17,
    lineHeight: 24,
    color: colors.text,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.input,
    backgroundColor: colors.card,
    padding: spacing.md,
  },
  counter: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
    textAlign: 'right',
  },
  counterShort: {
    color: colors.dangerDark,
    fontWeight: '600',
  },
  footer: {
    padding: spacing.screenHorizontal,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
});
