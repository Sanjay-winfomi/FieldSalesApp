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
import { getCurrentLocation, getLocationPermissionStatus } from '../location';

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

describe('getLocationPermissionStatus', () => {
  test('reports granted + canAskAgain from expo-location', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });
    const result = await getLocationPermissionStatus();
    expect(result).toEqual({ granted: false, canAskAgain: false });
  });
});
