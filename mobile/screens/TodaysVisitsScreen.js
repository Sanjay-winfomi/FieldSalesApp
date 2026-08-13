import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, ScrollView, RefreshControl } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { useAppState } from '../src/context/AppStateContext';
import { getCurrentLocation, haversineMeters } from '../src/services/location';
import { api } from '../src/services/api';
import { AppHeader, EmptyState, FadeSlideIn, AssignedDealerCard, FollowupRequestModal } from '../src/components';
import { colors, spacing } from '../src/theme';

/**
 * Full list of today's manager-assigned dealers, in the order they were
 * assigned — reached by tapping the "Visits today" tile on Home instead of
 * showing the list inline there. AppStateContext wraps the whole navigator
 * (not just the tab screens), so this screen reads assignedDealers the same
 * way HomeScreen does, with no props to thread through.
 */
export default function TodaysVisitsScreen({ navigation }) {
  const { assignedDealers, fetchAssignedDealers, onSelectAssignment } = useAppState();
  const [followupAssignment, setFollowupAssignment] = useState(null);
  // One-shot GPS fix used only to show a rough "how far is each dealer"
  // estimate before the rep taps Navigate (which computes the real driving
  // distance via the Google Routes API). Best-effort: if it fails/denies,
  // cards just fall back to showing no distance, same as they always did.
  const [coords, setCoords] = useState(null);
  // dealer_id -> { km?, loading?, error? } — set only when the rep taps
  // "Get accurate distance" on a card (never fetched automatically, unlike
  // the free straight-line estimate above, since this is a real paid
  // Google Maps API call per tap).
  const [preciseDistances, setPreciseDistances] = useState({});

  const handleFetchAccurateDistance = async (assignment) => {
    if (!coords || assignment.dealer_lat == null || assignment.dealer_lng == null) return;
    setPreciseDistances((prev) => ({ ...prev, [assignment.dealer_id]: { loading: true } }));
    try {
      const res = await api.post('/navigation/distance-preview', {
        origin_lat: coords.lat, origin_lng: coords.lng,
        dest_lat: assignment.dealer_lat, dest_lng: assignment.dealer_lng,
      });
      setPreciseDistances((prev) => ({ ...prev, [assignment.dealer_id]: { km: res.data.distanceMeters / 1000 } }));
    } catch {
      setPreciseDistances((prev) => ({ ...prev, [assignment.dealer_id]: { error: true } }));
    }
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      fetchAssignedDealers();
      getCurrentLocation().then(setCoords);
    });
    return unsubscribe;
  }, [navigation, fetchAssignedDealers]);

  // dealer_id -> straight-line distance in km from the rep's last known
  // position — only used as a fallback for a dealer whose real (routed)
  // distance_meters hasn't been computed yet (i.e. Navigate hasn't been
  // tapped today).
  const estimatedDistanceKmByDealerId = useMemo(() => {
    if (!coords) return {};
    const map = {};
    for (const a of assignedDealers) {
      if (a.distance_meters != null || a.dealer_lat == null || a.dealer_lng == null) continue;
      map[a.dealer_id] = haversineMeters(coords.lat, coords.lng, a.dealer_lat, a.dealer_lng) / 1000;
    }
    return map;
  }, [coords, assignedDealers]);

  return (
    <View style={styles.screen}>
      <AppHeader title="Today's Visits" onBack={() => navigation.goBack()} />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={false} onRefresh={fetchAssignedDealers} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {assignedDealers.length === 0 ? (
          <EmptyState
            icon={<MapPin size={40} color={colors.textMuted} />}
            title="No dealers assigned today"
            subtitle="Your manager hasn't assigned any dealers for today yet."
          />
        ) : (
          assignedDealers.map((assignment, index) => (
            <FadeSlideIn key={assignment.id} delay={Math.min(index, 6) * 25}>
              <AssignedDealerCard
                assignment={assignment}
                estimatedDistanceKm={estimatedDistanceKmByDealerId[assignment.dealer_id] ?? null}
                preciseDistanceKm={preciseDistances[assignment.dealer_id]?.km ?? null}
                fetchingPreciseDistance={!!preciseDistances[assignment.dealer_id]?.loading}
                onNavigate={(a) => onSelectAssignment(a, navigation)}
                onRequestFollowup={setFollowupAssignment}
                onFetchAccurateDistance={coords ? handleFetchAccurateDistance : undefined}
              />
            </FadeSlideIn>
          ))
        )}
      </ScrollView>

      <FollowupRequestModal
        visible={!!followupAssignment}
        assignment={followupAssignment}
        onClose={() => setFollowupAssignment(null)}
        onSubmitted={() => setFollowupAssignment(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scrollContent: {
    padding: spacing.screenHorizontal,
    paddingBottom: spacing.xxxl,
  },
});
