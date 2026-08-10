import React, { useEffect, useState } from 'react';
import { StyleSheet, View, ScrollView, RefreshControl } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { useAppState } from '../src/context/AppStateContext';
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

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', fetchAssignedDealers);
    return unsubscribe;
  }, [navigation, fetchAssignedDealers]);

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
          <FadeSlideIn>
            {assignedDealers.map((assignment) => (
              <AssignedDealerCard
                key={assignment.id}
                assignment={assignment}
                onNavigate={(a) => onSelectAssignment(a, navigation)}
                onRequestFollowup={setFollowupAssignment}
              />
            ))}
          </FadeSlideIn>
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
