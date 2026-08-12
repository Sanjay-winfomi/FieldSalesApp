import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { colors, typography, spacing, shadows } from '../../theme';

/**
 * Consistent app bar for every screen — pads for the real device status bar
 * height via useSafeAreaInsets (notches, Android status bar, Dynamic Island)
 * instead of a hardcoded top offset, which is what caused titles/back arrows
 * to overlap the status bar before.
 */
export default function AppHeader({ title, subtitle, onBack, rightAction, transparent = false }) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + 12,
          backgroundColor: transparent ? 'transparent' : colors.card,
          borderBottomWidth: transparent ? 0 : StyleSheet.hairlineWidth,
        },
        transparent ? null : shadows.card,
      ]}
    >
      <View style={styles.row}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={22} color={colors.text} />
          </Pressable>
        ) : (
          <View style={styles.backButton} />
        )}

        <View style={styles.titleWrap}>
          <Text style={[typography.cardTitle, styles.title]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[typography.caption, styles.subtitle]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.rightSlot}>{rightAction}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderColor: colors.border,
    paddingBottom: 12,
    paddingHorizontal: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  titleWrap: {
    flex: 1,
    marginLeft: 4,
  },
  title: {
    color: colors.text,
  },
  subtitle: {
    color: colors.textSecondary,
    marginTop: 1,
  },
  rightSlot: {
    minWidth: 40,
    alignItems: 'flex-end',
  },
});
