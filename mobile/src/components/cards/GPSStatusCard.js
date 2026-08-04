import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MapPin, Crosshair, CheckCircle2 } from 'lucide-react-native';
import Card from './Card';
import { colors, typography, spacing, radius } from '../../theme';

/**
 * Location-acquisition status shown on login/logout screens — address
 * (or "Acquiring..."), accuracy, and a status message.
 */
export default function GPSStatusCard({ address, coords, statusMessage, accuracyMeters }) {
  const acquired = !!coords;

  return (
    <Card style={styles.card}>
      <View style={styles.iconWrap}>
        <View style={[styles.iconCircle, acquired ? styles.iconCircleReady : styles.iconCirclePending]}>
          {acquired ? (
            <MapPin size={26} color={colors.primary} />
          ) : (
            <Crosshair size={26} color={colors.textMuted} />
          )}
        </View>
      </View>

      <Text style={[typography.body, styles.addressText]} numberOfLines={2}>
        {address || (coords ? `${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : 'Acquiring location...')}
      </Text>

      {!!statusMessage && (
        <Text style={[typography.caption, styles.statusMessage]}>{statusMessage}</Text>
      )}

      <View style={styles.footerRow}>
        <View
          style={[
            styles.badge,
            acquired ? styles.badgeSuccess : styles.badgePending,
          ]}
        >
          {acquired && <CheckCircle2 size={13} color={colors.successDark} style={{ marginRight: 4 }} />}
          <Text style={[styles.badgeText, { color: acquired ? colors.successDark : colors.textSecondary }]}>
            {acquired ? 'Location acquired' : 'Acquiring GPS...'}
          </Text>
        </View>
        {acquired && accuracyMeters != null && (
          <Text style={[typography.caption, styles.accuracyText]}>±{Math.round(accuracyMeters)}m</Text>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    marginBottom: spacing.cardGap,
  },
  iconWrap: {
    marginBottom: spacing.md,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
  },
  iconCircleReady: {
    backgroundColor: colors.primaryLight,
    borderColor: '#CFEAD9',
  },
  iconCirclePending: {
    backgroundColor: colors.background,
    borderColor: colors.border,
  },
  addressText: {
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  statusMessage: {
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    gap: 10,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
  },
  badgeSuccess: {
    backgroundColor: colors.successLight,
    borderColor: '#BBF7D0',
  },
  badgePending: {
    backgroundColor: colors.background,
    borderColor: colors.border,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  accuracyText: {
    color: colors.textMuted,
  },
});
