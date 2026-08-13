import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, Text, View, ScrollView, RefreshControl, Pressable } from 'react-native';
import { Plus, NotebookPen, ChevronRight } from 'lucide-react-native';
import { api } from '../src/services/api';
import { AppHeader, LoadingCard, EmptyState, FadeSlideIn, Card } from '../src/components';
import { colors, typography, spacing, serifFontFamily } from '../src/theme';

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function preview(content) {
  // A malformed API record or stale cache entry could hand this a
  // null/undefined content — without the fallback, .split() throws and
  // crashes the whole list render instead of just showing an empty preview.
  const firstLine = (content || '').split('\n')[0];
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

export default function NotesScreen({ navigation }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const fetchNotes = useCallback(async () => {
    try {
      const res = await api.get('/notes');
      setNotes(res.data.notes || []);
      setError('');
    } catch (err) {
      console.error('Failed to fetch notes:', err);
      setError('Could not load notes.');
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setLoading(true);
      fetchNotes().finally(() => setLoading(false));
    });
    return unsubscribe;
  }, [navigation, fetchNotes]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchNotes();
    setRefreshing(false);
  };

  return (
    <View style={styles.screen}>
      <AppHeader
        title="Notes"
        onBack={() => navigation.goBack()}
        rightAction={
          <Pressable
            onPress={() => navigation.navigate('NoteEditor', {})}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="New note"
          >
            <Plus size={22} color={colors.primary} />
          </Pressable>
        }
      />

      <ScrollView
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && <LoadingCard message="Loading notes..." />}

        {!loading && !!error && (
          <EmptyState icon={<NotebookPen size={40} color={colors.textMuted} />} title="Something went wrong" subtitle={error} />
        )}

        {!loading && !error && notes.length === 0 && (
          <EmptyState
            icon={<NotebookPen size={40} color={colors.textMuted} />}
            title="No notes yet"
            subtitle='Tap "+" to write your first note.'
          />
        )}

        {!loading && notes.map((note, index) => (
          <FadeSlideIn key={note.id} delay={Math.min(index, 6) * 25}>
            <Pressable onPress={() => navigation.navigate('NoteEditor', { noteId: note.id })}>
              <Card style={styles.noteCard}>
                <View style={styles.noteRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.notePreview} numberOfLines={2}>{preview(note.content)}</Text>
                    <Text style={styles.noteDate}>{formatDate(note.updated_at)}</Text>
                  </View>
                  <ChevronRight size={18} color={colors.textMuted} />
                </View>
              </Card>
            </Pressable>
          </FadeSlideIn>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  listContainer: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  noteCard: { marginBottom: spacing.cardGap },
  noteRow: { flexDirection: 'row', alignItems: 'center' },
  notePreview: { ...typography.body, fontFamily: serifFontFamily, color: colors.text },
  noteDate: { ...typography.caption, color: colors.textMuted, marginTop: 4 },
});
