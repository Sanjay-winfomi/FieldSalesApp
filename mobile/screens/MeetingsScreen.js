import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl, Pressable, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Mic, Plus, FolderOpen, ChevronRight, Trash2, Folder } from 'lucide-react-native';
import { useAppState } from '../src/context/AppStateContext';
import { showAlert } from '../src/services/themedAlert';
import { getRecordings, getFolders, deleteRecording } from '../src/services/meetingApi';
import { LoadingCard, EmptyState, FadeSlideIn, Card, SearchBar } from '../src/components';
import { colors, typography, spacing, radius, shadows } from '../src/theme';

// Same relative-to-screen-width decorative glow used by HomeScreen/ProfileScreen's
// own gradient headers, so this tab's header reads as the same design system
// rather than a bolted-on plain white bar.
const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Any status other than these still-in-flight ones is treated as terminal
// for polling purposes — matches the backend's own set_db_status values
// (processing/success/failed), plus the initial row /start-processing
// writes before the pipeline has picked it up.
const IN_PROGRESS_STATUSES = ['processing'];
const POLL_INTERVAL_MS = 10000;

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function StatusPill({ status }) {
  const config = {
    processing: { label: 'Processing', bg: colors.warningLight, text: colors.warningDark },
    success: { label: 'Ready', bg: colors.successLight, text: colors.successDark },
    failed: { label: 'Failed', bg: colors.dangerLight, text: colors.dangerDark },
  }[status] || { label: status || 'Unknown', bg: colors.neutralBg, text: colors.textSecondary };

  return (
    <View style={[pillStyles.pill, { backgroundColor: config.bg }]}>
      <Text style={[pillStyles.text, { color: config.text }]}>{config.label}</Text>
    </View>
  );
}

const pillStyles = StyleSheet.create({
  pill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  text: { fontSize: 11, fontWeight: '700' },
});

