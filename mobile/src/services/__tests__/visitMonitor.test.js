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

const VISIT = { id: 55 };

describe('visitMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 11.0001, longitude: 77.0001 } });
  });

  afterEach(() => {
    stopVisitMonitoring();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('pings the backend every CHECK_INTERVAL_MS while a visit is open', async () => {
    api.post.mockResolvedValue({ data: { visit: { last_location_status: 'inside', log_out_alert_sent: false } } });

    startVisitMonitoring({ visit: VISIT });
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);

    expect(api.post).toHaveBeenCalledWith('/visits/55/location-check', { lat: 11.0001, lng: 77.0001 });
  });

  test('does not fire onWarning when the ping reports inside', async () => {
    api.post.mockResolvedValue({ data: { visit: { last_location_status: 'inside', log_out_alert_sent: false } } });
    const onWarning = jest.fn();
    const onLogoutAlert = jest.fn();

    startVisitMonitoring({ visit: VISIT, onWarning, onLogoutAlert });
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);

    expect(onWarning).not.toHaveBeenCalled();
    expect(onLogoutAlert).not.toHaveBeenCalled();
  });

  test('fires onWarning whenever a ping reports outside', async () => {
    api.post.mockResolvedValue({
      data: { visit: { last_location_status: 'outside', log_out_alert_sent: false }, distance_meters: 287 },
    });
    const onWarning = jest.fn();

    startVisitMonitoring({ visit: VISIT, onWarning });
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);

    expect(onWarning).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledWith(287);
  });

  test('fires onLogoutAlert once the backend reports the cumulative breach alert', async () => {
    api.post.mockResolvedValue({
      data: { visit: { last_location_status: 'outside', log_out_alert_sent: true }, distance_meters: 300 },
    });
    const onLogoutAlert = jest.fn();

    startVisitMonitoring({ visit: VISIT, onLogoutAlert });
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);

    expect(onLogoutAlert).toHaveBeenCalledTimes(1);
    expect(onLogoutAlert).toHaveBeenCalledWith(300);
  });

  test('only fires onLogoutAlert once even if later pings keep reporting it', async () => {
    api.post.mockResolvedValue({
      data: { visit: { last_location_status: 'outside', log_out_alert_sent: true }, distance_meters: 300 },
    });
    const onLogoutAlert = jest.fn();

    startVisitMonitoring({ visit: VISIT, onLogoutAlert });
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);

    expect(onLogoutAlert).toHaveBeenCalledTimes(1);
  });

  test('queues the location-check report when offline', async () => {
    api.post.mockRejectedValue({ message: 'Network Error' }); // no .response => treated as offline

    startVisitMonitoring({ visit: VISIT });
    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);

    expect(enqueueAction).toHaveBeenCalledWith('post', '/visits/55/location-check', expect.any(Object));
  });

  test('stopVisitMonitoring clears the interval', async () => {
    api.post.mockResolvedValue({ data: { visit: { last_location_status: 'inside', log_out_alert_sent: false } } });
    startVisitMonitoring({ visit: VISIT });
    stopVisitMonitoring();

    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS * 5);

    expect(api.post).not.toHaveBeenCalled();
  });
});
