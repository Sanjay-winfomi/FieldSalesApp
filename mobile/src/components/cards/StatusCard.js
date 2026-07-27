import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Card from './Card';
import { colors, typography, radius, spacing } from '../../theme';

const TONES = {
  neutral: { border: colors.textMuted, bg: colors.card, text: colors.textSecondary },
  success: { border: colors.success, bg: colors.successLight, text: colors.successDark },
  warning: { border: colors.warning, bg: colors.warningLight, text: colors.warningDark },
  info: { border: colors.primary, bg: colors.primaryLight, text: colors.primaryDark },
};

/**
 * The day/visit status banner shown on the Home dashboard — a label, a
 * value, and an optional right-side action (button or icon pill).
 */
export default function StatusCard({ label, value, tone = 'neutral', action, onPress, icon }) {
  const t = TONES[tone] || TONES.neutral;
  const Wrapper = onPress ? Pressable : View;

  return (
    <Wrapper onPress={onPress} accessibilityRole={onPress ? 'button' : undefined}>
      <Card style={[styles.card, { borderLeftColor: t.border, backgroundColor: t.bg }]}>
        <View style={styles.row}>
          <View style={styles.left}>
            {icon}
            <View style={icon ? styles.leftTextWithIcon : undefined}>
              <Text style={[typography.caption, { color: colors.textSecondary }]}>{label}</Text>
              <Text style={[typography.cardTitle, { color: t.text, marginTop: 2 }]} numberOfLines={1}>
                {value}
              </Text>
            </View>
          </View>
          {action}
        </View>
      </Card>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  card: {
    borderLeftWidth: 4,
    marginBottom: spacing.cardGap,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  leftTextWithIcon: {
    marginLeft: spacing.md,
    flexShrink: 1,
  },
});
