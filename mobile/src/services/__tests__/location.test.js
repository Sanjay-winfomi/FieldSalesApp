jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { Highest: 6 },
}));
jest.mock('expo-intent-launcher', () => ({
  startActivityAsync: jest.fn(() => Promise.resolve()),
  ActivityAction: { IGNORE_BATTERY_OPTIMIZATION_SETTINGS: 'mock-action' },
}));
jest.mock('../api', () => ({ api: { get: jest.fn() } }));
jest.mock('react-native', () => ({
  Linking: { openSettings: jest.fn() },
  Platform: { OS: 'android', select: (obj) => obj.android ?? obj.default },
}));

import * as Location from 'expo-location';
import { getCurrentLocation, getApproximateLocation, getLocationPermissionStatus } from '../location';

describe('getCurrentLocation', () => {
  afterEach(() => jest.clearAllMocks());

  test('returns null when permission is denied and cannot be asked again', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });
    const result = await getCurrentLocation();
    expect(result).toBeNull();
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  test('returns null when the OS prompt itself is denied', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: true });
    Location.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    const result = await getCurrentLocation();
    expect(result).toBeNull();
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test('does not re-prompt the OS when permission is already granted', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'granted', canAskAgain: true });
    Location.getCurrentPositionAsync.mockResolvedValueOnce({ coords: { latitude: 11, longitude: 77, accuracy: 5 } });

    const result = await getCurrentLocation();

    expect(result.accuracyMeters).toBe(5);
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  test('returns the best (lowest-error) reading across attempts', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'granted', canAskAgain: true });
    Location.getCurrentPositionAsync
      .mockResolvedValueOnce({ coords: { latitude: 11, longitude: 77, accuracy: 40 } })
      .mockResolvedValueOnce({ coords: { latitude: 11.001, longitude: 77.001, accuracy: 15 } });

    const result = await getCurrentLocation();

    expect(result.accuracyMeters).toBe(15);
    expect(result.lat).toBe(11.001);
  });

  test('stops early once a good-enough reading is acquired', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'granted', canAskAgain: true });
    Location.getCurrentPositionAsync.mockResolvedValueOnce({ coords: { latitude: 11, longitude: 77, accuracy: 5 } });

    const result = await getCurrentLocation();

    expect(result.accuracyMeters).toBe(5);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });
});

describe('concurrent permission requests', () => {
  afterEach(() => jest.clearAllMocks());

  test('two overlapping calls while permission is undecided share a single OS prompt', async () => {
    // Both getCurrentLocation() and getApproximateLocation() read the
    // cached permission status first; while it's still "denied but
    // askable" (the window before the user answers), both should collapse
    // onto the SAME requestForegroundPermissionsAsync() call instead of
    // each firing their own — the race this single-flight guard closes.
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: true });
    let resolveRequest;
    Location.requestForegroundPermissionsAsync.mockImplementation(
      () => new Promise((resolve) => { resolveRequest = resolve; })
    );
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11, longitude: 77, accuracy: 5 } });

    const callA = getCurrentLocation();
    const callB = getApproximateLocation();

    // Let both calls run past their getForegroundPermissionsAsync() await
    // and reach the request step before resolving it.
    await Promise.resolve();
    await Promise.resolve();
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);

    resolveRequest({ status: 'granted' });
    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(resultA.accuracyMeters).toBe(5);
    expect(resultB.accuracyMeters).toBe(5);
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test('a later call, after permission settles, requests again if still needed', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: true });
    Location.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    await getCurrentLocation();
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);

    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: true });
    Location.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    await getCurrentLocation();
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(2);
  });
});

describe('getLocationPermissionStatus', () => {
  test('reports granted + canAskAgain from expo-location', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });
    const result = await getLocationPermissionStatus();
    expect(result).toEqual({ granted: false, canAskAgain: false });
  });
});
