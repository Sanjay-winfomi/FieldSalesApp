import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, Pressable, Platform, Keyboard, Animated, StyleSheet } from 'react-native';
import { X, CalendarDays } from 'lucide-react-native';
import { api } from '../services/api';
import { enqueueAction, isNetworkError } from '../services/syncManager';
import { showAlert } from '../services/themedAlert';
import PrimaryButton from './buttons/PrimaryButton';
import DatePickerSheet from './DatePickerSheet';
import { colors, typography, spacing, radius } from '../theme';

const MIN_REASON_LENGTH = 10;

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
 * "Request follow-up" — for a dealer that couldn't be visited today, or one
 * that asked to be seen again on a specific day. Sends the manager a
 * notification with Approve/Reject actions; approving creates the actual
 * dealer_assignments row for the date requested here. This modal only ever
 * creates the *request* — it never assigns anything itself.
 */
export default function FollowupRequestModal({ visible, assignment, onClose, onSubmitted }) {
  const [date, setDate] = useState(null);
  const [reason, setReason] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pendingDate, setPendingDate] = useState(new Date());
  const [saving, setSaving] = useState(false);

  // RN's Modal renders in its own native window/Dialog on Android, which
  // KeyboardAvoidingView (and the OS's normal adjustResize/adjustPan
  // handling) doesn't reliably reach — so the sheet previously stayed
  // pinned to the true bottom of the screen and the keyboard just covered
  // the Reason field underneath it. Tracking the keyboard's own height and
  // pushing the sheet up by that amount works inside a Modal on both
  // platforms, instead of depending on avoidance behavior the Modal window
  // doesn't actually get.
  //
  // Driven through an Animated.Value (not a plain state-driven style) so the
  // sheet slides up/down in step with the keyboard's own animation instead
  // of snapping to the new margin the instant the event fires — that abrupt
  // snap, landing mid-way through the OS's own keyboard slide animation, is
  // what read as a "flicker" rather than a smooth keyboard-avoiding motion.
  const keyboardOffset = useRef(new Animated.Value(0)).current;

  // openDatePicker below registers a one-shot keyboardDidHide/keyboardWillHide
  // listener that isn't inside a useEffect (it's created imperatively, per
  // tap) — tracked here so handleClose/unmount can remove it if the modal
  // closes before the keyboard actually finishes hiding. Without this, that
  // stray listener still fires afterward and calls setShowDatePicker(true)
  // on the (closed, but not unmounted — Modal just toggles `visible`)
  // component, so the date picker sheet could appear already open the next
  // time the modal is reopened.
  const pendingKeyboardHideSubRef = useRef(null);
  const clearPendingKeyboardHideSub = () => {
    pendingKeyboardHideSubRef.current?.remove();
    pendingKeyboardHideSubRef.current = null;
  };
  useEffect(() => clearPendingKeyboardHideSub, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow';
    const hideEvent = Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide';
    const animateTo = (height, duration) => {
      Animated.timing(keyboardOffset, {
        toValue: height,
        duration: duration || 200,
        useNativeDriver: false, // animating layout (marginBottom), not transform/opacity
      }).start();
    };
    const showSub = Keyboard.addListener(showEvent, (e) => animateTo(e.endCoordinates?.height || 0, e.duration));
    const hideSub = Keyboard.addListener(hideEvent, (e) => animateTo(0, e.duration));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardOffset]);

  const trimmedLength = reason.trim().length;
  const canSave = !!date && trimmedLength >= MIN_REASON_LENGTH && !saving;

  const reset = () => {
    clearPendingKeyboardHideSub();
    setDate(null);
    setReason('');
    setPendingDate(new Date());
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const openDatePicker = () => {
    const showPicker = () => {
      setPendingDate(date || new Date());
      setShowDatePicker(true);
    };

    // Keyboard.dismiss() only *requests* the dismiss — it returns
    // immediately, before the keyboard's own ~250ms hide animation has
    // actually finished. Calling setShowDatePicker(true) right after it (the
    // previous fix) still opened the native date dialog while the keyboard
    // was mid-close, just a few milliseconds earlier than before — same
    // race, same visible flicker. Waiting for a real keyboardDidHide event
    // (or skipping the wait entirely when the keyboard was never open)
    // makes the two transitions genuinely sequential instead of assuming a
    // fixed delay is enough.
    if (Keyboard.isVisible?.()) {
      const hideEvent = Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide';
      const sub = Keyboard.addListener(hideEvent, () => {
        clearPendingKeyboardHideSub();
        showPicker();
      });
      pendingKeyboardHideSubRef.current = sub;
      Keyboard.dismiss();
    } else {
      showPicker();
    }
  };

  const confirmPickedDate = (picked) => {
    setDate(picked);
    setShowDatePicker(false);
  };

  const handleSave = async () => {
    if (!canSave || !assignment) return;
    setSaving(true);
    const requestedDate = toDateString(date);
    const payload = {
      dealer_id: assignment.dealer_id,
      assignment_id: assignment.id ?? undefined,
      requested_date: requestedDate,
      reason: reason.trim(),
    };
    try {
      await api.post('/followup-requests', payload);
      showAlert('Request sent', 'Your manager will be notified and can approve the follow-up visit.');
      reset();
      onSubmitted?.();
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueueAction('post', '/followup-requests', payload);
        showAlert('Offline Mode', 'Request saved locally and will be sent to your manager once you\'re back online.');
        reset();
        onSubmitted?.();
        return;
      }
      const serverError = err.response?.data?.error;
      if (serverError === 'reason_too_short') {
        showAlert('Reason too short', `Please explain in at least ${MIN_REASON_LENGTH} characters.`);
      } else if (serverError === 'requested_date_in_past') {
        showAlert('Invalid date', 'The requested date cannot be in the past.');
      } else {
        console.error('Failed to submit follow-up request:', err);
        showAlert('Error', 'Could not send this request. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <Animated.View style={[styles.sheetWrap, { marginBottom: keyboardOffset }]}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={styles.title}>Request follow-up</Text>
              <Pressable onPress={handleClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
                <X size={20} color={colors.text} />
              </Pressable>
            </View>
            {!!assignment && (
              <Text style={styles.dealerName} numberOfLines={1}>{assignment.dealer_name}</Text>
            )}

            <Text style={styles.label}>Follow-up date</Text>
            <Pressable
              style={styles.selector}
              onPress={openDatePicker}
              accessibilityRole="button"
              accessibilityLabel="Select follow-up date"
            >
              <Text style={[styles.selectorText, !date && styles.placeholderText]}>
                {date ? formatDisplayDate(date) : 'Select a date'}
              </Text>
              <CalendarDays size={18} color={colors.textMuted} />
            </Pressable>

            <Text style={[styles.label, { marginTop: spacing.lg }]}>Reason</Text>
            <TextInput
              style={styles.reasonInput}
              multiline
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. Dealer asked to meet again tomorrow, or couldn't visit today"
              placeholderTextColor={colors.textMuted}
              textAlignVertical="top"
            />
            <Text style={[styles.counter, trimmedLength < MIN_REASON_LENGTH && styles.counterShort]}>
              {trimmedLength} / {MIN_REASON_LENGTH} characters minimum
            </Text>

            <PrimaryButton title="Send request" onPress={handleSave} disabled={!canSave} loading={saving} />
          </View>
        </Animated.View>

        <DatePickerSheet
          visible={showDatePicker}
          initialDate={pendingDate}
          minDate={new Date()}
          onConfirm={confirmPickedDate}
          onCancel={() => setShowDatePicker(false)}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheetWrap: { justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    padding: spacing.screenHorizontal,
    paddingBottom: spacing.xxl,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  title: { ...typography.cardTitle, fontSize: 17, color: colors.text },
  dealerName: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.lg },
  label: { ...typography.caption, fontWeight: '600', color: colors.textSecondary, marginBottom: spacing.xs },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 52,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.input,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
  },
  selectorText: { ...typography.body, color: colors.text, flex: 1, marginRight: spacing.sm },
  placeholderText: { color: colors.textMuted },
  reasonInput: {
    minHeight: 100,
    fontSize: 15,
    lineHeight: 21,
    color: colors.text,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.input,
    backgroundColor: colors.background,
    padding: spacing.md,
  },
  counter: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.lg, textAlign: 'right' },
  counterShort: { color: colors.dangerDark, fontWeight: '600' },
});
