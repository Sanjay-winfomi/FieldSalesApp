import React, { useState, useEffect, useRef } from 'react';
import { Modal, View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Store } from 'lucide-react-native';
import { api } from '../services/api';
import SearchBar from './inputs/SearchBar';
import EmptyState from './EmptyState';
import { SkeletonCard } from './loaders/Skeleton';
import { colors, typography, spacing, radius } from '../theme';

/**
 * Full-screen modal dealer picker — same api.get('/dealers', { search })
 * fetch pattern as DealerDirectoryScreen, but as a lightweight searchable
 * list rather than the full check-in-oriented dealer directory, since it's
 * only used here to pick a dealer for a reminder.
 */
export default function DealerPickerModal({ visible, onClose, onSelect }) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [dealers, setDealers] = useState([]);
  const [loading, setLoading] = useState(false);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (!visible) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    api.get('/dealers', { params: { search: query } })
      .then((res) => {
        if (seq !== requestSeqRef.current) return;
        setDealers(res.data.dealers || []);
      })
      .catch((err) => {
        if (seq !== requestSeqRef.current) return;
        console.error('Failed to fetch dealers:', err);
        setDealers([]);
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setLoading(false);
      });
  }, [visible, query]);

  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Select dealer</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <X size={22} color={colors.text} />
          </Pressable>
        </View>

        <SearchBar value={query} onChangeText={setQuery} placeholder="Search dealers" style={styles.searchBar} />

        {loading && dealers.length === 0 && (
          <View style={styles.listPadding}>
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {!loading && dealers.length === 0 && (
          <EmptyState
            icon={<Store size={40} color={colors.textMuted} />}
            title="No dealers found"
            subtitle={query ? 'Try a different search term.' : 'Dealers added by your manager will appear here.'}
          />
        )}

        <FlatList
          data={dealers}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.listPadding}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => onSelect(item)}
              accessibilityRole="button"
              accessibilityLabel={item.name}
            >
              <Text style={styles.rowTitle} numberOfLines={1}>{item.name}</Text>
              {!!item.address && <Text style={styles.rowSubtitle} numberOfLines={1}>{item.address}</Text>}
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.screenHorizontal,
    paddingBottom: spacing.md,
  },
  title: { ...typography.cardTitle, color: colors.text },
  searchBar: { marginHorizontal: spacing.screenHorizontal, marginBottom: spacing.md },
  listPadding: { paddingHorizontal: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  row: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.input,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowTitle: { ...typography.cardTitle, fontSize: 16, color: colors.text },
  rowSubtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
});
