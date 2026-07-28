import React, { useRef } from 'react';
import { Text, Animated, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, radius, typography, spacing, durations, pressScale } from '../../theme';

/**
 * Outlined counterpart to PrimaryButton — same footprint, green border,
 * transparent/white fill. Used for secondary actions on a screen.
 */
export default function SecondaryButton({
  title,
  onPress,
  disabled = false,
  loading = false,
  icon,
  style,
  tone = 'primary', // 'primary' | 'danger'
  accessibilityLabel,
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const isInactive = disabled || loading;
  const tint = tone === 'danger' ? colors.danger : colors.primary;

  const animateTo = (toValue) => {
    Animated.timing(scale, { toValue, duration: durations.fast, useNativeDriver: true }).start();
  };

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        onPress={onPress}
        disabled={isInactive}
        onPressIn={() => !isInactive && animateTo(pressScale)}
        onPressOut={() => !isInactive && animateTo(1)}
        accessibilityRole="button"
        accessibilityState={{ disabled: isInactive, busy: loading }}
        accessibilityLabel={accessibilityLabel || title}
        style={[
          styles.base,
          {
            borderColor: isInactive ? colors.disabled : tint,
            backgroundColor: colors.card,
          },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={tint} size="small" />
        ) : (
          <>
            {icon}
            <Text
              style={[
                typography.button,
                styles.text,
                { color: isInactive ? colors.disabledText : tint },
              ]}
              numberOfLines={1}
            >
              {title}
            </Text>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 54,
    borderRadius: radius.button,
    borderWidth: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    width: '100%',
  },
  text: {
    marginLeft: 8,
  },
});
