import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable, Platform, ScrollView, Switch } from 'react-native';
import { Mic, Square, Trash2 } from 'lucide-react-native';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  AudioModule,
  setAudioModeAsync,
} from 'expo-audio';
import { useAppState } from '../src/context/AppStateContext';
import { getApproximateLocation } from '../src/services/location';
import { showAlert } from '../src/services/themedAlert';
import { getSasToken, uploadRecordingToBlob, startProcessing, deleteBlobDirect } from '../src/services/meetingApi';
import { AppHeader, PrimaryButton, SecondaryButton, TextField, Card, FadeSlideIn } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Opaque id for this recording's whole round trip (blob name, DB row,
// transcription job correlation) — doesn't need to be a real UUID, just
// unique enough per device/session, so a timestamp+random string avoids
// pulling in a uuid polyfill for RN/Hermes.
function generateSessionId() {
  return `mtg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function MeetingRecordScreen({ navigation, route }) {
  const { employee } = useAppState();
  const folder = route?.params?.folder || null;

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 100);

  const [permissionDenied, setPermissionDenied] = useState(false);
  const [hasStopped, setHasStopped] = useState(false);
  const [title, setTitle] = useState('');
  const [translateTanglish, setTranslateTanglish] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef(null);
  const sessionIdRef = useRef(generateSessionId());
  // Tracks whether the recorded chunk has already been uploaded to S3 —
  // only then does "Discard" need to also clean up the orphaned object via
  // deleteBlobDirect, rather than just dropping the local file.
  const uploadedFileNameRef = useRef(null);

  useEffect(() => {
    (async () => {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        setPermissionDenied(true);
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      startRecording();
    })();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecording = async () => {
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } catch (err) {
      console.error('Failed to start recording:', err);
      showAlert('Could not start recording', 'Please try again.');
    }
  };

  const handleStop = async () => {
    try {
      if (timerRef.current) clearInterval(timerRef.current);
      await recorder.stop();
      setHasStopped(true);
    } catch (err) {
      console.error('Failed to stop recording:', err);
      showAlert('Something went wrong', 'Failed to stop the recording.');
    }
  };

  const handleDiscard = async () => {
    if (uploadedFileNameRef.current) {
      try {
        await deleteBlobDirect(uploadedFileNameRef.current);
      } catch (err) {
        console.warn('Failed to clean up discarded blob:', err.message);
      }
    }
    navigation.goBack();
  };

  const handleSave = async () => {
    const uri = recorder.uri;
    if (!uri) {
      showAlert('No recording found', 'The recording could not be saved. Please try again.');
      return;
    }

    setSaving(true);
    // Tracks which step was in flight when something threw, so the alert can
    // say *where* it failed instead of a single generic "upload failed" that
    // could mean the SAS request, the actual blob PUT, or /start-processing.
    let step = 'requesting an upload URL';
    try {
      const sessionId = sessionIdRef.current;
      const extension = Platform.OS === 'ios' ? 'm4a' : 'm4a';
      const fileName = `${sessionId}_chunk1.${extension}`;

      const { url, sasToken } = await getSasToken(fileName);

      step = 'uploading the recording';
      await uploadRecordingToBlob(uri, url, sasToken, 'audio/m4a');
      uploadedFileNameRef.current = fileName;

      step = 'getting your location';
      const location = await getApproximateLocation();

      step = 'starting transcription';
      await startProcessing({
        recording_names: [fileName],
        title: title.trim() || 'Untitled Recording',
        session_id: sessionId,
        translate_tanglish: translateTanglish,
        owner_email: String(employee?.id ?? ''),
        device_os: Platform.OS,
        client_upload_time_ms: Date.now(),
        latitude: location?.lat ?? null,
        longitude: location?.lng ?? null,
        ui_folder_id: folder?.id ?? null,
        duration: elapsedSeconds,
      });

      navigation.replace('MeetingDetail', { sessionId, title: title.trim() || 'Untitled Recording' });
    } catch (err) {
      // err.response is axios-shaped (getSasToken/startProcessing); a plain
      // FileSystem.uploadAsync failure or network drop has neither, so this
      // falls back to err.message — always show something more specific
      // than the old blanket "check your connection" text.
      const detail = err?.response
        ? `Server responded ${err.response.status}: ${JSON.stringify(err.response.data)?.slice(0, 200)}`
        : err?.message || String(err);
      console.error(`Failed to save meeting recording while ${step}:`, err);
      showAlert('Upload failed', `Failed while ${step}.\n\n${detail}`);
    } finally {
      setSaving(false);
    }
  };

  if (permissionDenied) {
    return (
      <View style={styles.screen}>
        <AppHeader title="Record meeting" onBack={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Text style={typography.body}>
            Microphone access is required to record meetings. Please enable it in your device settings.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppHeader title="Record meeting" onBack={hasStopped ? undefined : () => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <FadeSlideIn>
          <Card style={styles.recordCard}>
            <View style={[styles.micCircle, recorderState.isRecording && styles.micCircleActive]}>
              <Mic size={40} color={recorderState.isRecording ? colors.danger : colors.primary} />
            </View>
            <Text style={styles.timer}>{formatElapsed(elapsedSeconds)}</Text>
            <Text style={styles.status}>
              {hasStopped ? 'Recording stopped' : recorderState.isRecording ? 'Recording...' : 'Preparing...'}
            </Text>

            {!hasStopped && (
              <SecondaryButton
                title="Stop recording"
                tone="danger"
                icon={<Square size={18} color={colors.danger} />}
                onPress={handleStop}
                style={{ marginTop: spacing.lg }}
              />
            )}
          </Card>
        </FadeSlideIn>

        {hasStopped && (
          <FadeSlideIn delay={60}>
            <Card style={{ marginTop: spacing.cardGap }}>
              <TextField
                label="Title"
                value={title}
                onChangeText={setTitle}
                placeholder="Untitled Recording"
              />

              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchLabel}>Translate Tanglish to English</Text>
                  <Text style={styles.switchHint}>Tamil speech is auto-translated regardless; this only affects mixed English/Tamil phrasing.</Text>
                </View>
                <Switch
                  value={translateTanglish}
                  onValueChange={setTranslateTanglish}
                  trackColor={{ false: colors.disabled, true: colors.primaryLight }}
                  thumbColor={translateTanglish ? colors.primary : undefined}
                />
              </View>

              {folder && (
                <Text style={styles.folderNote}>Will be saved to folder: {folder.name}</Text>
              )}

              <PrimaryButton
                title="Save & transcribe"
                onPress={handleSave}
                loading={saving}
                style={{ marginTop: spacing.lg }}
              />
              <SecondaryButton
                title="Discard"
                tone="danger"
                icon={<Trash2 size={18} color={colors.danger} />}
                onPress={handleDiscard}
                disabled={saving}
                style={{ marginTop: spacing.sm }}
              />
            </Card>
          </FadeSlideIn>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  recordCard: { alignItems: 'center', paddingVertical: spacing.xl },
  micCircle: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  micCircleActive: { backgroundColor: colors.dangerLight },
  timer: { ...typography.sectionTitle, fontSize: 32, color: colors.text, marginTop: spacing.lg },
  status: { ...typography.body, color: colors.textSecondary, marginTop: spacing.xs },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg,
    paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border,
  },
  switchLabel: { ...typography.body, fontWeight: '600', color: colors.text },
  switchHint: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  folderNote: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.md },
});
