import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, typography, radius, spacing } from '../../theme';

const TONES = {
  primary: { bg: colors.primaryLight, border: '#CFEAD9', text: colors.primary },
  success: { bg: colors.successLight, border: '#BBF7D0', text: colors.successDark },
  warning: { bg: colors.warningLight, border: '#FDE68A', text: colors.warningDark },
};

const NUMERIC_VALUE_RE = /^(-?\d+(?:\.\d+)?)(.*)$/;

/**
 * Counts a stat tile's displayed value up/down from whatever it previously
 * showed to the new value (e.g. "0" -> "12", "0.0 km" -> "8.4 km") instead of
 * jumping straight to the new number. Values that don't start with a number
 * pass through unanimated.
 */
function useAnimatedValue(rawValue) {
  const [display, setDisplay] = useState(rawValue);
  const fromRef = useRef(0);
  const rafRef = useRef(null);

  useEffect(() => {
    const match = String(rawValue).match(NUMERIC_VALUE_RE);
    if (!match) {
      setDisplay(rawValue);
      return undefined;
    }
    const target = parseFloat(match[1]);
    const suffix = match[2];
    const decimals = (match[1].split('.')[1] || '').length;
    const start = fromRef.current;
    const duration = 600;
    const startTime = Date.now();

    const tick = () => {
      const progress = Math.min(1, (Date.now() - startTime) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const current = start + (target - start) * eased;
      setDisplay(current.toFixed(decimals) + suffix);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [rawValue]);

  return display;
}

/**
 * A single stat tile (e.g. "12 visits", "8.4 km") — used in a row on the
 * Home dashboard summary section. Optionally pressable (e.g. "Visits today"
 * drills into the day's assigned-dealer list), same onPress-makes-it-a-
 * Pressable pattern as StatusCard.
 */
export default function SummaryCard({ icon, value, label, tone = 'primary', onPress }) {
  const t = TONES[tone] || TONES.primary;
  const Wrapper = onPress ? Pressable : View;
  const animatedValue = useAnimatedValue(value);
  return (
    <Wrapper
      style={[styles.card, { backgroundColor: t.bg, borderColor: t.border }]}
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
    >
      {icon}
      <Text style={[typography.sectionTitle, { color: t.text, marginTop: spacing.xs, fontSize: 20 }]} numberOfLines={1}>
        {animatedValue}
      </Text>
      <Text style={[typography.caption, styles.label]} numberOfLines={1}>
        {label}
      </Text>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: radius.card,
    borderWidth: 1,
    padding: spacing.lg,
    alignItems: 'center',
  },
  label: {
    color: colors.textSecondary,
    marginTop: 2,
    textAlign: 'center',
  },
});
