jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
}));
jest.mock('expo-location', () => ({
  getBackgroundPermissionsAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));
jest.mock('../crashReporter', () => ({ captureException: jest.fn() }));

import * as Location from 'expo-location';
import {
  VISIT_FOREGROUND_LOCATION_TASK,
  startVisitForegroundService,
  stopVisitForegroundService,
} from '../visitForegroundService';

describe('startVisitForegroundService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('starts a real foreground-service location task when background permission is granted', async () => {
    Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(false);

    await startVisitForegroundService(55);

    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(
      VISIT_FOREGROUND_LOCATION_TASK,
      expect.objectContaining({
        foregroundService: expect.objectContaining({
          notificationTitle: expect.any(String),
          notificationBody: expect.any(String),
        }),
      })
    );
  });

  test('no-ops when background permission is not granted', async () => {
    Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await startVisitForegroundService(55);

    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  test('no-ops when there is no visit id', async () => {
    await startVisitForegroundService(null);

    expect(Location.getBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  test('does not start a second time if already started', async () => {
    Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(true);

    await startVisitForegroundService(55);

    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  test('does not throw if the OS call itself fails', async () => {
    Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
    Location.startLocationUpdatesAsync.mockRejectedValue(new Error('service unavailable'));

    await expect(startVisitForegroundService(55)).resolves.toBeUndefined();
  });
});

describe('stopVisitForegroundService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('stops the task only if currently started', async () => {
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(true);

    await stopVisitForegroundService();

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(VISIT_FOREGROUND_LOCATION_TASK);
  });

  test('does nothing if the task was never started', async () => {
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(false);

    await stopVisitForegroundService();

    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  test('does not throw if the OS call itself fails', async () => {
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    Location.stopLocationUpdatesAsync.mockRejectedValue(new Error('service unavailable'));

    await expect(stopVisitForegroundService()).resolves.toBeUndefined();
  });
});
