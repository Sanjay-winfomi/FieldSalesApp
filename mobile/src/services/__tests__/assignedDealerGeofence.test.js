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
  startGeofencingAsync: jest.fn(),
  stopGeofencingAsync: jest.fn(),
}));
jest.mock('../geofenceNotifications', () => ({ sendArrivalNotification: jest.fn() }));
jest.mock('../crashReporter', () => ({ captureException: jest.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { sendArrivalNotification } from '../geofenceNotifications';
import {
  ASSIGNED_DEALER_ARRIVAL_TASK,
  startAssignedDealersGeofence,
  stopAssignedDealersGeofence,
  checkArrivalNow,
} from '../assignedDealerGeofence';

const ASSIGNMENT_A = { id: 1, dealer_id: 10, dealer_name: 'Dealer A', dealer_address: 'Addr A', dealer_lat: 11.0, dealer_lng: 77.0, radius_meters: 150 };
const ASSIGNMENT_B = { id: 2, dealer_id: 11, dealer_name: 'Dealer B', dealer_address: 'Addr B', dealer_lat: 12.0, dealer_lng: 78.0 };

function fireGeofenceEvent(eventType, identifier) {
  return TaskManager.__definedTasks[ASSIGNED_DEALER_ARRIVAL_TASK]({ data: { eventType, region: { identifier } }, error: null });
}

describe('assignedDealerGeofence', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    TaskManager.isTaskRegisteredAsync.mockResolvedValue(false);
  });

  describe('startAssignedDealersGeofence', () => {
    test('registers one region per pending assignment and caches their details', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });

      const started = await startAssignedDealersGeofence([ASSIGNMENT_A, ASSIGNMENT_B]);

      expect(started).toBe(true);
      expect(Location.startGeofencingAsync).toHaveBeenCalledWith(ASSIGNED_DEALER_ARRIVAL_TASK, [
        expect.objectContaining({ identifier: 'assignment-1', latitude: 11.0, longitude: 77.0, radius: 150, notifyOnEnter: true, notifyOnExit: false }),
        expect.objectContaining({ identifier: 'assignment-2', latitude: 12.0, longitude: 78.0, radius: 200 }),
      ]);
    });

    test('skips assignments with no registered dealer coordinates', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });

      await startAssignedDealersGeofence([{ ...ASSIGNMENT_A, dealer_lat: null, dealer_lng: null }, ASSIGNMENT_B]);

      expect(Location.startGeofencingAsync).toHaveBeenCalledWith(ASSIGNED_DEALER_ARRIVAL_TASK, [
        expect.objectContaining({ identifier: 'assignment-2' }),
      ]);
    });

    test('no-ops (and clears any stale cache) when there is nothing to watch', async () => {
      const started = await startAssignedDealersGeofence([]);

      expect(started).toBe(false);
      expect(Location.startGeofencingAsync).not.toHaveBeenCalled();
    });

    test('no-ops when background location permission is not granted', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'denied' });

      const started = await startAssignedDealersGeofence([ASSIGNMENT_A]);

      expect(started).toBe(false);
      expect(Location.startGeofencingAsync).not.toHaveBeenCalled();
    });
  });

  describe('stopAssignedDealersGeofence', () => {
    test('stops geofencing only if the task is currently registered, and always clears the cache', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      await startAssignedDealersGeofence([ASSIGNMENT_A]);
      TaskManager.isTaskRegisteredAsync.mockResolvedValue(true);

      await stopAssignedDealersGeofence();

      expect(Location.stopGeofencingAsync).toHaveBeenCalledWith(ASSIGNED_DEALER_ARRIVAL_TASK);
      expect(await AsyncStorage.getItem('@assigned_dealers_geofence_cache')).toBeNull();
    });

    test('does nothing to the OS task if it was never registered', async () => {
      TaskManager.isTaskRegisteredAsync.mockResolvedValue(false);

      await stopAssignedDealersGeofence();

      expect(Location.stopGeofencingAsync).not.toHaveBeenCalled();
    });
  });

  describe('background task handler', () => {
    test('sends an arrival notification with the cached assignment details on Enter', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      await startAssignedDealersGeofence([ASSIGNMENT_A]);

      await fireGeofenceEvent(Location.GeofencingEventType.Enter, 'assignment-1');

      expect(sendArrivalNotification).toHaveBeenCalledWith(
        expect.objectContaining({ regionId: 'assignment-1', assignmentId: 1, dealerId: 10, dealerName: 'Dealer A' })
      );
    });

    test('ignores Exit events entirely', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      await startAssignedDealersGeofence([ASSIGNMENT_A]);

      await fireGeofenceEvent(Location.GeofencingEventType.Exit, 'assignment-1');

      expect(sendArrivalNotification).not.toHaveBeenCalled();
    });

    test('ignores a stale region no longer in the cache', async () => {
      await fireGeofenceEvent(Location.GeofencingEventType.Enter, 'assignment-999');
      expect(sendArrivalNotification).not.toHaveBeenCalled();
    });

    test('ignores task errors from the OS without throwing', async () => {
      await expect(
        TaskManager.__definedTasks[ASSIGNED_DEALER_ARRIVAL_TASK]({ data: null, error: { message: 'geofencing failed' } })
      ).resolves.toBeUndefined();
      expect(sendArrivalNotification).not.toHaveBeenCalled();
    });

    test('does not notify twice if checkArrivalNow already caught this arrival', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      await startAssignedDealersGeofence([ASSIGNMENT_A]);

      // ~111m from Dealer A (11.0, 77.0) — inside its 150m radius.
      await checkArrivalNow(11.0010, 77.0);
      expect(sendArrivalNotification).toHaveBeenCalledTimes(1);

      // The OS geofence fires afterwards for the same region — already
      // notified, so this must not fire a second alert.
      await fireGeofenceEvent(Location.GeofencingEventType.Enter, 'assignment-1');
      expect(sendArrivalNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkArrivalNow', () => {
    test('notifies for a pending dealer whose radius contains the given position', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      await startAssignedDealersGeofence([ASSIGNMENT_A]);

      await checkArrivalNow(11.0010, 77.0); // ~111m away, inside the 150m radius

      expect(sendArrivalNotification).toHaveBeenCalledWith(
        expect.objectContaining({ regionId: 'assignment-1', dealerName: 'Dealer A' })
      );
    });

    test('does not notify for a dealer still outside its radius', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      await startAssignedDealersGeofence([ASSIGNMENT_A]);

      await checkArrivalNow(11.01, 77.0); // ~1.1km away, well outside 150m

      expect(sendArrivalNotification).not.toHaveBeenCalled();
    });

    test('does not notify again for a dealer already notified', async () => {
      Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
      await startAssignedDealersGeofence([ASSIGNMENT_A]);

      await checkArrivalNow(11.0010, 77.0);
      await checkArrivalNow(11.0010, 77.0);

      expect(sendArrivalNotification).toHaveBeenCalledTimes(1);
    });

    test('does nothing when nothing is currently being watched', async () => {
      await checkArrivalNow(11.0, 77.0);
      expect(sendArrivalNotification).not.toHaveBeenCalled();
    });

    test('never throws on a missing/invalid position', async () => {
      await expect(checkArrivalNow(null, null)).resolves.toBeUndefined();
      expect(sendArrivalNotification).not.toHaveBeenCalled();
    });
  });
});
