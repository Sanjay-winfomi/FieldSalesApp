import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { durations } from '../theme';

/**
 * Subtle entrance animation (fade + slight rise) used for cards/sections as
 * they appear — kept short and consistent rather than tuned per-screen.
 */
export default function FadeSlideIn({ children, delay = 0, style }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: durations.slow,
        delay,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: durations.slow,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <Animated.View style={[{ opacity, transform: [{ translateY }] }, style]}>
      {children}
    </Animated.View>
  );
}
