import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, ScrollView, Linking } from 'react-native';
import { FileText, Sparkles, Clock, Music } from 'lucide-react-native';
import { getRecordingStatus, getAudioLink } from '../src/services/meetingApi';
import { showAlert } from '../src/services/themedAlert';
import { AppHeader, LoadingCard, EmptyState, Card, FadeSlideIn, SecondaryButton } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

const POLL_INTERVAL_MS = 5000;

export default function MeetingDetailScreen({ navigation, route }) {
  const { sessionId, title } = route.params;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Whether the audio link is currently being resolved — generating a
  // presigned S3 URL is a real network call (see getAudioLink), so the
  // button shows its own loading state rather than resolving eagerly for a
  // recording the rep may never tap.
  const [openingLink, setOpeningLink] = useState(false);

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

  const handleOpenAudio = async (fileId) => {
    setOpeningLink(true);
    try {
      const url = await getAudioLink(fileId);
      await Linking.openURL(url);
    } catch (err) {
      console.error('Failed to open audio recording:', err);
      showAlert('Could not open file', 'Please try again in a moment.');
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
                  <SecondaryButton
                    title="Open audio recording"
                    icon={<Music size={18} color={colors.primary} />}
                    onPress={() => handleOpenAudio(data.audio_file_id)}
                    loading={openingLink}
                    disabled={openingLink}
                  />
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
});
