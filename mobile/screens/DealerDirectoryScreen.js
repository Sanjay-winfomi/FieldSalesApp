import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Store, WifiOff } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../src/services/api';
import { useAppState } from '../src/context/AppStateContext';
import { SearchBar, DealerCard, EmptyState, FadeSlideIn } from '../src/components';
import { SkeletonCard } from '../src/components/loaders/Skeleton';
import { colors, typography, spacing } from '../src/theme';

// Cache the last successful (unfiltered) dealer list so the directory still
// shows something useful if the device is offline when the screen opens —
// without this, an offline rep sees an empty "No dealers found" and can't
// check in at any dealer at all, defeating the app's offline-first design.
const DEALER_CACHE_KEY = '@dealer_directory_cache';

export default function DealerDirectoryScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { visits, onSelectDealer } = useAppState();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null); // No dealer is selected by default
  const [dealers, setDealers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [usingCache, setUsingCache] = useState(false);
  // Sequences requests so a slower, stale response can't overwrite a newer
  // one if the user types quickly (each fetch checks it's still the latest).
  const requestSeqRef = useRef(0);

  const visitedDealerIds = useMemo(() => new Set(visits.map((v) => v.dealer_id)), [visits]);

  const fetchDealers = async (query = '') => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const response = await api.get('/dealers', {
        params: { search: query }
      });
      if (seq !== requestSeqRef.current) return; // a newer request has since started
      const list = response.data.dealers || [];
      setDealers(list);
      setUsingCache(false);
      if (!query) {
        AsyncStorage.setItem(DEALER_CACHE_KEY, JSON.stringify(list)).catch(() => {});
      }
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      console.error('Error fetching dealers:', error);
      if (!query) {
        try {
          const cached = await AsyncStorage.getItem(DEALER_CACHE_KEY);
          if (cached) {
            setDealers(JSON.parse(cached));
            setUsingCache(true);
          }
        } catch (cacheErr) {
          console.error('Error reading cached dealers:', cacheErr);
        }
      }
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchDealers(searchQuery);
    setRefreshing(false);
  };

  // Debounce search — skips firing on the very first render (searchQuery
  // starts as ''), since the focus-refetch effect below already covers the
  // initial load as soon as the tab gains focus.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const delayDebounceFn = setTimeout(() => {
      fetchDealers(searchQuery);
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery]);

  // Refetch whenever the Dealers tab regains focus (e.g. after a manager adds
  // a dealer, or the rep returns from a check-in) — otherwise the list only
  // ever reflected whatever was fetched the last time the tab mounted.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      fetchDealers(searchQuery);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation]);

  const handleCardPress = (dealer) => {
    const isSelected = dealer.id === selectedId;
    if (isSelected) {
      onSelectDealer(dealer, true, navigation);
    } else {
      setSelectedId(dealer.id);
      onSelectDealer(dealer, false, navigation);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.title}>Dealer directory</Text>
        <SearchBar value={searchQuery} onChangeText={setSearchQuery} placeholder="Search dealers" />
      </View>

      <ScrollView
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {usingCache && (
          <View style={styles.offlineBanner}>
            <WifiOff size={14} color={colors.warningDark} style={{ marginRight: 8 }} />
            <Text style={styles.offlineBannerText}>Offline — showing last saved dealer list</Text>
          </View>
        )}

        {loading && !refreshing && dealers.length === 0 && (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        )}

        {!loading && dealers.length === 0 && (
          <EmptyState
            icon={<Store size={40} color={colors.textMuted} />}
            title="No dealers found"
            subtitle={searchQuery ? 'Try a different search term.' : 'Dealers added by your manager will appear here.'}
          />
        )}

        {dealers.map((dealer, index) => (
          <FadeSlideIn key={dealer.id} delay={Math.min(index, 6) * 30}>
            <DealerCard
              dealer={dealer}
              selected={dealer.id === selectedId}
              visited={visitedDealerIds.has(dealer.id)}
              onPress={() => handleCardPress(dealer)}
            />
          </FadeSlideIn>
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
  title: {
    ...typography.sectionTitle,
    color: colors.text,
    fontSize: 22,
    marginBottom: spacing.md,
  },
  listContainer: {
    padding: spacing.screenHorizontal,
    paddingBottom: spacing.xxxl,
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warningLight,
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.cardGap,
  },
  offlineBannerText: {
    ...typography.caption,
    color: colors.warningDark,
    fontWeight: '600',
    flex: 1,
  },
});
