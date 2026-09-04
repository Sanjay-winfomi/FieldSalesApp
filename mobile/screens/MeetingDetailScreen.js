import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, ScrollView, Pressable, PanResponder } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { FileText, Sparkles, Clock, Music, Play, Pause, Square } from 'lucide-react-native';
import { getRecordingStatus, getAudioLink } from '../src/services/meetingApi';
import { showAlert } from '../src/services/themedAlert';
import { AppHeader, LoadingCard, EmptyState, Card, FadeSlideIn, SecondaryButton } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

const POLL_INTERVAL_MS = 5000;

function formatSeconds(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

const PLAYBACK_RATES = [1, 1.5, 2, 0.5];

/** Tap-or-drag seek track. Reports fractional progress (0-1) via onSeek,
 * only once the touch is released — matches how most audio players commit
 * a seek at gesture-end rather than scrubbing the actual playback position
 * on every pixel of movement. */
function SeekBar({ progress, onSeek }) {
  const widthRef = useRef(0);
  const [dragX, setDragX] = useState(null);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => setDragX(evt.nativeEvent.locationX),
      onPanResponderMove: (evt) => setDragX(evt.nativeEvent.locationX),
      onPanResponderRelease: (evt) => {
        const width = widthRef.current;
        if (width > 0) {
          const x = Math.max(0, Math.min(evt.nativeEvent.locationX, width));
          onSeek(x / width);
        }
        setDragX(null);
      },
      onPanResponderTerminate: () => setDragX(null),
    })
  ).current;

  const width = widthRef.current;
  const fraction = dragX !== null && width > 0 ? Math.max(0, Math.min(dragX / width, 1)) : progress;

  return (
    <View
      style={styles.seekTrack}
      onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width; }}
      {...panResponder.panHandlers}
    >
      <View style={styles.seekTrackBg} />
      <View style={[styles.seekTrackFill, { width: `${fraction * 100}%` }]} />
      <View style={[styles.seekThumb, { left: `${fraction * 100}%` }]} />
    </View>
  );
}

/** In-app audio player — plays straight from the presigned S3 URL, no
 * jumping out to the browser. `url` starts null; useAudioPlayer accepts
 * that and swaps in the real source (recreating its underlying player)
 * once resolved, so this can be mounted immediately rather than only after
 * the link is ready. */
