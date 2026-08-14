import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl } from 'react-native';
import { Timer, Store } from 'lucide-react-native';
import { fetchActivityData, groupActivityByDay, formatDuration } from '../src/utils/activityHistory';
import { AppHeader, EmptyState, LoadingCard, FadeSlideIn, Card } from '../src/components';
import { colors, typography, spacing, radius } from '../src/theme';

function formatMinutesShort(minutes) {
  if (!minutes || minutes < 1) return '0 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return formatDuration(minutes);
}

/**
 * Dedicated "Working hours" drill-down from Home — an overall total up top,
 * then each day's total working hours plus how long was spent at each
 * dealer ("dealers meet" time, i.e. visit_duration_minutes). Same
 * underlying day-grouping as HistoryScreen/DistanceHistoryScreen
 * (src/utils/activityHistory.js), built around duration instead.
 */
export default function WorkingHoursScreen({ navigation }) {
  const [attendanceDays, setAttendanceDays] = useState([]);
  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // Guards every post-await setState against this fetch resolving after
  // the rep has already navigated away (see NotesScreen.js for the same
  // pattern/reasoning).
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const { attendanceDays: days, visits: v } = await fetchActivityData();
      if (!isMountedRef.current) return;
      setAttendanceDays(days);
      setVisits(v);
      setError('');
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Failed to fetch working-hours history:', err);
      setError('Could not load working-hours history.');
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setLoading(true);
      fetchHistory().finally(() => {
        if (isMountedRef.current) setLoading(false);
      });
    });
    return unsubscribe;
  }, [navigation, fetchHistory]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchHistory();
    if (isMountedRef.current) setRefreshing(false);
  };

  const sections = useMemo(() => groupActivityByDay(attendanceDays, visits), [attendanceDays, visits]);
  const totalMinutes = useMemo(() => sections.reduce((sum, s) => sum + s.durationMinutes, 0), [sections]);

  return (
    <View style={styles.screen}>
      <AppHeader title="Working Hours" onBack={() => navigation.goBack()} />

      <ScrollView
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && <LoadingCard message="Loading working-hours history..." />}

        {!loading && !!error && (
          <EmptyState icon={<Timer size={40} color={colors.textMuted} />} title="Something went wrong" subtitle={error} />
        )}

        {!loading && !error && (
          <FadeSlideIn>
            <Card style={styles.totalCard}>
              <Timer size={22} color={colors.successDark} />
              <Text style={styles.totalValue}>{formatDuration(totalMinutes)}</Text>
              <Text style={styles.totalLabel}>Total working hours</Text>
            </Card>
          </FadeSlideIn>
        )}

        {!loading && !error && sections.length === 0 && (
          <EmptyState
            icon={<Timer size={40} color={colors.textMuted} />}
            title="No working hours recorded yet"
            subtitle="Your daily login/logout hours will show up here."
          />
        )}

        {!loading && sections.map((section, sIndex) => (
          <View key={section.heading + sIndex} style={styles.dateSection}>
            <View style={styles.dateHeadingRow}>
              <Text style={styles.dateHeading}>{section.heading}</Text>
              <Text style={styles.dayTotal}>{formatDuration(section.durationMinutes)}</Text>
            </View>

            {section.visits.length === 0 ? (
              <Text style={styles.noStopsText}>No dealer visits recorded this day.</Text>
            ) : (
              section.visits.map((visit, index) => (
                <FadeSlideIn key={visit.id} delay={Math.min(index, 6) * 25}>
                  <View style={styles.stopRow}>
                    <View style={styles.stopIcon}>
                      <Store size={14} color={colors.success} />
                    </View>
                    <View style={styles.stopText}>
                      <Text style={styles.stopName} numberOfLines={1}>
                        {visit.dealer_name || `Dealer #${visit.dealer_id}`}
                      </Text>
                      <Text style={styles.stopDuration}>
                        {visit.logout_time
                          ? `${formatMinutesShort(visit.visit_duration_minutes)} spent with dealer`
                          : 'Currently with dealer'}
                      </Text>
                    </View>
                  </View>
                </FadeSlideIn>
              ))
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
    backgroundColor: colors.successLight,
    borderColor: '#BBF7D0',
  },
  totalValue: { ...typography.sectionTitle, color: colors.successDark, fontSize: 28, marginTop: spacing.sm },
  totalLabel: { ...typography.caption, color: colors.textSecondary, marginTop: 4 },

  dateSection: { marginBottom: spacing.lg },
  dateHeadingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.sm },
  dateHeading: { ...typography.caption, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4 },
  dayTotal: { ...typography.cardTitle, fontSize: 15, color: colors.successDark },
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
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.successLight,
    justifyContent: 'center', alignItems: 'center', marginRight: spacing.md,
  },
  stopText: { flex: 1 },
  stopName: { ...typography.cardTitle, fontSize: 14, color: colors.text },
  stopDuration: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
});
