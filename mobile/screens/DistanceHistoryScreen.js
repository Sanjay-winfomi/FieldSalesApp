import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl } from 'react-native';
import { TrendingUp, MapPin, Home } from 'lucide-react-native';
import { fetchActivityData, groupActivityByDay } from '../src/utils/activityHistory';
import { AppHeader, EmptyState, LoadingCard, FadeSlideIn, Card } from '../src/components';
import { colors, typography, spacing, radius } from '../src/theme';

/**
 * Dedicated "Distance travelled" drill-down from Home — an overall total up
 * top, then each day's total distance plus the km travelled between each
 * consecutive dealer stop that day. Same underlying day-grouping as
 * HistoryScreen/WorkingHoursScreen (src/utils/activityHistory.js), just
 * built around distance instead of visit search/filtering.
 */
export default function DistanceHistoryScreen({ navigation }) {
  const [attendanceDays, setAttendanceDays] = useState([]);
  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const fetchHistory = useCallback(async () => {
    try {
      const { attendanceDays: days, visits: v } = await fetchActivityData();
      setAttendanceDays(days);
      setVisits(v);
      setError('');
    } catch (err) {
      console.error('Failed to fetch distance history:', err);
      setError('Could not load distance history.');
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setLoading(true);
      fetchHistory().finally(() => setLoading(false));
    });
    return unsubscribe;
  }, [navigation, fetchHistory]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchHistory();
    setRefreshing(false);
  };

  const sections = useMemo(() => groupActivityByDay(attendanceDays, visits), [attendanceDays, visits]);
  const totalKm = useMemo(() => sections.reduce((sum, s) => sum + s.distanceKm, 0), [sections]);

  return (
    <View style={styles.screen}>
      <AppHeader title="Distance Travelled" onBack={() => navigation.goBack()} />

      <ScrollView
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && <LoadingCard message="Loading distance history..." />}

        {!loading && !!error && (
          <EmptyState icon={<TrendingUp size={40} color={colors.textMuted} />} title="Something went wrong" subtitle={error} />
        )}

        {!loading && !error && (
          <FadeSlideIn>
            <Card style={styles.totalCard}>
              <TrendingUp size={22} color={colors.warningDark} />
              <Text style={styles.totalValue}>{totalKm.toFixed(1)} km</Text>
              <Text style={styles.totalLabel}>Total distance travelled</Text>
            </Card>
          </FadeSlideIn>
        )}

        {!loading && !error && sections.length === 0 && (
          <EmptyState
            icon={<TrendingUp size={40} color={colors.textMuted} />}
            title="No distance recorded yet"
            subtitle="Your daily travel will show up here once you start logging visits."
          />
        )}

        {!loading && sections.map((section, sIndex) => (
          <View key={section.heading + sIndex} style={styles.dateSection}>
            <View style={styles.dateHeadingRow}>
              <Text style={styles.dateHeading}>{section.heading}</Text>
              <Text style={styles.dayTotal}>{section.distanceKm.toFixed(1)} km</Text>
            </View>

            {section.visits.length === 0 ? (
              section.finalLegDistanceKm != null && section.finalLegDistanceKm > 0 ? (
                <FadeSlideIn>
                  <View style={styles.stopRow}>
                    <View style={styles.stopIcon}>
                      <Home size={14} color={colors.primary} />
                    </View>
                    <View style={styles.stopText}>
                      <Text style={styles.stopName}>No dealer stops today</Text>
                      <Text style={styles.stopDistance}>
                        {section.finalLegIsRouted ? '' : '~'}{section.finalLegDistanceKm.toFixed(1)} km travelled (day start → day end)
                      </Text>
                    </View>
                  </View>
                </FadeSlideIn>
              ) : (
                <Text style={styles.noStopsText}>No dealer stops recorded this day.</Text>
              )
            ) : (
              <>
                {section.visits.map((visit, index) => (
                  <FadeSlideIn key={visit.id} delay={Math.min(index, 6) * 25}>
                    <View style={styles.stopRow}>
                      <View style={styles.stopIcon}>
                        <MapPin size={14} color={colors.primary} />
                      </View>
                      <View style={styles.stopText}>
                        <Text style={styles.stopName} numberOfLines={1}>
                          {visit.dealer_name || `Dealer #${visit.dealer_id}`}
                        </Text>
                        <Text style={styles.stopDistance}>
                          {visit.distance_from_previous_km > 0
                            ? `${visit.distance_is_routed ? '' : '~'}${parseFloat(visit.distance_from_previous_km).toFixed(1)} km from previous stop`
                            : 'Start of day'}
                        </Text>
                      </View>
                    </View>
                  </FadeSlideIn>
                ))}

                {section.finalLegDistanceKm != null && section.finalLegDistanceKm > 0 && (
                  <FadeSlideIn delay={Math.min(section.visits.length, 6) * 25}>
                    <View style={styles.stopRow}>
                      <View style={styles.stopIcon}>
                        <Home size={14} color={colors.primary} />
                      </View>
                      <View style={styles.stopText}>
                        <Text style={styles.stopName}>Return leg</Text>
                        <Text style={styles.stopDistance}>
                          {section.finalLegIsRouted ? '' : '~'}{section.finalLegDistanceKm.toFixed(1)} km from last stop
                        </Text>
                      </View>
                    </View>
                  </FadeSlideIn>
                )}
              </>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  listContainer: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },

  totalCard: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    marginBottom: spacing.xl,
    backgroundColor: colors.warningLight,
    borderColor: '#FDE68A',
  },
  totalValue: { ...typography.sectionTitle, color: colors.warningDark, fontSize: 28, marginTop: spacing.sm },
  totalLabel: { ...typography.caption, color: colors.textSecondary, marginTop: 4 },

  dateSection: { marginBottom: spacing.lg },
  dateHeadingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.sm },
  dateHeading: { ...typography.caption, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4 },
  dayTotal: { ...typography.cardTitle, fontSize: 15, color: colors.warningDark },
  noStopsText: { ...typography.caption, color: colors.textMuted, marginLeft: spacing.xs },

  stopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  stopIcon: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primaryLight,
    justifyContent: 'center', alignItems: 'center', marginRight: spacing.md,
  },
  stopText: { flex: 1 },
  stopName: { ...typography.cardTitle, fontSize: 14, color: colors.text },
  stopDistance: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
});
