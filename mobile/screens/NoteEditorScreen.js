import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, Text, View, TextInput, Alert, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { api } from '../src/services/api';
import { enqueueAction, isNetworkError } from '../src/services/syncManager';
import { AppHeader, PrimaryButton, LoadingCard } from '../src/components';
import { colors, typography, spacing, serifFontFamily } from '../src/theme';

const MIN_CONTENT_LENGTH = 100;

/**
 * Notepad-style note editor — shared between "new note" (no noteId in route
 * params) and "edit existing note" (noteId present). Body text always
 * renders in Times New Roman (serif on Android, where that exact face isn't
 * bundled) regardless of the rest of the app's system font, and Save stays
 * disabled until the 100-character minimum — enforced again server-side — is met.
 */
export default function NoteEditorScreen({ navigation, route }) {
  const noteId = route?.params?.noteId;
  const isEditing = !!noteId;

  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchNote = useCallback(async () => {
    try {
      const res = await api.get(`/notes/${noteId}`);
      setContent(res.data.note.content);
    } catch (err) {
      console.error('Failed to fetch note:', err);
      Alert.alert('Error', 'Could not load this note.');
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }, [noteId, navigation]);

  useEffect(() => {
    if (isEditing) fetchNote();
  }, [isEditing, fetchNote]);

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
      navigation.goBack();
    } catch (err) {
      const serverError = err.response?.data?.error;
      if (serverError === 'content_too_short') {
        Alert.alert('Note too short', `Notes need at least ${MIN_CONTENT_LENGTH} characters.`);
      } else {
        console.error('Failed to save note:', err);
        Alert.alert('Error', 'Could not save this note. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    Alert.alert('Delete note', 'Are you sure you want to delete this note?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try {
            await api.delete(`/notes/${noteId}`);
            navigation.goBack();
          } catch (err) {
            if (isNetworkError(err)) {
              await enqueueAction('delete', `/notes/${noteId}`);
              Alert.alert('Offline Mode', 'Delete saved locally and will sync when online.');
              navigation.goBack();
              return;
            }
            console.error('Failed to delete note:', err);
            Alert.alert('Error', 'Could not delete this note.');
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
        onBack={() => navigation.goBack()}
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

          <View style={styles.footer}>
            <Text style={[styles.counter, trimmedLength < MIN_CONTENT_LENGTH && styles.counterShort]}>
              {trimmedLength} / {MIN_CONTENT_LENGTH} characters minimum
            </Text>
            <PrimaryButton title="Save note" onPress={handleSave} disabled={!canSave} loading={saving} />
          </View>
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
