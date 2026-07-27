import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import Card from '../cards/Card';
import { colors, typography, spacing } from '../../theme';

/**
 * Full-width status card with a spinner and message — e.g. "Acquiring
 * GPS...", "Loading dealers...", "Checking network...". Used instead of a
 * blank screen while a request is in flight.
 */
export default function LoadingCard({ message = 'Loading...' }) {
  return (
    <Card style={styles.card}>
      <ActivityIndicator color={colors.primary} size="small" />
      <Text style={[typography.body, styles.text]}>{message}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.cardGap,
  },
  text: {
    marginLeft: spacing.md,
    color: colors.textSecondary,
  },
});
