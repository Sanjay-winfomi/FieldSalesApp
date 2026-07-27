import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import Card from './Card';
import { colors, typography, spacing } from '../../theme';

/**
 * Compact single-row location display — used where a full GPSStatusCard
 * would take too much vertical space (e.g. check-out screens that already
 * show a summary card above).
 */
export default function LocationCard({ address, coords, statusMessage }) {
  const acquired = !!coords;
  return (
    <Card style={styles.card} noPadding>
      <View style={styles.row}>
        <MapPin size={18} color={acquired ? colors.primary : colors.textMuted} style={styles.icon} />
        <Text style={[typography.body, styles.text]} numberOfLines={2}>
          {address || (coords ? `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : statusMessage || 'Acquiring location...')}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    marginBottom: spacing.cardGap,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: spacing.sm,
  },
  text: {
    flex: 1,
    color: colors.text,
  },
});
