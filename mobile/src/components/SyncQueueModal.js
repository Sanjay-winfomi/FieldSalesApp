import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, RefreshCw, Trash2 } from 'lucide-react-native';
import { getQueueSnapshot, removeQueuedAction, flushQueue, getPendingCount } from '../services/syncManager';
import { showAlert } from '../services/themedAlert';
import EmptyState from './EmptyState';
import { colors, typography, spacing, radius } from '../theme';

function describeAction(action) {
  return `${action.method.toUpperCase()} ${action.url}`;
}

function formatTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Inspector for the offline action queue — opened by tapping the "N actions
 * waiting to sync" banner on Home. Previously the queue was a black box:
 * no way to see what's stuck, force a retry sooner than the next
 * connectivity edge/periodic sweep, or give up on a single bad entry
 * without waiting for it to exhaust MAX_RETRIES on its own.
 */
export default function SyncQueueModal({ visible, onClose, onQueueChanged }) {
  const insets = useSafeAreaInsets();
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setQueue(await getQueueSnapshot());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const notifyCountChanged = async () => {
    onQueueChanged?.(await getPendingCount());
  };

  const handleRetryNow = async () => {
    setRetrying(true);
    try {
      await flushQueue();
      await refresh();
      await notifyCountChanged();
    } finally {
      setRetrying(false);
    }
  };

  const handleDiscard = (action) => {
    showAlert(
      'Discard this action?',
      `${describeAction(action)} will be permanently dropped and will not sync.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: async () => {
            await removeQueuedAction(action.id);
            await refresh();
            await notifyCountChanged();
          },
        },
      ]
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Waiting to sync</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <X size={22} color={colors.text} />
          </Pressable>
        </View>

        <Pressable
          style={[styles.retryButton, retrying && styles.retryButtonDisabled]}
          onPress={handleRetryNow}
          disabled={retrying}
          accessibilityRole="button"
        >
          {retrying ? (
            <ActivityIndicator size="small" color={colors.textInverse} />
          ) : (
            <RefreshCw size={16} color={colors.textInverse} />
          )}
          <Text style={styles.retryButtonText}>{retrying ? 'Retrying...' : 'Retry now'}</Text>
        </Pressable>

        {!loading && queue.length === 0 && (
          <EmptyState
            icon={<RefreshCw size={40} color={colors.textMuted} />}
            title="Nothing waiting"
            subtitle="Everything has synced to the server."
          />
        )}

        <FlatList
          data={queue}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listPadding}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{describeAction(item)}</Text>
                <Text style={styles.rowSubtitle}>
                  Queued {formatTimestamp(item.timestamp)}
                  {item.retryCount > 0 ? ` · ${item.retryCount} failed attempt${item.retryCount !== 1 ? 's' : ''}` : ''}
                </Text>
              </View>
              <Pressable
                onPress={() => handleDiscard(item)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Discard"
              >
                <Trash2 size={18} color={colors.danger} />
              </Pressable>
            </View>
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
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    marginHorizontal: spacing.screenHorizontal,
    marginBottom: spacing.md,
    paddingVertical: 12,
    borderRadius: radius.input,
  },
  retryButtonDisabled: { opacity: 0.7 },
  retryButtonText: { color: colors.textInverse, fontWeight: '700', marginLeft: spacing.sm },
  listPadding: { paddingHorizontal: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.input,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowTitle: { ...typography.cardTitle, fontSize: 15, color: colors.text },
  rowSubtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
});
