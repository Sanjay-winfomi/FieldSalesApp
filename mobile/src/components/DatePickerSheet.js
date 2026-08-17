import React, { useState, useEffect } from 'react';
import { Modal, View, StyleSheet } from 'react-native';
import { Calendar } from 'react-native-calendars';
import PrimaryButton from './buttons/PrimaryButton';
import { colors, typography, spacing, radius } from '../theme';

function toDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Inline calendar-grid date picker (react-native-calendars), themed to match
 * the app instead of the OS's native date dialog — see FollowupRequestModal
 * for why the native @react-native-community/datetimepicker Android dialog
 * (unstyled system Dialog) was dropped in favor of this. Shared by every
 * screen that needs a date picker so they all look identical.
 */
export default function DatePickerSheet({ visible, initialDate, minDate, onConfirm, onCancel }) {
  const [pendingDate, setPendingDate] = useState(initialDate || new Date());

  useEffect(() => {
    if (visible) setPendingDate(initialDate || new Date());
  }, [visible, initialDate]);

  const handleDayPress = (day) => {
    // Parsed as local midnight (no trailing Z) — day.dateString is a plain
    // 'YYYY-MM-DD' with no timezone of its own, and parsing it as UTC would
    // shift the selected day by one in any timezone behind UTC.
    setPendingDate(new Date(`${day.dateString}T00:00:00`));
  };

  return (
    // A real Modal, not a plain absolutely-positioned View — without this,
    // the Android hardware back button has nothing to intercept and falls
    // through to whatever's underneath (e.g. popping the whole screen, as
    // ReminderEditorScreen renders this with no Modal of its own around it).
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Calendar
            current={toDateString(pendingDate)}
            minDate={minDate ? toDateString(minDate) : undefined}
            markedDates={{
              [toDateString(pendingDate)]: { selected: true, selectedColor: colors.primary },
            }}
            onDayPress={handleDayPress}
            theme={{
              backgroundColor: colors.card,
              calendarBackground: colors.card,
              textSectionTitleColor: colors.textSecondary,
              selectedDayBackgroundColor: colors.primary,
              selectedDayTextColor: colors.textInverse,
              todayTextColor: colors.primary,
              dayTextColor: colors.text,
              textDisabledColor: colors.disabledText,
              monthTextColor: colors.text,
              arrowColor: colors.primary,
              textDayFontFamily: typography.body.fontFamily,
              textMonthFontFamily: typography.cardTitle.fontFamily,
              textDayHeaderFontFamily: typography.caption.fontFamily,
            }}
          />
          <PrimaryButton title="Done" onPress={() => onConfirm(pendingDate)} style={styles.doneButton} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  doneButton: { marginTop: spacing.md },
});
