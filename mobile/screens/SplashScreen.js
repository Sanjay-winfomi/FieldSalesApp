import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Animated, Easing, Image } from 'react-native';
import * as SplashScreenNative from 'expo-splash-screen';
import { colors, spacing } from '../src/theme';
import { moderateScale } from '../src/utils/responsive';

const winfomiLogo = require('../assets/brand/winfomi-logo.png');

export default function SplashScreen() {
  const fade = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.85)).current;
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    // Native splash matches this screen's background/logo, so hiding it now
    // (right as this screen mounts) reads as one continuous splash.
    SplashScreenNative.hideAsync();

    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        friction: 6,
        tension: 60,
        useNativeDriver: true,
      }),
    ]).start();

    const pulse = (value, delay) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(value, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(value, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ])
      ).start();

    pulse(dot1, 0);
    pulse(dot2, 150);
    pulse(dot3, 300);
  }, []);

  return (
    <View style={styles.container} accessibilityRole="none">
      <Animated.View style={{ opacity: fade, transform: [{ scale }], alignItems: 'center' }}>
        <Image source={winfomiLogo} style={styles.logoImg} resizeMode="contain" />

        <View style={styles.taglineDivider} />
        <Text style={styles.tagline}>Attendance and dealer visit tracking</Text>
      </Animated.View>

      <View style={styles.dotsRow}>
        <Animated.View style={[styles.dot, { opacity: dot1 }]} />
        <Animated.View style={[styles.dot, { opacity: dot2 }]} />
        <Animated.View style={[styles.dot, { opacity: dot3 }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  logoImg: {
    width: moderateScale(220),
    height: moderateScale(63),
    marginBottom: spacing.xxl,
  },
  taglineDivider: {
    width: 32,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.primary,
    marginBottom: spacing.md,
  },
  tagline: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textSecondary,
    textAlign: 'center',
    letterSpacing: 0.2,
  },
  dotsRow: {
    flexDirection: 'row',
    position: 'absolute',
    bottom: 56,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
});
