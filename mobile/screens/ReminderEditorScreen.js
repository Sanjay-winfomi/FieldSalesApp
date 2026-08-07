import React, { useState } from 'react';
import { StyleSheet, Text, View, TextInput, Pressable, Platform, Modal, KeyboardAvoidingView } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { ChevronDown, CalendarDays } from 'lucide-react-native';
import { api } from '../src/services/api';
import { enqueueAction, isNetworkError } from '../src/services/syncManager';
import { scheduleReminderNotifications } from '../src/services/reminderNotifications';
import { showAlert } from '../src/services/themedAlert';
import { AppHeader, PrimaryButton, DealerPickerModal } from '../src/components';
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

  const handleAndroidDateChange = (event, selected) => {
    setShowDatePicker(false);
    if (event.type === 'set' && selected) setDate(selected);
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
        await api.patch(`/reminders/${reminder.id}/notifications`, {
          notif_id_day_before: notifIdDayBefore,
          notif_id_day_of: notifIdDayOf,
        }).catch((err) => console.error('Failed to persist notification ids:', err));
      }

      navigation.goBack();
    } catch (err) {
      if (isNetworkError(err)) {
        // Offline — queue the create so the note/dealer/date the user
        // entered isn't lost. Still schedule the local device notifications
        // now (they don't need a server id), but there's no reminder id yet
        // to attach them to server-side — that PATCH is skipped; the
        // notifications will just fire without a synced notif_id_* on the
        // record until the next time this reminder is edited, if ever.
        await enqueueAction('post', '/reminders', { dealer_id: dealer.id, reminder_date: reminderDate, note });
        await scheduleReminderNotifications({ dealerName: dealer.name, reminderDate });
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
        showAlert('Error', 'Could not save this reminder. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AppHeader title="New reminder" onBack={() => navigation.goBack()} />

      <View style={styles.form}>
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
      </View>

      <View style={styles.footer}>
        <PrimaryButton title="Save reminder" onPress={handleSave} disabled={!canSave} loading={saving} />
      </View>

      <DealerPickerModal
        visible={showDealerPicker}
        onClose={() => setShowDealerPicker(false)}
        onSelect={(selected) => {
          setDealer(selected);
          setShowDealerPicker(false);
        }}
      />

      {showDatePicker && Platform.OS === 'android' && (
        <DateTimePicker
          value={pendingDate}
          mode="date"
          display="default"
          minimumDate={new Date()}
          onChange={handleAndroidDateChange}
        />
      )}

      {Platform.OS === 'ios' && (
        <Modal visible={showDatePicker} transparent animationType="fade" onRequestClose={() => setShowDatePicker(false)}>
          <Pressable style={styles.iosPickerBackdrop} onPress={() => setShowDatePicker(false)}>
            <Pressable style={styles.iosPickerSheet} onPress={() => {}}>
              <DateTimePicker
                value={pendingDate}
                mode="date"
                display="spinner"
                minimumDate={new Date()}
                onChange={(event, selected) => selected && setPendingDate(selected)}
              />
              <PrimaryButton
                title="Done"
                onPress={() => {
                  setDate(pendingDate);
                  setShowDatePicker(false);
                }}
              />
            </Pressable>
          </Pressable>
        </Modal>
      )}
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
  iosPickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  iosPickerSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.input,
    borderTopRightRadius: radius.input,
    padding: spacing.screenHorizontal,
  },
});
