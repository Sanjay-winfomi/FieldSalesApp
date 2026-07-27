import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors, radius, shadows, spacing } from '../../theme';

/**
 * Base card shell reused by every specialized card in the app — white
 * background, soft shadow, subtle border, rounded corners, consistent
 * padding. Specialized cards (StatusCard, DealerCard, ...) compose this
 * rather than re-declaring the same box styling.
 */
export default function Card({ children, style, noPadding = false }) {
  return (
    <View style={[styles.card, noPadding ? null : styles.padded, shadows.card, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  padded: {
    padding: 18,
  },
});
