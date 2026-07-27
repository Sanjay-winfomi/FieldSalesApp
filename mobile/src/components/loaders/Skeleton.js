import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet } from 'react-native';
import { colors, radius } from '../../theme';

/**
 * A shimmering placeholder block — used to build skeleton loading states
 * instead of leaving a blank screen while data is in flight.
 */
export function SkeletonBlock({ width = '100%', height = 16, style, round = radius.sm }) {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 650, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: round, backgroundColor: colors.border, opacity },
        style,
      ]}
    />
  );
}

/** A full skeleton card matching the shape of a DealerCard/StatusCard row. */
export function SkeletonCard() {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <SkeletonBlock width={40} height={40} round={20} />
        <View style={styles.textCol}>
          <SkeletonBlock width="70%" height={16} />
          <SkeletonBlock width="90%" height={12} style={{ marginTop: 8 }} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  textCol: {
    flex: 1,
    marginLeft: 12,
  },
});
