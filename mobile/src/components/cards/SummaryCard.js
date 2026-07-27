import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, typography, radius, spacing } from '../../theme';

const TONES = {
  primary: { bg: colors.primaryLight, border: '#DBEAFE', text: colors.primary },
  success: { bg: colors.successLight, border: '#BBF7D0', text: colors.successDark },
  warning: { bg: colors.warningLight, border: '#FDE68A', text: colors.warningDark },
};

/**
 * A single stat tile (e.g. "12 visits", "8.4 km") — used in a row on the
 * Home dashboard summary section.
 */
export default function SummaryCard({ icon, value, label, tone = 'primary' }) {
  const t = TONES[tone] || TONES.primary;
  return (
    <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.border }]}>
      {icon}
      <Text style={[typography.sectionTitle, { color: t.text, marginTop: spacing.xs, fontSize: 20 }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[typography.caption, styles.label]} numberOfLines={1}>
        {label}
      </Text>
    </View>
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
