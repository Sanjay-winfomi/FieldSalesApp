let mockPlatform = { OS: 'android', constants: {} };
jest.mock('react-native', () => ({
  get Platform() { return mockPlatform; },
}));
jest.mock('expo-intent-launcher', () => ({
  startActivityAsync: jest.fn(() => Promise.resolve()),
  ActivityAction: { APPLICATION_DETAILS_SETTINGS: 'mock-app-details' },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isMiuiDevice,
  hasSeenMiuiOnboarding,
  markMiuiOnboardingSeen,
  openMiuiAutostartSettings,
  openMiuiBatterySettings,
} from '../miui';

describe('isMiuiDevice', () => {
  afterEach(() => { mockPlatform = { OS: 'android', constants: {} }; });

  test('false on iOS regardless of brand', () => {
    mockPlatform = { OS: 'ios', constants: { Brand: 'xiaomi' } };
    expect(isMiuiDevice()).toBe(false);
  });

  test('true for a Xiaomi brand on Android', () => {
    mockPlatform = { OS: 'android', constants: { Brand: 'Xiaomi', Manufacturer: 'Xiaomi' } };
    expect(isMiuiDevice()).toBe(true);
  });

  test('true for a Redmi brand on Android', () => {
    mockPlatform = { OS: 'android', constants: { Brand: 'Redmi', Manufacturer: 'Xiaomi' } };
    expect(isMiuiDevice()).toBe(true);
  });

  test('true for a POCO brand on Android', () => {
    mockPlatform = { OS: 'android', constants: { Brand: 'POCO', Manufacturer: 'POCO' } };
    expect(isMiuiDevice()).toBe(true);
  });

  test('false for a non-MIUI Android device', () => {
    mockPlatform = { OS: 'android', constants: { Brand: 'samsung', Manufacturer: 'samsung' } };
    expect(isMiuiDevice()).toBe(false);
  });

  test('false when Platform.constants is unavailable', () => {
    mockPlatform = { OS: 'android' };
    expect(isMiuiDevice()).toBe(false);
  });
});

describe('onboarding-seen flag', () => {
  afterEach(() => jest.clearAllMocks());

  test('hasSeenMiuiOnboarding reflects stored flag', async () => {
    AsyncStorage.getItem.mockResolvedValueOnce('true');
    expect(await hasSeenMiuiOnboarding()).toBe(true);
  });

  test('hasSeenMiuiOnboarding defaults to false', async () => {
    AsyncStorage.getItem.mockResolvedValueOnce(null);
    expect(await hasSeenMiuiOnboarding()).toBe(false);
  });

  test('markMiuiOnboardingSeen persists the flag', async () => {
    await markMiuiOnboardingSeen();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('@miui_onboarding_seen', 'true');
  });
});

describe('deep links', () => {
  afterEach(() => jest.clearAllMocks());

  test('openMiuiAutostartSettings targets the MIUI autostart activity', async () => {
    await openMiuiAutostartSettings();
    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith(
      'android.intent.action.MAIN',
      expect.objectContaining({ packageName: 'com.miui.securitycenter', className: expect.stringContaining('AutoStart') })
    );
  });

  test('openMiuiAutostartSettings falls back to app settings if the MIUI activity is unavailable', async () => {
    IntentLauncher.startActivityAsync.mockRejectedValueOnce(new Error('not found'));
    await openMiuiAutostartSettings();
    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledTimes(2);
    expect(IntentLauncher.startActivityAsync).toHaveBeenLastCalledWith(
      'mock-app-details',
      expect.objectContaining({ data: expect.stringContaining('com.winfomi.fieldtrack') })
    );
  });

  test('openMiuiBatterySettings targets the MIUI power settings activity', async () => {
    await openMiuiBatterySettings();
    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith(
      'android.intent.action.MAIN',
      expect.objectContaining({ packageName: 'com.miui.securitycenter', className: expect.stringContaining('Power') })
    );
  });

  test('openMiuiBatterySettings falls back to app settings if the MIUI activity is unavailable', async () => {
    IntentLauncher.startActivityAsync.mockRejectedValueOnce(new Error('not found'));
    await openMiuiBatterySettings();
    expect(IntentLauncher.startActivityAsync).toHaveBeenCalledTimes(2);
  });
});
