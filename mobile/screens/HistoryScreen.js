import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Clock, CheckCircle2, History as HistoryIcon } from 'lucide-react-native';
import { api } from '../src/services/api';
import { SearchBar, EmptyState, LoadingCard, FadeSlideIn, Card } from '../src/components';
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

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const [visits, setVisits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [error, setError] = useState('');

  const fetchHistory = useCallback(async () => {
    try {
      const res = await api.get('/visits');
      setVisits(res.data.visits || []);
      setError('');
    } catch (err) {
      console.error('Failed to fetch visit history:', err);
      setError('Could not load visit history.');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchHistory().finally(() => setLoading(false));
  }, [fetchHistory]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchHistory();
    setRefreshing(false);
  };

  const sections = useMemo(() => {
    const filtered = visits.filter((v) => {
      if (statusFilter === 'completed' && !v.check_out_time) return false;
      if (statusFilter === 'in_progress' && v.check_out_time) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!(v.dealer_name || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });

    const byDate = new Map();
    filtered.forEach((v) => {
      const key = v.check_in_time ? new Date(v.check_in_time).toDateString() : 'Unknown';
      if (!byDate.has(key)) byDate.set(key, { heading: formatDateHeading(v.check_in_time), items: [] });
      byDate.get(key).items.push(v);
    });
    return Array.from(byDate.values());
  }, [visits, searchQuery, statusFilter]);

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.title}>Visit history</Text>
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
        {loading && <LoadingCard message="Loading visit history..." />}

        {!loading && !!error && (
          <EmptyState icon={<HistoryIcon size={40} color={colors.textMuted} />} title="Something went wrong" subtitle={error} />
        )}

        {!loading && !error && sections.length === 0 && (
          <EmptyState
            icon={<HistoryIcon size={40} color={colors.textMuted} />}
            title="No visits yet"
            subtitle="Dealer visits you check in to will show up here."
          />
        )}

        {!loading && sections.map((section, sIndex) => (
          <View key={section.heading + sIndex} style={styles.dateSection}>
            <Text style={styles.dateHeading}>{section.heading}</Text>
            {section.items.map((visit, index) => {
              const completed = !!visit.check_out_time;
              const isLast = index === section.items.length - 1;
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
                          {formatTime(visit.check_in_time)} → {formatTime(visit.check_out_time)}
                        </Text>
                      </View>

                      <Text style={styles.durationText}>
                        {completed
                          ? `Visit duration: ${visit.visit_duration_minutes || 0} min`
                          : 'Currently checked in'}
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
  header: {
    backgroundColor: colors.card,
    paddingHorizontal: spacing.screenHorizontal,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  title: { ...typography.sectionTitle, color: colors.text, fontSize: 22, marginBottom: spacing.md },
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
  dateHeading: { ...typography.caption, fontWeight: '700', color: colors.textSecondary, marginBottom: spacing.md, textTransform: 'uppercase', letterSpacing: 0.4 },

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
