jest.mock('expo-task-manager', () => {
  const definedTasks = {};
  return {
    defineTask: jest.fn((name, handler) => { definedTasks[name] = handler; }),
    isTaskRegisteredAsync: jest.fn(),
    __definedTasks: definedTasks,
  };
});
jest.mock('expo-location', () => ({
  GeofencingEventType: { Enter: 1, Exit: 2 },
  getBackgroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  startGeofencingAsync: jest.fn(),
  stopGeofencingAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));
jest.mock('../api', () => ({ api: { post: jest.fn() } }));
jest.mock('../syncManager', () => ({ enqueueAction: jest.fn() }));

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { api } from '../api';
import { enqueueAction } from '../syncManager';
import { DEALER_GEOFENCE_TASK, startDealerGeofence, stopDealerGeofence } from '../geofenceTask';

const VISIT = { id: 55 };
const DEALER = { latitude: 11.0, longitude: 77.0, radius_meters: 200 };

function fireGeofenceEvent(eventType, identifier) {
  return TaskManager.__definedTasks[DEALER_GEOFENCE_TASK]({ data: { eventType, region: { identifier } }, error: null });
}

describe('geofenceTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11.0001, longitude: 77.0001 } });
    TaskManager.isTaskRegisteredAsync.mockResolvedValue(false);
  });

  describe('startDealerGeofence', () => {
    test('registers a region around the dealer when background permission is granted', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });

      await startDealerGeofence(VISIT, DEALER);

      expect(Location.startGeofencingAsync).toHaveBeenCalledWith(DEALER_GEOFENCE_TASK, [
        expect.objectContaining({ identifier: '55', latitude: 11.0, longitude: 77.0, radius: 200 }),
      ]);
    });

    test('no-ops when background permission is not granted', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

      await startDealerGeofence(VISIT, DEALER);

      expect(Location.startGeofencingAsync).not.toHaveBeenCalled();
    });

    test('no-ops when the dealer has no registered coordinates', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });

      await startDealerGeofence(VISIT, { latitude: null, longitude: null });

      expect(Location.startGeofencingAsync).not.toHaveBeenCalled();
    });
  });

  describe('stopDealerGeofence', () => {
    test('stops geofencing only if the task is currently registered', async () => {
      TaskManager.isTaskRegisteredAsync.mockResolvedValue(true);

      await stopDealerGeofence();

      expect(Location.stopGeofencingAsync).toHaveBeenCalledWith(DEALER_GEOFENCE_TASK);
    });

    test('does nothing if the task was never registered', async () => {
      TaskManager.isTaskRegisteredAsync.mockResolvedValue(false);

      await stopDealerGeofence();

      expect(Location.stopGeofencingAsync).not.toHaveBeenCalled();
    });
  });

  describe('background task handler', () => {
    test('reports a location check to the backend on ENTER', async () => {
      api.post.mockResolvedValue({ data: { visit: { last_location_status: 'inside' } } });

      await fireGeofenceEvent(Location.GeofencingEventType.Enter, '55');

      expect(api.post).toHaveBeenCalledWith('/visits/55/location-check', { lat: 11.0001, lng: 77.0001 });
    });

    test('reports a location check to the backend on EXIT', async () => {
      api.post.mockResolvedValue({ data: { visit: { last_location_status: 'outside' } } });

      await fireGeofenceEvent(Location.GeofencingEventType.Exit, '55');

      expect(api.post).toHaveBeenCalledWith('/visits/55/location-check', { lat: 11.0001, lng: 77.0001 });
    });

    test('queues the check when offline', async () => {
      api.post.mockRejectedValue({ message: 'Network Error' }); // no .response => offline

      await fireGeofenceEvent(Location.GeofencingEventType.Enter, '55');

      expect(enqueueAction).toHaveBeenCalledWith('post', '/visits/55/location-check', expect.any(Object));
    });

    test('ignores task errors from the OS without throwing', async () => {
      await expect(
        TaskManager.__definedTasks[DEALER_GEOFENCE_TASK]({ data: null, error: { message: 'geofencing failed' } })
      ).resolves.toBeUndefined();
      expect(api.post).not.toHaveBeenCalled();
    });
  });
});
