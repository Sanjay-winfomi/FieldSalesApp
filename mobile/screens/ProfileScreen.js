import React, { useMemo } from 'react';
import { StyleSheet, Text, View, ScrollView, Pressable, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { LogOut, Info, Clock } from 'lucide-react-native';
import { useAppState } from '../src/context/AppStateContext';
import { ProfileCard, ProfileRow, SecondaryButton, Card, FadeSlideIn } from '../src/components';
import { colors, typography, spacing } from '../src/theme';
import appJson from '../app.json';

function formatDuration(minutes) {
  if (!minutes || minutes < 1) return '0h 0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { employee, attendance, dayStatus, onLogout } = useAppState();

  const workingMinutes = useMemo(() => {
    if (!attendance?.check_in_time) return 0;
    if (attendance.total_duration_minutes != null) return attendance.total_duration_minutes;
    return Math.max(0, Math.round((Date.now() - new Date(attendance.check_in_time)) / 60000));
  }, [attendance]);

  const statusLabel = dayStatus === 'checked_in' ? 'Checked in' : dayStatus === 'day_ended' ? 'Day ended' : 'Not checked in';

  const handleLogoutPress = () => {
    Alert.alert('Log out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => onLogout(navigation) },
    ]);
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.title}>Profile</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <FadeSlideIn>
          <ProfileCard name={employee?.name} roleLabel={employee?.role === 'manager' ? 'Manager' : 'Field sales representative'}>
            <ProfileRow label="Username" value={employee?.username} />
            <ProfileRow label="Region" value={employee?.region} />
          </ProfileCard>
        </FadeSlideIn>

        <FadeSlideIn delay={60}>
          <Card style={styles.statusCard}>
            <View style={styles.statusRow}>
              <View style={styles.statusIconCircle}>
                <Clock size={18} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.statusLabel}>Today's status</Text>
                <Text style={styles.statusValue}>{statusLabel}</Text>
              </View>
              <View style={styles.statusRight}>
                <Text style={styles.statusLabel}>Working hours</Text>
                <Text style={styles.statusValue}>{formatDuration(workingMinutes)}</Text>
              </View>
            </View>
          </Card>
        </FadeSlideIn>

        <FadeSlideIn delay={100}>
          <Pressable
            style={styles.menuRow}
            onPress={() => Alert.alert('FieldTrack', `Version ${appJson.expo.version}\n\nAttendance and dealer visit tracking for field sales teams.`)}
            accessibilityRole="button"
          >
            <Info size={18} color={colors.textSecondary} style={styles.menuIcon} />
            <Text style={styles.menuText}>About app</Text>
            <Text style={styles.versionText}>v{appJson.expo.version}</Text>
          </Pressable>
        </FadeSlideIn>

        <FadeSlideIn delay={140} style={{ marginTop: spacing.xl }}>
          <SecondaryButton
            title="Log out"
            tone="danger"
            icon={<LogOut size={18} color={colors.danger} />}
            onPress={handleLogoutPress}
          />
        </FadeSlideIn>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    backgroundColor: colors.card,
    paddingHorizontal: spacing.screenHorizontal,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  title: { ...typography.sectionTitle, color: colors.text, fontSize: 22 },
  content: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },

  statusCard: { marginBottom: spacing.cardGap },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusIconCircle: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primaryLight,
    justifyContent: 'center', alignItems: 'center', marginRight: spacing.md,
  },
  statusLabel: { ...typography.caption, color: colors.textSecondary },
  statusValue: { ...typography.bodyMedium, color: colors.text, marginTop: 2 },
  statusRight: { alignItems: 'flex-end' },

  menuRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm,
  },
  menuIcon: { marginRight: spacing.md },
  menuText: { flex: 1, ...typography.body, color: colors.text, fontWeight: '600' },
  versionText: { ...typography.caption, color: colors.textMuted },
});
