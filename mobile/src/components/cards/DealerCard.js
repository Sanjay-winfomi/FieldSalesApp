import React, { useRef } from 'react';
import { View, Text, Animated, Pressable, StyleSheet } from 'react-native';
import { MapPin, ChevronRight, CheckCircle2 } from 'lucide-react-native';
import Card from './Card';
import { colors, typography, spacing, radius, durations } from '../../theme';

/**
 * One dealer row in the Dealer Directory list — name, address, optional
 * distance, a visited/selected status pill, and a chevron affordance.
 */
export default function DealerCard({ dealer, selected, visited, distanceKm, onPress }) {
  const scale = useRef(new Animated.Value(1)).current;
  const animateTo = (v) =>
    Animated.timing(scale, { toValue: v, duration: durations.fast, useNativeDriver: true }).start();

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        onPress={onPress}
        onPressIn={() => animateTo(0.98)}
        onPressOut={() => animateTo(1)}
        accessibilityRole="button"
        accessibilityLabel={`${dealer.name}${selected ? ', selected' : ''}`}
      >
        <Card
          style={[
            styles.card,
            selected && { borderColor: colors.primary, backgroundColor: colors.primaryLight },
          ]}
        >
          <View style={styles.row}>
            <View style={styles.iconCircle}>
              <MapPin size={18} color={colors.primary} />
            </View>

            <View style={styles.textCol}>
              <Text style={[typography.cardTitle, { color: colors.text }]} numberOfLines={1}>
                {dealer.name}
              </Text>
              {!!dealer.address && (
                <Text style={[typography.caption, styles.address]} numberOfLines={2}>
                  {dealer.address}
                </Text>
              )}
              <View style={styles.metaRow}>
                {distanceKm != null && (
                  <Text style={[typography.caption, styles.metaText]}>{distanceKm.toFixed(1)} km away</Text>
                )}
                {visited && (
                  <View style={styles.visitedPill}>
                    <CheckCircle2 size={12} color={colors.successDark} />
                    <Text style={styles.visitedText}>Visited today</Text>
                  </View>
                )}
              </View>
            </View>

            <ChevronRight size={20} color={colors.textMuted} />
          </View>

          {selected && (
            <View style={styles.selectedFooter}>
              <Text style={styles.selectedFooterText}>Tap again to log in</Text>
            </View>
          )}
        </Card>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.cardGap,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  textCol: {
    flex: 1,
    marginRight: spacing.sm,
  },
  address: {
    color: colors.textSecondary,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    flexWrap: 'wrap',
    gap: 8,
  },
  metaText: {
    color: colors.textMuted,
  },
  visitedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.successLight,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    gap: 4,
  },
  visitedText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.successDark,
  },
  selectedFooter: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    alignItems: 'flex-end',
  },
  selectedFooterText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primary,
  },
});
