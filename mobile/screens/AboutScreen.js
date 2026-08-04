import React from 'react';
import { StyleSheet, Text, View, ScrollView, Linking } from 'react-native';
import { Info, Mail } from 'lucide-react-native';
import { AppHeader, Card } from '../src/components';
import { colors, typography, spacing } from '../src/theme';
import appJson from '../app.json';

export default function AboutScreen({ navigation }) {
  return (
    <View style={styles.screen}>
      <AppHeader title="About app" onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Card style={styles.card}>
          <View style={styles.iconCircle}>
            <Info size={22} color={colors.primary} />
          </View>
          <Text style={styles.appName}>Winfomi</Text>
          <Text style={styles.version}>Version {appJson.expo.version}</Text>
          <Text style={styles.description}>
            Attendance and dealer visit tracking for field sales teams — day login/logout,
            dealer login/logout with location verification, visit history, notes, and
            dealer follow-up reminders.
          </Text>
        </Card>

        <Card style={styles.card}>
          <Text style={styles.sectionTitle}>Support</Text>
          <Text
            style={styles.link}
            onPress={() => Linking.openURL('mailto:support@winfomi.com')}
            accessibilityRole="link"
          >
            <Mail size={14} color={colors.primary} /> support@winfomi.com
          </Text>
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  card: { alignItems: 'center', marginBottom: spacing.cardGap, paddingVertical: spacing.lg },
  iconCircle: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primaryLight,
    justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md,
  },
  appName: { ...typography.sectionTitle, color: colors.text },
  version: { ...typography.caption, color: colors.textMuted, marginTop: 2, marginBottom: spacing.md },
  description: { ...typography.body, color: colors.textSecondary, textAlign: 'center' },
  sectionTitle: { ...typography.bodyMedium, color: colors.text, alignSelf: 'flex-start', marginBottom: spacing.sm },
  link: { ...typography.body, color: colors.primary, alignSelf: 'flex-start' },
});