export default function MeetingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { employee } = useAppState();
  const ownerId = String(employee?.id ?? '');

  const [recordings, setRecordings] = useState([]);
  const [folders, setFolders] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState(null); // null = All
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const fetchAll = useCallback(async (query) => {
    if (!ownerId) return;
    try {
      const [recData, folderData] = await Promise.all([
        getRecordings(ownerId, query),
        getFolders(ownerId),
      ]);
      if (!isMountedRef.current) return;
      setRecordings(recData);
      setFolders(folderData);
      setError('');
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Failed to fetch meetings:', err);
      setError('Could not load recordings.');
    }
  }, [ownerId]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setLoading(true);
      fetchAll(searchQuery).finally(() => {
        if (isMountedRef.current) setLoading(false);
      });
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, fetchAll]);

  // Debounced search-as-you-type — refetches from the backend's own
  // full-text search rather than filtering the already-loaded page client-side.
  useEffect(() => {
    const timer = setTimeout(() => fetchAll(searchQuery), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Polls while anything is still processing, so a recording started here
  // (or on another device under the same account) flips to Ready/Failed
  // without the rep having to pull-to-refresh.
  useEffect(() => {
    const hasInProgress = recordings.some((r) => IN_PROGRESS_STATUSES.includes(r.processing_status));
    if (!hasInProgress) return;
    const interval = setInterval(() => fetchAll(searchQuery), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordings, searchQuery]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchAll(searchQuery);
    if (isMountedRef.current) setRefreshing(false);
  };

  const handleDelete = (recording) => {
    showAlert('Delete recording', `Delete "${recording.recording_name || 'Untitled Recording'}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteRecording(recording.id);
            setRecordings((prev) => prev.filter((r) => r.id !== recording.id));
          } catch (err) {
            console.error('Failed to delete recording:', err);
            showAlert('Delete failed', 'Could not delete this recording. Please try again.');
          }
        },
      },
    ]);
  };

  const visibleRecordings = selectedFolderId === null
    ? recordings
    : recordings.filter((r) => r.ui_folder_id === selectedFolderId);

  // Meetings is a bottom-tab screen, but Record/Folders/Detail are pushed on
  // the root Stack (same pattern ProfileScreen uses for About/MiuiOnboarding)
  // so they cover the tab bar instead of appearing nested inside it.
  const rootNavigation = navigation.getParent() || navigation;

  return (
    <View style={styles.screen}>
      <View style={styles.headerShadowWrap}>
        <LinearGradient
          colors={colors.gradientHeader}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.header, { paddingTop: insets.top + 16 }]}
        >
          <View style={styles.headerGlow} pointerEvents="none" />
          <View style={styles.headerRow}>
            <Text style={styles.title}>Meetings</Text>
            <Pressable
              onPress={() => rootNavigation.navigate('MeetingFolders')}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Manage folders"
              style={styles.headerIconButton}
            >
              <FolderOpen size={20} color={colors.text} />
            </Pressable>
          </View>

          <SearchBar value={searchQuery} onChangeText={setSearchQuery} placeholder="Search transcripts..." style={{ marginTop: spacing.md }} />
        </LinearGradient>
      </View>

      {folders.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}
        >
          <Pressable
            style={[styles.chip, selectedFolderId === null && styles.chipActive]}
            onPress={() => setSelectedFolderId(null)}
          >
            <Text style={[styles.chipText, selectedFolderId === null && styles.chipTextActive]}>All</Text>
          </Pressable>
          {folders.map((f) => (
            <Pressable
              key={f.id}
              style={[styles.chip, selectedFolderId === f.id && styles.chipActive]}
              onPress={() => setSelectedFolderId(f.id)}
            >
              <Folder size={13} color={selectedFolderId === f.id ? colors.textInverse : colors.textSecondary} style={{ marginRight: 4 }} />
              <Text style={[styles.chipText, selectedFolderId === f.id && styles.chipTextActive]}>{f.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && <LoadingCard message="Loading recordings..." />}

        {!loading && !!error && (
          <EmptyState icon={<Mic size={40} color={colors.textMuted} />} title="Something went wrong" subtitle={error} />
        )}

        {!loading && !error && visibleRecordings.length === 0 && (
          <EmptyState
            icon={<Mic size={40} color={colors.textMuted} />}
            title="No recordings yet"
            subtitle='Tap the mic button to record your first meeting.'
          />
        )}

        {!loading && visibleRecordings.map((rec, index) => (
          <FadeSlideIn key={rec.id} delay={Math.min(index, 6) * 25}>
            <Pressable onPress={() => rootNavigation.navigate('MeetingDetail', { sessionId: rec.id, title: rec.recording_name })}>
              <Card style={styles.recCard}>
                <View style={styles.recRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.recTitle} numberOfLines={1}>{rec.recording_name || 'Untitled Recording'}</Text>
                    <Text style={styles.recMeta}>{formatDate(rec.created_at)} · {rec.duration || '0:00'}</Text>
                    {!!rec.matched_snippet && (
                      <Text style={styles.recSnippet} numberOfLines={2}>{rec.matched_snippet.replace(/<\/?mark>/g, '')}</Text>
                    )}
                  </View>
                  <StatusPill status={rec.processing_status} />
                </View>
                <View style={styles.recFooter}>
                  <Pressable
                    onPress={() => handleDelete(rec)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Delete recording"
                  >
                    <Trash2 size={16} color={colors.textMuted} />
                  </Pressable>
                  <ChevronRight size={18} color={colors.textMuted} />
                </View>
              </Card>
            </Pressable>
          </FadeSlideIn>
        ))}
      </ScrollView>

      <Pressable
        style={styles.fab}
        onPress={() => rootNavigation.navigate('MeetingRecord', { folder: folders.find((f) => f.id === selectedFolderId) || null })}
        accessibilityRole="button"
        accessibilityLabel="Record a new meeting"
      >
        <Plus size={26} color={colors.textInverse} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // See HomeScreen.js's own headerShadowWrap comment: the shadow and the
  // overflow:hidden clip are split across two nested views on Android.
  headerShadowWrap: {
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
    ...shadows.raised,
  },
  header: {
    paddingHorizontal: spacing.screenHorizontal,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
    overflow: 'hidden',
    position: 'relative',
  },
  headerGlow: {
    position: 'absolute', top: -SCREEN_WIDTH * 0.13, right: -SCREEN_WIDTH * 0.1,
    width: SCREEN_WIDTH * 0.47, height: SCREEN_WIDTH * 0.47, borderRadius: SCREEN_WIDTH * 0.235,
    backgroundColor: 'rgba(34,197,94,0.14)',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...typography.sectionTitle, color: colors.text, fontSize: 22 },
  headerIconButton: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  chipsRow: { paddingHorizontal: spacing.screenHorizontal, paddingVertical: spacing.md, gap: spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, height: 32,
    borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    marginRight: spacing.sm,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...typography.caption, color: colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: colors.textInverse },
  listContainer: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl * 2 },
  recCard: { marginBottom: spacing.cardGap },
  recRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  recTitle: { ...typography.body, fontWeight: '700', color: colors.text },
  recMeta: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  recSnippet: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
  recFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  fab: {
    position: 'absolute', right: spacing.screenHorizontal, bottom: spacing.xl,
    width: 58, height: 58, borderRadius: 29, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', ...shadows.buttonPrimary,
  },
});