function AudioPlayerBar({ url }) {
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const [rateIndex, setRateIndex] = useState(0);

  // Autoplay the moment a real source is loaded — matches the "tap to
  // listen" expectation the old Linking.openURL button set.
  useEffect(() => {
    if (url) player.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const handleSeek = (fraction) => {
    if (!status.duration) return;
    player.seekTo(fraction * status.duration);
  };

  const handleStop = () => {
    player.pause();
    player.seekTo(0);
  };

  const handleCycleRate = () => {
    const nextIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(nextIndex);
    player.setPlaybackRate(PLAYBACK_RATES[nextIndex]);
  };

  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;

  return (
    <View>
      <SeekBar progress={progress} onSeek={handleSeek} />

      <View style={styles.playerBar}>
        <Pressable
          onPress={() => (status.playing ? player.pause() : player.play())}
          style={styles.playButton}
          accessibilityRole="button"
          accessibilityLabel={status.playing ? 'Pause' : 'Play'}
        >
          {status.playing ? <Pause size={20} color={colors.textInverse} /> : <Play size={20} color={colors.textInverse} />}
        </Pressable>

        <Pressable
          onPress={handleStop}
          style={styles.stopButton}
          accessibilityRole="button"
          accessibilityLabel="Stop"
        >
          <Square size={16} color={colors.textSecondary} />
        </Pressable>

        <Text style={styles.playerTime}>{formatSeconds(status.currentTime)} / {formatSeconds(status.duration)}</Text>

        <Pressable
          onPress={handleCycleRate}
          style={styles.speedButton}
          accessibilityRole="button"
          accessibilityLabel="Change playback speed"
        >
          <Text style={styles.speedButtonText}>{PLAYBACK_RATES[rateIndex]}x</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function MeetingDetailScreen({ navigation, route }) {
  const { sessionId, title } = route.params;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Whether the audio link is currently being resolved — generating a
  // presigned S3 URL is a real network call (see getAudioLink), so this
  // resolves lazily (on tap) rather than eagerly for a recording the rep
  // may never play. Once resolved, audioUrl feeds AudioPlayerBar directly —
  // playback happens in-app now, not by handing off to the browser.
  const [openingLink, setOpeningLink] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);

  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await getRecordingStatus(sessionId);
      if (!isMountedRef.current) return;
      setData(res);
      setError('');
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Failed to fetch recording status:', err);
      setError('Could not load this recording.');
    }
  }, [sessionId]);

  useEffect(() => {
    fetchStatus().finally(() => {
      if (isMountedRef.current) setLoading(false);
    });
  }, [fetchStatus]);

  useEffect(() => {
    if (data?.processing_status !== 'processing') return;
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [data?.processing_status, fetchStatus]);

  const handleLoadAudio = async (fileId) => {
    setOpeningLink(true);
    try {
      const url = await getAudioLink(fileId);
      if (isMountedRef.current) setAudioUrl(url);
    } catch (err) {
      console.error('Failed to load audio recording:', err);
      showAlert('Could not load audio', 'Please try again in a moment.');
    } finally {
      if (isMountedRef.current) setOpeningLink(false);
    }
  };

  return (
    <View style={styles.screen}>
      <AppHeader title={title || data?.recording_name || 'Recording'} onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {loading && <LoadingCard message="Loading recording..." />}

        {!loading && !!error && (
          <EmptyState icon={<FileText size={40} color={colors.textMuted} />} title="Something went wrong" subtitle={error} />
        )}

        {!loading && !error && data && (
          <>
            {data.processing_status === 'processing' && (
              <FadeSlideIn>
                <Card style={styles.statusCard}>
                  <Clock size={18} color={colors.warningDark} style={{ marginRight: spacing.sm }} />
                  <Text style={styles.statusText}>Transcribing this recording — this can take a few minutes.</Text>
                </Card>
              </FadeSlideIn>
            )}

            {data.processing_status === 'failed' && (
              <FadeSlideIn>
                <Card style={[styles.statusCard, { backgroundColor: colors.dangerLight }]}>
                  <Text style={[styles.statusText, { color: colors.dangerDark }]}>
                    Transcription failed for this recording.
                  </Text>
                </Card>
              </FadeSlideIn>
            )}

            {!!data.summary && data.summary_status === 'success' && (
              <FadeSlideIn delay={40}>
                <Card style={{ marginBottom: spacing.cardGap }}>
                  <View style={styles.sectionHeader}>
                    <Sparkles size={16} color={colors.primary} />
                    <Text style={styles.sectionTitle}>Summary</Text>
                  </View>
                  <Text style={styles.bodyText}>{data.summary}</Text>
                </Card>
              </FadeSlideIn>
            )}

            {!!data.transcript_text && (
              <FadeSlideIn delay={80}>
                <Card>
                  <View style={styles.sectionHeader}>
                    <FileText size={16} color={colors.primary} />
                    <Text style={styles.sectionTitle}>Transcript</Text>
                  </View>
                  <Text style={styles.bodyText}>{data.transcript_text}</Text>
                </Card>
              </FadeSlideIn>
            )}

            {!!data.audio_file_id && (
              <FadeSlideIn delay={100}>
                <Card style={{ marginTop: spacing.cardGap }}>
                  <Text style={styles.sectionTitleStandalone}>Audio Recording</Text>
                  {audioUrl ? (
                    <AudioPlayerBar url={audioUrl} />
                  ) : (
                    <SecondaryButton
                      title="Play recording"
                      icon={<Music size={18} color={colors.primary} />}
                      onPress={() => handleLoadAudio(data.audio_file_id)}
                      loading={openingLink}
                      disabled={openingLink}
                    />
                  )}
                </Card>
              </FadeSlideIn>
            )}

            {data.processing_status === 'success' && !data.transcript_text && (
              <EmptyState
                icon={<FileText size={40} color={colors.textMuted} />}
                title="No speech detected"
                subtitle="This recording finished processing but no transcript was produced."
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  statusCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.warningLight, marginBottom: spacing.cardGap },
  statusText: { ...typography.body, color: colors.warningDark, flex: 1 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  sectionTitle: { ...typography.body, fontWeight: '700', color: colors.text, marginLeft: spacing.xs },
  sectionTitleStandalone: { ...typography.body, fontWeight: '700', color: colors.text, marginBottom: spacing.md },
  bodyText: { ...typography.body, color: colors.text, lineHeight: 22 },
  playerBar: { flexDirection: 'row', alignItems: 'center' },
  playButton: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm,
  },
  stopButton: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.neutralBg,
    alignItems: 'center', justifyContent: 'center', marginRight: spacing.md,
  },
  playerTime: { ...typography.body, color: colors.textSecondary, fontVariant: ['tabular-nums'], flex: 1 },
  speedButton: {
    paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: 999,
    backgroundColor: colors.neutralBg,
  },
  speedButtonText: { ...typography.caption, color: colors.text, fontWeight: '700' },
  // A generous vertical hit area around the visible 4px track makes the
  // thumb easy to grab on a phone screen without widening the track itself.
  seekTrack: {
    height: 28, justifyContent: 'center', marginBottom: spacing.sm,
  },
  seekTrackBg: {
    position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2,
    backgroundColor: colors.border,
  },
  seekTrackFill: {
    position: 'absolute', left: 0, height: 4, borderRadius: 2,
    backgroundColor: colors.primary,
  },
  seekThumb: {
    position: 'absolute', width: 14, height: 14, borderRadius: 7,
    backgroundColor: colors.primary, marginLeft: -7,
  },
});
