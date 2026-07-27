jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));
jest.mock('../api', () => ({ api: { post: jest.fn() } }));
jest.mock('../syncManager', () => ({ enqueueAction: jest.fn() }));

import * as Location from 'expo-location';
import { api } from '../api';
import { enqueueAction } from '../syncManager';
import { startVisitMonitoring, stopVisitMonitoring, __testing } from '../visitMonitor';

const DEALER = { latitude: 11.0, longitude: 77.0, radius_meters: 200 };
const VISIT = { id: 55 };

describe('visitMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    api.post.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    stopVisitMonitoring();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('does nothing while the rep stays inside the radius', async () => {
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11.0001, longitude: 77.0001 } });
    const onWarning = jest.fn();
    const onInterrupted = jest.fn();

    startVisitMonitoring({ visit: VISIT, dealer: DEALER, onWarning, onInterrupted });
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);

    expect(onWarning).not.toHaveBeenCalled();
    expect(onInterrupted).not.toHaveBeenCalled();
  });

  test('fires onWarning the first time the rep is found outside the radius', async () => {
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11.05, longitude: 77.05 } }); // far outside 200m
    const onWarning = jest.fn();

    startVisitMonitoring({ visit: VISIT, dealer: DEALER, onWarning });
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
  });

  test('flags the visit interrupted after staying outside past the grace period', async () => {
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11.05, longitude: 77.05 } });
    const onInterrupted = jest.fn();

    startVisitMonitoring({ visit: VISIT, dealer: DEALER, onInterrupted });

    for (let i = 0; i < __testing.CONSECUTIVE_OUTSIDE_TO_INTERRUPT; i++) {
      await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    }

    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/visits/55/interrupt', expect.objectContaining({ lat: 11.05, lng: 77.05 }));
  });

  test('only reports interrupted once even if still outside afterward', async () => {
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11.05, longitude: 77.05 } });
    startVisitMonitoring({ visit: VISIT, dealer: DEALER });

    for (let i = 0; i < __testing.CONSECUTIVE_OUTSIDE_TO_INTERRUPT + 2; i++) {
      await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    }

    expect(api.post).toHaveBeenCalledTimes(1);
  });

  test('resets the outside counter once back inside the radius', async () => {
    Location.getCurrentPositionAsync
      .mockResolvedValueOnce({ coords: { latitude: 11.05, longitude: 77.05 } }) // outside
      .mockResolvedValueOnce({ coords: { latitude: 11.0001, longitude: 77.0001 } }) // back inside
      .mockResolvedValue({ coords: { latitude: 11.05, longitude: 77.05 } }); // outside again
    const onInterrupted = jest.fn();

    startVisitMonitoring({ visit: VISIT, dealer: DEALER, onInterrupted });

    for (let i = 0; i < __testing.CONSECUTIVE_OUTSIDE_TO_INTERRUPT; i++) {
      await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    }

    // The "back inside" reading should have reset the streak, so it never reached the threshold.
    expect(onInterrupted).not.toHaveBeenCalled();
  });

  test('queues the interrupt report when offline', async () => {
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11.05, longitude: 77.05 } });
    api.post.mockRejectedValue({ message: 'Network Error' }); // no .response => treated as offline

    startVisitMonitoring({ visit: VISIT, dealer: DEALER });

    for (let i = 0; i < __testing.CONSECUTIVE_OUTSIDE_TO_INTERRUPT; i++) {
      await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    }

    expect(enqueueAction).toHaveBeenCalledWith('post', '/visits/55/interrupt', expect.any(Object));
  });

  test('stopVisitMonitoring clears the interval', async () => {
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11.05, longitude: 77.05 } });
    startVisitMonitoring({ visit: VISIT, dealer: DEALER });
    stopVisitMonitoring();

    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS * 5);

    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });
});
