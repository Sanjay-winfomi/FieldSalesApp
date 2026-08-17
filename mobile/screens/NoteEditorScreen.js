import React, { useState, useEffect, useCallback, useRef } from 'react';
import { StyleSheet, Text, View, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Trash2 } from 'lucide-react-native';
import { api } from '../src/services/api';
import { enqueueAction, isNetworkError } from '../src/services/syncManager';
import { showAlert } from '../src/services/themedAlert';
import { getErrorMessage } from '../src/services/apiError';
import { AppHeader, PrimaryButton, LoadingCard, FadeSlideIn } from '../src/components';
import { colors, typography, spacing, serifFontFamily } from '../src/theme';

const MIN_CONTENT_LENGTH = 100;

/**
 * Notepad-style note editor — shared between "new note" (no noteId in route
 * params) and "edit existing note" (noteId present). Body text always
 * renders in Times New Roman (serif on Android, where that exact face isn't
 * bundled) regardless of the rest of the app's system font, and Save stays
 * disabled until the 100-character minimum — enforced again server-side — is met.
 */
// A killed-and-restarted process (an OS-level background kill, not a JS
// crash — see visitForegroundService.js/miui.js for the actual mitigation
// for that) would otherwise lose whatever the rep was mid-typing, since
// nothing below the 100-character minimum ever reaches the server. Keyed by
// noteId (or 'new') so an in-progress edit and an in-progress new note never
// collide, and multiple existing notes each keep their own draft.
const draftKey = (noteId) => `@note_draft_${noteId || 'new'}`;

export default function NoteEditorScreen({ navigation, route }) {
  const noteId = route?.params?.noteId;
  const isEditing = !!noteId;

  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Guards every post-await setState against one of these resolving after
  // the rep has already navigated away (see NotesScreen.js for the same
  // pattern/reasoning).
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const fetchNote = useCallback(async () => {
    try {
      const res = await api.get(`/notes/${noteId}`);
      if (!isMountedRef.current) return;
      setContent(res.data.note.content);
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Failed to fetch note:', err);
      showAlert('Error', 'Could not load this note.');
      navigation.goBack();
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [noteId, navigation]);

  useEffect(() => {
    // Restoring the draft after the server fetch (rather than instead of
    // it) means editing an existing note still shows the real server
    // content immediately, then swaps in any unsaved local edits a moment
    // later — same order a kill-and-restart would have happened in.
    const restoreDraft = async () => {
      try {
        const draft = await AsyncStorage.getItem(draftKey(noteId));
        if (draft && isMountedRef.current) setContent(draft);
      } catch {
        // Best-effort — a missing/corrupt draft just means nothing to restore.
      }
    };
    (async () => {
      if (isEditing) await fetchNote();
      await restoreDraft();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, fetchNote, noteId]);

  // Debounced autosave — writes on every pause in typing, not every
  // keystroke, so a kill mid-sentence loses at most a moment's typing
  // instead of everything since the screen opened.
  const draftSaveTimerRef = useRef(null);
  useEffect(() => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      if (content.trim().length > 0) {
        AsyncStorage.setItem(draftKey(noteId), content).catch(() => {});
      }
    }, 800);
    return () => clearTimeout(draftSaveTimerRef.current);
  }, [content, noteId]);

  const clearDraft = () => AsyncStorage.removeItem(draftKey(noteId)).catch(() => {});

  const handleBack = () => {
    // A deliberate back-out reads as "I'm done with this" — clearing here
    // (rather than only on save) means an abandoned draft doesn't
    // resurface and surprise the rep the next time they open a new note.
    clearDraft();
    navigation.goBack();
  };

  const trimmedLength = content.trim().length;
  const canSave = trimmedLength >= MIN_CONTENT_LENGTH && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (isEditing) {
        await api.put(`/notes/${noteId}`, { content });
      } else {
        await api.post('/notes', { content });
      }
      clearDraft();
      navigation.goBack();
    } catch (err) {
      if (isNetworkError(err)) {
        // Offline — queue the write instead of losing what was typed. A
        // create has no server id to reference later, so nothing downstream
        // depends on it; an edit already has the real noteId, so the queued
        // PUT can target it directly once connectivity returns.
        await enqueueAction(isEditing ? 'put' : 'post', isEditing ? `/notes/${noteId}` : '/notes', { content });
        clearDraft(); // safely queued — the offline sync queue is now the durable copy, not this draft
        if (!isMountedRef.current) return;
        showAlert('Offline Mode', 'Note saved locally and will sync when online.');
        navigation.goBack();
        return;
      }
      if (!isMountedRef.current) return;
      const serverError = err.response?.data?.error;
      if (serverError === 'content_too_short') {
        showAlert('Note too short', `Notes need at least ${MIN_CONTENT_LENGTH} characters.`);
      } else {
        console.error('Failed to save note:', err);
        showAlert('Error', getErrorMessage(err, 'Could not save this note. Please try again.'));
      }
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  };

  const handleDelete = () => {
    showAlert('Delete note', 'Are you sure you want to delete this note?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try {
            await api.delete(`/notes/${noteId}`);
            clearDraft();
            if (!isMountedRef.current) return;
            navigation.goBack();
          } catch (err) {
            if (!isMountedRef.current) return;
            if (isNetworkError(err)) {
              await enqueueAction('delete', `/notes/${noteId}`);
              clearDraft();
              if (!isMountedRef.current) return;
              showAlert('Offline Mode', 'Delete saved locally and will sync when online.');
              navigation.goBack();
              return;
            }
            console.error('Failed to delete note:', err);
            showAlert('Error', getErrorMessage(err, 'Could not delete this note.'));
            setDeleting(false);
          }
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AppHeader
        title={isEditing ? 'Edit note' : 'New note'}
        onBack={handleBack}
        rightAction={
          isEditing ? (
            <Pressable
              onPress={handleDelete}
              disabled={deleting}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Delete note"
            >
              {deleting ? (
                <ActivityIndicator size="small" color={colors.danger} />
              ) : (
                <Trash2 size={20} color={colors.danger} />
              )}
            </Pressable>
          ) : null
        }
      />

      {loading ? (
        <LoadingCard message="Loading note..." />
      ) : (
        <>
          <TextInput
            style={styles.editor}
            multiline
            autoFocus={!isEditing}
            value={content}
            onChangeText={setContent}
            placeholder="Start writing..."
            placeholderTextColor={colors.textMuted}
            textAlignVertical="top"
          />

          <FadeSlideIn style={styles.footer}>
            <Text style={[styles.counter, trimmedLength < MIN_CONTENT_LENGTH && styles.counterShort]}>
              {trimmedLength} / {MIN_CONTENT_LENGTH} characters minimum
            </Text>
            <PrimaryButton title="Save note" onPress={handleSave} disabled={!canSave} loading={saving} />
          </FadeSlideIn>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  editor: {
    flex: 1,
    fontFamily: serifFontFamily,
    fontSize: 17,
    lineHeight: 24,
    color: colors.text,
    padding: spacing.screenHorizontal,
    textAlignVertical: 'top',
  },
  footer: {
    padding: spacing.screenHorizontal,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  counter: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.md,
    textAlign: 'right',
  },
  counterShort: {
    color: colors.dangerDark,
    fontWeight: '600',
  },
});
