import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Card from './Card';
import { colors, typography, spacing, radius } from '../../theme';

function initials(name) {
  if (!name) return '?';
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/**
 * A single labeled row inside ProfileCard (e.g. "Region — Coimbatore").
 */
export function ProfileRow({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={[typography.caption, styles.rowLabel]}>{label}</Text>
      <Text style={[typography.bodyMedium, styles.rowValue]} numberOfLines={1}>
        {value || '—'}
      </Text>
    </View>
  );
}

export default function ProfileCard({ name, roleLabel, children }) {
  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(name)}</Text>
        </View>
        <View style={styles.headerText}>
          <Text style={[typography.cardTitle, { color: colors.text }]} numberOfLines={1}>
            {name || 'User'}
          </Text>
          <View style={styles.rolePill}>
            <Text style={styles.rolePillText}>{roleLabel}</Text>
          </View>
        </View>
      </View>

      {children ? <View style={styles.divider} /> : null}
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.cardGap,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  avatarText: {
    color: colors.textInverse,
    fontSize: 22,
    fontWeight: '700',
  },
  headerText: {
    flex: 1,
  },
  rolePill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginTop: 6,
  },
  rolePillText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  rowLabel: {
    color: colors.textSecondary,
  },
  rowValue: {
    color: colors.text,
    maxWidth: '60%',
    textAlign: 'right',
  },
});
