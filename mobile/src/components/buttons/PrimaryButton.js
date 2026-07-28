import React, { useRef } from 'react';
import { Text, Animated, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, radius, typography, spacing, durations, pressScale } from '../../theme';

/**
 * The single primary call-to-action button used across the app — full width,
 * 54pt tall, filled primary green, with press/disabled/loading states baked in
 * so no screen re-implements its own button styling.
 */
export default function PrimaryButton({
  title,
  onPress,
  disabled = false,
  loading = false,
  icon,
  style,
  variant = 'primary', // 'primary' | 'danger' | 'success'
  accessibilityLabel,
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const isInactive = disabled || loading;

  const animateTo = (toValue) => {
    Animated.timing(scale, { toValue, duration: durations.fast, useNativeDriver: true }).start();
  };

  const bg =
    variant === 'danger' ? colors.danger : variant === 'success' ? colors.success : colors.primary;

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
          { backgroundColor: isInactive ? colors.disabled : bg },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={colors.textInverse} size="small" />
        ) : (
          <>
            {icon}
            <Text
              style={[
                typography.button,
                styles.text,
                { color: isInactive ? colors.disabledText : colors.textInverse },
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
