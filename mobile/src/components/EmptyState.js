import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, typography, spacing } from '../theme';

/**
 * Consistent "nothing here" state — icon, headline, optional supporting
 * text. Used instead of a bare line of text on empty lists.
 */
export default function EmptyState({ icon, title, subtitle }) {
  return (
    <View style={styles.container} accessibilityRole="text">
      {icon}
      <Text style={[typography.cardTitle, styles.title]}>{title}</Text>
      {!!subtitle && <Text style={[typography.caption, styles.subtitle]}>{subtitle}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  title: {
    color: colors.text,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textSecondary,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
});
