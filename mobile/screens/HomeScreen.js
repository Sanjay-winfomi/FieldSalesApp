import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Store, Clock, Check, RefreshCw, AlertTriangle, TrendingUp, Timer, MapPin, ChevronRight, NotebookPen, BellRing,
} from 'lucide-react-native';
import { useAppState } from '../src/context/AppStateContext';
import { StatusCard, SummaryCard, PrimaryButton, FadeSlideIn, SyncQueueModal } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDuration(minutes) {
  if (!minutes || minutes < 1) return '0h 0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [syncQueueVisible, setSyncQueueVisible] = useState(false);
  const {
    employee,
    dayStatus,
    visitsCount,
    distanceTravelled,
    attendance,
    visits,
    refreshing,
    pendingSyncCount,
    setPendingSyncCount,
    locationPermissionDenied,
    locationPermissionCanAskAgain,
    backgroundLocationDenied,
    onOpenLocationSettings,
    fetchTodayState,
    onSelectDealer,
    fetchAssignedDealers,
  } = useAppState();

  // Refresh the assigned-dealer list (and any in-progress navigation
  // status on it) whenever this tab regains focus — e.g. returning from
  // Check-In or the navigation screen. Same pattern already used by
  // DealerDirectoryScreen's own focus listener.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', fetchAssignedDealers);
    return unsubscribe;
  }, [navigation, fetchAssignedDealers]);

  const handleRefresh = () => {
    fetchTodayState();
    fetchAssignedDealers();
  };

  const loginTime = attendance?.login_time ? formatTime(attendance.login_time) : '';

  const workingMinutes = useMemo(() => {
    if (!attendance?.login_time) return 0;
    if (attendance.total_duration_minutes != null) return attendance.total_duration_minutes;
    return Math.max(0, Math.round((Date.now() - new Date(attendance.login_time)) / 60000));
  }, [attendance]);

  const uniqueDealersVisited = useMemo(() => {
    return new Set(visits.map((v) => v.dealer_id)).size;
  }, [visits]);

  const activeVisit = visits.find((v) => !v.logout_time);
  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.greeting}>{getGreeting()}</Text>
        <Text style={styles.userName} numberOfLines={1}>{employee?.name || 'User'}</Text>
        <View style={styles.metaRow}>
          <View style={styles.rolePill}>
            <Text style={styles.rolePillText}>{employee?.role === 'manager' ? 'Manager' : 'Field rep'}</Text>
          </View>
          <Text style={styles.dateText}>{todayLabel}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {locationPermissionDenied && (
          <FadeSlideIn>
            <View style={styles.warningBanner}>
              <AlertTriangle size={16} color={colors.dangerDark} style={styles.bannerIcon} />
              <View style={{ flex: 1 }}>
                <Text style={styles.warningBannerText}>
                  Location permission is off — login/logout won't work until it's re-enabled.
                </Text>
                {!locationPermissionCanAskAgain && (
                  <Pressable onPress={onOpenLocationSettings} accessibilityRole="button">
                    <Text style={styles.warningBannerLink}>Open Settings to re-enable</Text>
                  </Pressable>
                )}
              </View>
            </View>
          </FadeSlideIn>
        )}

        {!locationPermissionDenied && backgroundLocationDenied && (
          <FadeSlideIn>
            <View style={styles.warningBanner}>
              <AlertTriangle size={16} color={colors.dangerDark} style={styles.bannerIcon} />
              <View style={{ flex: 1 }}>
                <Text style={styles.warningBannerText}>
                  Background location is off — you won't get a "You've arrived" alert for assigned dealers unless the app is open.
                </Text>
                <Pressable onPress={onOpenLocationSettings} accessibilityRole="button">
                  <Text style={styles.warningBannerLink}>Open Settings to allow "All the time"</Text>
                </Pressable>
              </View>
            </View>
          </FadeSlideIn>
        )}

        {pendingSyncCount > 0 && (
          <FadeSlideIn>
            <Pressable
              style={styles.syncBanner}
              onPress={() => setSyncQueueVisible(true)}
              accessibilityRole="button"
              accessibilityLabel="View actions waiting to sync"
            >
              <RefreshCw size={14} color={colors.primary} style={styles.bannerIcon} />
              <Text style={styles.syncBannerText}>
                {pendingSyncCount} action{pendingSyncCount !== 1 ? 's' : ''} waiting to sync
              </Text>
              <ChevronRight size={16} color={colors.primary} />
            </Pressable>
          </FadeSlideIn>
        )}

        <SyncQueueModal
          visible={syncQueueVisible}
          onClose={() => setSyncQueueVisible(false)}
          onQueueChanged={setPendingSyncCount}
        />

        <FadeSlideIn delay={40}>
          {dayStatus === 'not_logged_in' && (
            <StatusCard
              label="Day status"
              value="Not logged in"
              tone="neutral"
              icon={<Clock size={22} color={colors.textSecondary} />}
              onPress={() => navigation.navigate('DayLogin')}
              action={
                <View style={styles.smallActionBtn}>
                  <Text style={styles.smallActionBtnText}>Login</Text>
                </View>
              }
            />
          )}

          {dayStatus === 'logged_in' && (
            <StatusCard
              label="Day status"
              value={`Logged in ${loginTime}`}
              tone="success"
              icon={<Check size={22} color={colors.successDark} />}
            />
          )}

          {dayStatus === 'day_ended' && (
            <StatusCard
              label="Day status"
              value="Day ended"
              tone="warning"
              icon={<Check size={22} color={colors.warningDark} />}
              action={
                <View style={[styles.smallActionBtn, styles.completedPill]}>
                  <Text style={[styles.smallActionBtnText, { color: colors.warningDark }]}>Completed</Text>
                </View>
              }
            />
          )}
        </FadeSlideIn>

        {activeVisit && (
          <FadeSlideIn delay={80}>
            <StatusCard
              label="Active visit"
              value={`At ${activeVisit.dealer_name || `Dealer #${activeVisit.dealer_id}`}`}
              tone="info"
              icon={<MapPin size={22} color={colors.primary} />}
              action={
                <Pressable
                  style={styles.logoutBtn}
                  onPress={() => {
                    const dl = { id: activeVisit.dealer_id, name: activeVisit.dealer_name };
                    onSelectDealer(dl, true, navigation);
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.logoutBtnText}>Dealer Logout</Text>
                </Pressable>
              }
            />
          </FadeSlideIn>
        )}

        <FadeSlideIn delay={120}>
          <Text style={styles.sectionLabel}>Today's summary</Text>
          <View style={styles.summaryGrid}>
            <SummaryCard
              icon={<Store size={20} color={colors.primary} />}
              value={visitsCount}
              label="Visits today"
              tone="primary"
              onPress={() => navigation.navigate('TodaysVisits')}
            />
            <View style={{ width: spacing.md }} />
            <SummaryCard
              icon={<TrendingUp size={20} color={colors.warningDark} />}
              value={distanceTravelled}
              label="Distance travelled"
              tone="warning"
              onPress={() => navigation.navigate('DistanceHistory')}
            />
          </View>
          <View style={[styles.summaryGrid, { marginTop: spacing.md }]}>
            <SummaryCard
              icon={<Timer size={20} color={colors.successDark} />}
              value={formatDuration(workingMinutes)}
              label="Working hours"
              tone="success"
              onPress={() => navigation.navigate('WorkingHours')}
            />
            <View style={{ width: spacing.md }} />
            <SummaryCard
              icon={<MapPin size={20} color={colors.primary} />}
              value={uniqueDealersVisited}
              label="Dealers visited"
              tone="primary"
              onPress={() => navigation.navigate('History')}
            />
          </View>
        </FadeSlideIn>

        {dayStatus === 'logged_in' && (
          <FadeSlideIn delay={160} style={{ marginTop: spacing.cardGap }}>
            <PrimaryButton
              title="Proceed to logout"
              onPress={() => {
                if (activeVisit) {
                  // Guard preserved from the original flow: can't end the day
                  // with an open dealer visit still running.
                  return;
                }
                navigation.navigate('DayLogout');
              }}
              disabled={!!activeVisit}
            />
            {activeVisit && (
              <Text style={styles.blockedHint}>
                Log out from "{activeVisit.dealer_name || 'the dealer'}" first.
              </Text>
            )}
          </FadeSlideIn>
        )}

        <FadeSlideIn delay={200} style={{ marginTop: spacing.xxl }}>
          <Text style={styles.sectionLabel}>Quick actions</Text>
          <Pressable
            style={styles.quickAction}
            onPress={() => navigation.navigate('Notes')}
            accessibilityRole="button"
          >
            <View style={styles.quickActionIcon}>
              <NotebookPen size={18} color={colors.primary} />
            </View>
            <Text style={styles.quickActionText}>Notes</Text>
            <ChevronRight size={18} color={colors.textMuted} />
          </Pressable>
          <Pressable
            style={styles.quickAction}
            onPress={() => navigation.navigate('Reminders')}
            accessibilityRole="button"
          >
            <View style={styles.quickActionIcon}>
              <BellRing size={18} color={colors.primary} />
            </View>
            <Text style={styles.quickActionText}>Reminders</Text>
            <ChevronRight size={18} color={colors.textMuted} />
          </Pressable>
        </FadeSlideIn>
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
  greeting: { ...typography.caption, color: colors.textSecondary },
  userName: { ...typography.sectionTitle, color: colors.text, marginTop: 2, fontSize: 22 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
  rolePill: {
    backgroundColor: colors.primaryLight,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginRight: spacing.sm,
  },
  rolePillText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  dateText: { ...typography.caption, color: colors.textMuted },

  scrollContent: {
    padding: spacing.screenHorizontal,
    paddingBottom: spacing.xxxl,
  },

  bannerIcon: { marginRight: spacing.sm },
  warningBanner: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.dangerLight,
    borderWidth: 1, borderColor: '#FECACA', borderRadius: 14, padding: spacing.md, marginBottom: spacing.cardGap,
  },
  warningBannerText: { ...typography.caption, color: colors.dangerDark, fontWeight: '600' },
  warningBannerLink: { ...typography.caption, color: colors.dangerDark, fontWeight: '700', textDecorationLine: 'underline', marginTop: 4 },
  syncBanner: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primaryLight,
    borderWidth: 1, borderColor: '#DBEAFE', borderRadius: 14, padding: spacing.md, marginBottom: spacing.cardGap,
  },
  syncBannerText: { flex: 1, ...typography.caption, color: colors.primary, fontWeight: '600' },

  smallActionBtn: { backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10 },
  smallActionBtnText: { color: colors.textInverse, fontSize: 13, fontWeight: '700' },
  completedPill: { backgroundColor: colors.warningLight, borderWidth: 1, borderColor: '#FDE68A' },
  logoutBtn: { backgroundColor: colors.danger, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10 },
  logoutBtnText: { color: colors.textInverse, fontSize: 13, fontWeight: '700' },

  sectionLabel: { ...typography.cardTitle, fontSize: 16, color: colors.text, marginBottom: spacing.md },
  summaryGrid: { flexDirection: 'row' },

  blockedHint: { ...typography.caption, color: colors.dangerDark, textAlign: 'center', marginTop: spacing.sm },

  quickAction: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm,
  },
  quickActionIcon: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primaryLight,
    justifyContent: 'center', alignItems: 'center', marginRight: spacing.md,
  },
  quickActionText: { flex: 1, ...typography.body, color: colors.text, fontWeight: '600' },
});
