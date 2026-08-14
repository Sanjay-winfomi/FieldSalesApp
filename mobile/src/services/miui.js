import { Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_SEEN_KEY = '@miui_onboarding_seen';

/**
 * miui.js — detection + deep links for MIUI (Xiaomi/Redmi/POCO)'s own,
 * non-standard background-app permissions.
 *
 * Confirmed via adb logcat: MIUI's ProcessSceneCleaner (LockScreenClean on
 * screen lock, SwipeUpClean on a recent-apps swipe-away) kills this app's
 * process while backgrounded, well before Android's own low-memory killer
 * would. Standard Android permission APIs (expo-location's foreground/
 * background location prompts) have no bearing on this — MIUI's cleaners
 * only back off for apps the user has explicitly exempted via MIUI's own
 * Security app settings, which no public Android API can request on the
 * app's behalf. A real foreground service (visitForegroundService.js)
 * reduces how likely a kill is, but doesn't eliminate MIUI's own OEM-level
 * exemption requirement.
 */
export function isMiuiDevice() {
  if (Platform.OS !== 'android') return false;
  const brand = String(Platform.constants?.Brand || '').toLowerCase();
  const manufacturer = String(Platform.constants?.Manufacturer || '').toLowerCase();
  return /xiaomi|redmi|poco/.test(brand) || /xiaomi|redmi|poco/.test(manufacturer);
}

export async function hasSeenMiuiOnboarding() {
  return (await AsyncStorage.getItem(ONBOARDING_SEEN_KEY)) === 'true';
}

export async function markMiuiOnboardingSeen() {
  await AsyncStorage.setItem(ONBOARDING_SEEN_KEY, 'true');
}

// MIUI's Autostart list — without this, MIUI can prevent the app from ever
// restarting itself in the background at all (e.g. after a geofence-related
// process wake). Component target is MIUI-internal and unofficial (there is
// no public Android API for this); it has shifted across MIUI versions
// before and may not resolve on every device/region, hence the fallback.
export async function openMiuiAutostartSettings() {
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
      packageName: 'com.miui.securitycenter',
      className: 'com.miui.permcenter.autostart.AutoStartManagementActivity',
    });
  } catch (error) {
    console.warn('MIUI autostart screen unavailable, falling back to app settings:', error.message);
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS, {
      data: 'package:com.winfomi.fieldtrack',
    }).catch(() => {});
  }
}

// MIUI's per-app battery saver screen ("No restrictions") — distinct from
// (and in addition to) the standard Android battery-optimization exemption
// already handled by openBatteryOptimizationSettings() in location.js.
export async function openMiuiBatterySettings() {
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
      packageName: 'com.miui.securitycenter',
      className: 'com.miui.powercenter.PowerSettings',
    });
  } catch (error) {
    console.warn('MIUI battery screen unavailable, falling back to app settings:', error.message);
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS, {
      data: 'package:com.winfomi.fieldtrack',
    }).catch(() => {});
  }
}
