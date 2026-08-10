import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Clock, CheckCircle2, History as HistoryIcon, Store, TrendingUp, Timer } from 'lucide-react-native';
import { api } from '../src/services/api';
import { AppHeader, SearchBar, EmptyState, LoadingCard, FadeSlideIn, Card } from '../src/components';
import { colors, typography, spacing, radius } from '../src/theme';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Completed' },
  { key: 'in_progress', label: 'In progress' },
];

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateHeading(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatDuration(minutes) {
  if (!minutes || minutes < 1) return '0h 0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

/**
 * Day-wise activity history — reached from Home's "Dealers visited",
 * "Distance travelled", and "Working hours" tiles (all three land here,
 * since a single day-grouped timeline already covers all three metrics
 * together) rather than a bottom tab. Combines two backend lists:
 * GET /api/attendance (one row per day: total_distance_km,
 * total_duration_minutes, login/logout time) for the day-level totals, and
 * GET /api/visits (one row per dealer visit) for the per-visit timeline —
 * grouped and matched by calendar date.
 */
export default function HistoryScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [attendanceDays, setAttendanceDays] = useState([]);
  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [error, setError] = useState('');

  const fetchHistory = useCallback(async () => {
    try {
      const [attendanceRes, visitsRes] = await Promise.all([
        api.get('/attendance'),
        api.get('/visits'),
      ]);
      setAttendanceDays(attendanceRes.data.attendance || []);
      setVisits(visitsRes.data.visits || []);
      setError('');
    } catch (err) {
      console.error('Failed to fetch history:', err);
      setError('Could not load history.');
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

  const sections = useMemo(() => {
    const filteredVisits = visits.filter((v) => {
      if (statusFilter === 'completed' && !v.logout_time) return false;
      if (statusFilter === 'in_progress' && v.logout_time) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!(v.dealer_name || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });

    // Keyed by calendar date so an attendance day and its visits line up
    // even though they come from two separate endpoints.
    const byDate = new Map();

    const dayKey = (iso) => (iso ? new Date(iso).toDateString() : 'Unknown');

    attendanceDays.forEach((a) => {
      const key = dayKey(a.login_time);
      byDate.set(key, {
        heading: formatDateHeading(a.login_time),
        attendance: a,
        allVisits: [],
        filteredVisits: [],
      });
    });

    // Every visit that day, regardless of the search/status filter — used
    // for the "N dealers visited" count, which should reflect what
    // actually happened that day, not what the current filter shows.
    visits.forEach((v) => {
      const key = dayKey(v.login_time);
      if (!byDate.has(key)) {
        byDate.set(key, { heading: formatDateHeading(v.login_time), attendance: null, allVisits: [], filteredVisits: [] });
      }
      byDate.get(key).allVisits.push(v);
    });

    filteredVisits.forEach((v) => {
      const key = dayKey(v.login_time);
      byDate.get(key)?.filteredVisits.push(v);
    });

    return Array.from(byDate.entries())
      .sort(([a], [b]) => new Date(b) - new Date(a))
      .map(([, section]) => {
        const dealersVisitedCount = new Set(section.allVisits.map((v) => v.dealer_id)).size;
        // Falls back to summing visit-to-visit distance when there's no
        // attendance row for the day (shouldn't normally happen, but a visit
        // record without a matching attendance row is still worth showing).
        const distanceKm = section.attendance
          ? parseFloat(section.attendance.total_distance_km || 0)
          : section.allVisits.reduce((sum, v) => sum + parseFloat(v.distance_from_previous_km || 0), 0);
        const durationMinutes = section.attendance?.total_duration_minutes || 0;

        return { ...section, dealersVisitedCount, distanceKm, durationMinutes };
      });
  }, [attendanceDays, visits, searchQuery, statusFilter]);

  return (
    <View style={styles.screen}>
      <AppHeader title="Activity History" onBack={() => navigation.goBack()} />

      <View style={[styles.filtersBar, { paddingTop: spacing.sm }]}>
        <SearchBar value={searchQuery} onChangeText={setSearchQuery} placeholder="Search by dealer name" style={{ marginBottom: spacing.md }} />
        <View style={styles.filterRow}>
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => setStatusFilter(f.key)}
              style={[styles.filterChip, statusFilter === f.key && styles.filterChipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: statusFilter === f.key }}
            >
              <Text style={[styles.filterChipText, statusFilter === f.key && styles.filterChipTextActive]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && <LoadingCard message="Loading history..." />}

        {!loading && !!error && (
          <EmptyState icon={<HistoryIcon size={40} color={colors.textMuted} />} title="Something went wrong" subtitle={error} />
        )}

        {!loading && !error && sections.length === 0 && (
          <EmptyState
            icon={<HistoryIcon size={40} color={colors.textMuted} />}
            title="No activity yet"
            subtitle="Your day logins and dealer visits will show up here."
          />
        )}

        {!loading && sections.map((section, sIndex) => (
          <View key={section.heading + sIndex} style={styles.dateSection}>
            <Text style={styles.dateHeading}>{section.heading}</Text>

            <View style={styles.daySummaryRow}>
              <View style={styles.daySummaryItem}>
                <Store size={14} color={colors.primary} />
                <Text style={styles.daySummaryText}>{section.dealersVisitedCount} dealer{section.dealersVisitedCount !== 1 ? 's' : ''} visited</Text>
              </View>
              <View style={styles.daySummaryItem}>
                <TrendingUp size={14} color={colors.warningDark} />
                <Text style={styles.daySummaryText}>{section.distanceKm.toFixed(1)} km</Text>
              </View>
              <View style={styles.daySummaryItem}>
                <Timer size={14} color={colors.successDark} />
                <Text style={styles.daySummaryText}>{formatDuration(section.durationMinutes)}</Text>
              </View>
            </View>

            {section.filteredVisits.map((visit, index) => {
              const completed = !!visit.logout_time;
              const isLast = index === section.filteredVisits.length - 1;
              return (
                <FadeSlideIn key={visit.id} delay={Math.min(index, 6) * 25}>
                  <View style={styles.timelineRow}>
                    <View style={styles.timelineTrack}>
                      <View style={[styles.timelineDot, { backgroundColor: completed ? colors.success : colors.warning }]} />
                      {!isLast && <View style={styles.timelineLine} />}
                    </View>

                    <Card style={styles.visitCard}>
                      <View style={styles.visitHeader}>
                        <Text style={styles.dealerName} numberOfLines={1}>
                          {visit.dealer_name || `Dealer #${visit.dealer_id}`}
                        </Text>
                        <View style={[styles.statusBadge, completed ? styles.statusBadgeDone : styles.statusBadgePending]}>
                          {completed && <CheckCircle2 size={12} color={colors.successDark} style={{ marginRight: 4 }} />}
                          <Text style={[styles.statusBadgeText, { color: completed ? colors.successDark : colors.warningDark }]}>
                            {completed ? 'Completed' : 'In progress'}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.timeRow}>
                        <Clock size={14} color={colors.textMuted} style={{ marginRight: 6 }} />
                        <Text style={styles.timeText}>
                          {formatTime(visit.login_time)} → {formatTime(visit.logout_time)}
                        </Text>
                      </View>

                      <Text style={styles.durationText}>
                        {completed
                          ? `Visit duration: ${visit.visit_duration_minutes || 0} min`
                          : 'Currently logged in'}
                      </Text>

                      {visit.distance_from_previous_km > 0 && (
                        <Text style={styles.distanceText}>
                          {parseFloat(visit.distance_from_previous_km).toFixed(1)} km from previous stop
                        </Text>
                      )}
                    </Card>
                  </View>
                </FadeSlideIn>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  filtersBar: {
    backgroundColor: colors.card,
    paddingHorizontal: spacing.screenHorizontal,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  filterRow: { flexDirection: 'row', gap: 8 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  filterChipTextActive: { color: colors.textInverse },

  listContainer: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  dateSection: { marginBottom: spacing.lg },
  dateHeading: { ...typography.caption, fontWeight: '700', color: colors.textSecondary, marginBottom: spacing.sm, textTransform: 'uppercase', letterSpacing: 0.4 },

  daySummaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  daySummaryItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  daySummaryText: { ...typography.caption, fontWeight: '600', color: colors.text },

  timelineRow: { flexDirection: 'row' },
  timelineTrack: { width: 20, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: 6 },
  timelineLine: { width: 2, flex: 1, backgroundColor: colors.border, marginTop: 4, marginBottom: 4 },

  visitCard: { flex: 1, marginLeft: spacing.sm, marginBottom: spacing.cardGap },
  visitHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  dealerName: { ...typography.cardTitle, color: colors.text, flex: 1, marginRight: spacing.sm },
  statusBadge: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  statusBadgeDone: { backgroundColor: colors.successLight },
  statusBadgePending: { backgroundColor: colors.warningLight },
  statusBadgeText: { fontSize: 11, fontWeight: '700' },

  timeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  timeText: { ...typography.caption, color: colors.textSecondary },
  durationText: { ...typography.caption, color: colors.textMuted },
  distanceText: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
});
