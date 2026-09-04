import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, ScrollView, Pressable } from 'react-native';
import { Folder, Plus, Trash2, Check, X } from 'lucide-react-native';
import { useAppState } from '../src/context/AppStateContext';
import { showAlert } from '../src/services/themedAlert';
import { getFolders, syncFolders } from '../src/services/meetingApi';
import { AppHeader, LoadingCard, EmptyState, Card, FadeSlideIn, TextField, PrimaryButton } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

/**
 * Folder create/rename/delete — the backend's /sync-folders is a full
 * replace (whatever list is posted becomes the complete set for this
 * owner), so every mutation here edits the local `folders` array and then
 * posts the whole thing back, rather than a per-folder create/update/delete
 * endpoint.
 */
export default function MeetingFoldersScreen({ navigation }) {
  const { employee } = useAppState();
  const ownerId = String(employee?.id ?? '');

  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');

  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const fetchFolders = useCallback(async () => {
    if (!ownerId) return;
    try {
      const data = await getFolders(ownerId);
      if (!isMountedRef.current) return;
      setFolders(data);
    } catch (err) {
      console.error('Failed to fetch folders:', err);
      showAlert('Something went wrong', 'Could not load folders.');
    }
  }, [ownerId]);

  useEffect(() => {
    fetchFolders().finally(() => {
      if (isMountedRef.current) setLoading(false);
    });
  }, [fetchFolders]);

  const persist = async (nextFolders) => {
    setSaving(true);
    try {
      await syncFolders(ownerId, nextFolders.map((f) => ({ id: f.id, name: f.name, created_at: f.created_at })));
      if (isMountedRef.current) setFolders(nextFolders);
    } catch (err) {
      console.error('Failed to sync folders:', err);
      showAlert('Save failed', 'Could not save folder changes. Please try again.');
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  };

  const handleAdd = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const folder = { id: `folder-${Date.now().toString(36)}`, name, created_at: Date.now() };
    setNewFolderName('');
    persist([...folders, folder]);
  };

  const handleRename = (id) => {
    const name = editingName.trim();
    if (!name) return;
    setEditingId(null);
    persist(folders.map((f) => (f.id === id ? { ...f, name } : f)));
  };

  const handleDelete = (folder) => {
    showAlert('Delete folder', `Delete "${folder.name}"? Recordings inside it will not be deleted, just unfiled.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => persist(folders.filter((f) => f.id !== folder.id)) },
    ]);
  };

  return (
    <View style={styles.screen}>
      <AppHeader title="Folders" onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <FadeSlideIn>
          <Card style={{ marginBottom: spacing.cardGap }}>
            <View style={styles.addRow}>
              <TextField
                placeholder="New folder name"
                value={newFolderName}
                onChangeText={setNewFolderName}
                style={{ flex: 1 }}
              />
              <Pressable
                onPress={handleAdd}
                disabled={!newFolderName.trim() || saving}
                style={[styles.addButton, (!newFolderName.trim() || saving) && styles.addButtonDisabled]}
                accessibilityRole="button"
                accessibilityLabel="Add folder"
              >
                <Plus size={20} color={colors.textInverse} />
              </Pressable>
            </View>
          </Card>
        </FadeSlideIn>

        {loading && <LoadingCard message="Loading folders..." />}

        {!loading && folders.length === 0 && (
          <EmptyState icon={<Folder size={40} color={colors.textMuted} />} title="No folders yet" subtitle="Create one above to organize your recordings." />
        )}

        {!loading && folders.map((folder, index) => (
          <FadeSlideIn key={folder.id} delay={Math.min(index, 6) * 25}>
            <Card style={styles.folderCard}>
              {editingId === folder.id ? (
                <View style={styles.editRow}>
                  <TextField value={editingName} onChangeText={setEditingName} style={{ flex: 1 }} />
                  <Pressable onPress={() => handleRename(folder.id)} hitSlop={8} accessibilityLabel="Save name">
                    <Check size={20} color={colors.primary} />
                  </Pressable>
                  <Pressable onPress={() => setEditingId(null)} hitSlop={8} accessibilityLabel="Cancel rename">
                    <X size={20} color={colors.textMuted} />
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  style={styles.folderRow}
                  onPress={() => { setEditingId(folder.id); setEditingName(folder.name); }}
                >
                  <Folder size={18} color={colors.primary} style={{ marginRight: spacing.sm }} />
                  <Text style={styles.folderName} numberOfLines={1}>{folder.name}</Text>
                  <Pressable onPress={() => handleDelete(folder)} hitSlop={8} accessibilityLabel="Delete folder">
                    <Trash2 size={18} color={colors.textMuted} />
                  </Pressable>
                </Pressable>
              )}
            </Card>
          </FadeSlideIn>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  addButton: {
    width: 48, height: 48, borderRadius: 12, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  addButtonDisabled: { backgroundColor: colors.disabled },
  folderCard: { marginBottom: spacing.sm },
  folderRow: { flexDirection: 'row', alignItems: 'center' },
  folderName: { ...typography.body, color: colors.text, flex: 1 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
