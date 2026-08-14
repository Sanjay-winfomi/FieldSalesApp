import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { MapPin, Navigation, Clock, CalendarClock, Route } from 'lucide-react-native';
import Card from './Card';
import { colors, typography, spacing, radius } from '../../theme';

const STATUS_TONES = {
  pending: { bg: colors.card, text: colors.textSecondary, label: 'Pending' },
  navigating: { bg: colors.primaryLight, text: colors.primary, label: 'Navigating' },
  arrived: { bg: colors.warningLight, text: colors.warningDark, label: 'Arrived' },
  completed: { bg: colors.successLight, text: colors.successDark, label: 'Completed' },
  cancelled: { bg: colors.dangerLight, text: colors.dangerDark, label: 'Cancelled' },
};

function formatEta(isoString) {
  if (!isoString) return null;
  try {
    return new Date(isoString).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return null;
  }
}

/**
 * One row in Home's "Today's Assigned Dealers" section — manager-set order
 * number, dealer name/address, current navigation status, distance/ETA once
 * computed, and a Navigate action. The order number is exactly whatever
 * sequence_order the manager saved; this component never reorders anything.
 *
 * onRequestFollowup is optional — when provided, shows a "Request
 * follow-up" link (e.g. the dealer couldn't be visited today, or asked to
 * be seen again on a specific future day) that opens FollowupRequestModal.
 *
 * estimatedDistanceKm is optional — a straight-line (haversine) fallback
 * distance from the rep's current position, shown only until a real
 * driving distance exists for this dealer (either the routed
 * distance_meters from an actual Navigate attempt, or preciseDistanceKm
 * from a manual "Get accurate distance" tap below). Priority, highest
 * first: routed distance_meters > preciseDistanceKm > estimatedDistanceKm.
 *
 * onFetchAccurateDistance is optional — when provided (and no real
 * distance exists yet), shows a "Get accurate distance" link that calls it
 * with the assignment, for a real Google Maps distance without implying a
 * navigation attempt started (unlike tapping Navigate itself).
 */
function AssignedDealerCard({
  assignment, estimatedDistanceKm, preciseDistanceKm, fetchingPreciseDistance,
  onNavigate, onRequestFollowup, onFetchAccurateDistance,
}) {
  const tone = STATUS_TONES[assignment.status] || STATUS_TONES.pending;
  const isDone = assignment.status === 'completed' || assignment.status === 'cancelled';
  const routedDistanceKm = assignment.distance_meters != null ? assignment.distance_meters / 1000 : null;
  const distanceKm = routedDistanceKm ?? preciseDistanceKm ?? estimatedDistanceKm ?? null;
  const isEstimate = routedDistanceKm == null && preciseDistanceKm == null && estimatedDistanceKm != null;
  const showAccurateDistanceLink = !isDone && !!onFetchAccurateDistance
    && routedDistanceKm == null && preciseDistanceKm == null && estimatedDistanceKm != null;
  const eta = formatEta(assignment.expected_arrival_time);

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <View style={styles.orderBadge}>
          <Text style={styles.orderBadgeText}>{assignment.sequence_order}</Text>
        </View>

        <View style={styles.textCol}>
          <Text style={[typography.cardTitle, { color: colors.text }]} numberOfLines={1}>
            {assignment.dealer_name}
          </Text>
          {!!assignment.dealer_address && (
            <Text style={[typography.caption, styles.address]} numberOfLines={2}>
              {assignment.dealer_address}
            </Text>
          )}

          <View style={styles.metaRow}>
            <View style={[styles.statusPill, { backgroundColor: tone.bg }]}>
              <Text style={[styles.statusPillText, { color: tone.text }]}>{tone.label}</Text>
            </View>
            {distanceKm != null && (
              <View style={styles.metaItem}>
                <MapPin size={12} color={colors.textMuted} />
                <Text style={styles.metaText}>{isEstimate ? '~' : ''}{distanceKm.toFixed(1)} km</Text>
              </View>
            )}
            {eta && (
              <View style={styles.metaItem}>
                <Clock size={12} color={colors.textMuted} />
                <Text style={styles.metaText}>ETA {eta}</Text>
              </View>
            )}
          </View>
        </View>

        {!isDone && (
          <Pressable
            style={styles.navigateBtn}
            onPress={() => onNavigate(assignment)}
            accessibilityRole="button"
            accessibilityLabel={`Navigate to ${assignment.dealer_name}`}
          >
            <Navigation size={16} color={colors.textInverse} />
          </Pressable>
        )}
      </View>

      {showAccurateDistanceLink && (
        <Pressable
          style={styles.followupLink}
          onPress={() => onFetchAccurateDistance(assignment)}
          disabled={fetchingPreciseDistance}
          accessibilityRole="button"
          accessibilityLabel={`Get accurate distance to ${assignment.dealer_name}`}
        >
          {fetchingPreciseDistance ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Route size={13} color={colors.primary} />
          )}
          <Text style={styles.followupLinkText}>
            {fetchingPreciseDistance ? 'Getting distance…' : 'Get accurate distance'}
          </Text>
        </Pressable>
      )}

      {!!onRequestFollowup && (
        <Pressable
          style={styles.followupLink}
          onPress={() => onRequestFollowup(assignment)}
          accessibilityRole="button"
          accessibilityLabel={`Request follow-up for ${assignment.dealer_name}`}
        >
          <CalendarClock size={13} color={colors.primary} />
          <Text style={styles.followupLinkText}>Request follow-up</Text>
        </Pressable>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: spacing.cardGap },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  orderBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  orderBadgeText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  textCol: { flex: 1, marginRight: spacing.sm },
  address: { color: colors.textSecondary, marginTop: 2 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    flexWrap: 'wrap',
    gap: 8,
  },
  statusPill: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusPillText: { fontSize: 11, fontWeight: '700' },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12, color: colors.textMuted },
  navigateBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  followupLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  followupLinkText: { fontSize: 12, fontWeight: '600', color: colors.primary },
});

// Rendered once per assigned dealer in TodaysVisitsScreen's list — without
// memo, any state change there (e.g. a GPS estimate updating, or a precise
// distance arriving for a DIFFERENT dealer) re-rendered every card in the
// list, not just the one whose own props actually changed. Only pays off
// because the parent also passes stable (useCallback'd) onNavigate/
// onFetchAccurateDistance instead of a fresh inline function each render —
// see TodaysVisitsScreen.js.
export default React.memo(AssignedDealerCard);
