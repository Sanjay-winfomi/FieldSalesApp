import React from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';
import { ShieldCheck, BatteryCharging, Pin } from 'lucide-react-native';
import { AppHeader, Card, PrimaryButton, SecondaryButton, FadeSlideIn } from '../src/components';
import { openMiuiAutostartSettings, openMiuiBatterySettings, markMiuiOnboardingSeen } from '../src/services/miui';
import { colors, typography, spacing } from '../src/theme';

/**
 * MiuiOnboardingScreen — walks a rep on a MIUI (Xiaomi/Redmi/POCO) device
 * through the three OEM-specific settings that keep this app from being
 * killed in the background (confirmed via adb logcat: MIUI's own
 * LockScreenClean/SwipeUpClean cleaners, not Android's standard background
 * limits). No public Android API can grant any of these on the app's
 * behalf — the rep has to do it themselves, once.
 *
 * Shown automatically the first time a MIUI device logs in (see App.js's
 * onLoginSuccess), and revisitable anytime from Profile.
 */
function Step({ icon, title, body, buttonTitle, onPress }) {
  return (
    <Card style={styles.stepCard}>
      <View style={styles.stepHeader}>
        <View style={styles.iconCircle}>{icon}</View>
        <Text style={styles.stepTitle}>{title}</Text>
      </View>
      <Text style={styles.stepBody}>{body}</Text>
      {onPress && (
        <SecondaryButton title={buttonTitle} onPress={onPress} style={styles.stepButton} />
      )}
    </Card>
  );
}

export default function MiuiOnboardingScreen({ navigation }) {
  const handleDone = async () => {
    await markMiuiOnboardingSeen();
    navigation.goBack();
  };

  return (
    <View style={styles.screen}>
      <AppHeader title="Fix background restrictions" onBack={handleDone} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <FadeSlideIn>
          <Text style={styles.intro}>
            Your phone's software (MIUI) shuts down apps in the background more aggressively
            than standard Android — even with location permission granted. These three settings
            stop it from closing Winfomi while you're out on visits.
          </Text>
        </FadeSlideIn>

        <FadeSlideIn delay={60}>
          <Step
            icon={<ShieldCheck size={20} color={colors.primary} />}
            title="1. Turn on Autostart"
            body='Settings → Apps → Permissions → Autostart → enable Winfomi. Without this, MIUI can block the app from restarting itself in the background.'
            buttonTitle="Open Autostart settings"
            onPress={openMiuiAutostartSettings}
          />
        </FadeSlideIn>

        <FadeSlideIn delay={100}>
          <Step
            icon={<BatteryCharging size={20} color={colors.primary} />}
            title="2. Set battery saver to No restrictions"
            body='Settings → Battery & performance → App battery saver → Winfomi → "No restrictions".'
            buttonTitle="Open battery settings"
            onPress={openMiuiBatterySettings}
          />
        </FadeSlideIn>

        <FadeSlideIn delay={140}>
          <Step
            icon={<Pin size={20} color={colors.primary} />}
            title="3. Lock Winfomi in recent apps"
            body="Open the recent-apps switcher, long-press Winfomi's card, and tap the lock icon. This specifically stops MIUI from closing the app when you swipe it away."
          />
        </FadeSlideIn>

        <FadeSlideIn delay={180} style={{ marginTop: spacing.lg }}>
          <PrimaryButton title="Done" onPress={handleDone} />
        </FadeSlideIn>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.screenHorizontal, paddingBottom: spacing.xxxl },
  intro: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.lg },
  stepCard: { marginBottom: spacing.cardGap },
  stepHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  iconCircle: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primaryLight,
    justifyContent: 'center', alignItems: 'center', marginRight: spacing.md,
  },
  stepTitle: { ...typography.bodyMedium, color: colors.text, flex: 1 },
  stepBody: { ...typography.body, color: colors.textSecondary },
  stepButton: { marginTop: spacing.md },
});
