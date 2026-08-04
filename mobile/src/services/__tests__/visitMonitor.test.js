let mockAppStateListeners = [];
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn((event, handler) => {
      mockAppStateListeners.push(handler);
      return { remove: jest.fn(() => { mockAppStateListeners = mockAppStateListeners.filter((h) => h !== handler); }) };
    }),
  },
}));
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));
jest.mock('../api', () => ({ api: { post: jest.fn() } }));
jest.mock('../syncManager', () => ({ enqueueAction: jest.fn() }));

import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { api } from '../api';
import { enqueueAction } from '../syncManager';
import { startVisitMonitoring, stopVisitMonitoring, __testing } from '../visitMonitor';

const VISIT = { id: 55 };

function goToForeground() {
  mockAppStateListeners.forEach((handler) => handler('active'));
}

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
    mockAppStateListeners = [];
  });

  test('checks immediately on start, then every CHECK_INTERVAL_MS after', async () => {
    api.post.mockResolvedValue({ data: { visit: { last_location_status: 'inside', log_out_alert_sent: false } } });

    startVisitMonitoring({ visit: VISIT });
    await jest.advanceTimersByTimeAsync(0);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/visits/55/location-check', { lat: 11.0001, lng: 77.0001 });

    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  test('checks again as soon as the app returns to the foreground', async () => {
    api.post.mockResolvedValue({ data: { visit: { last_location_status: 'inside', log_out_alert_sent: false } } });

    startVisitMonitoring({ visit: VISIT });
    await jest.advanceTimersByTimeAsync(0);
    expect(api.post).toHaveBeenCalledTimes(1);

    goToForeground();
    await jest.advanceTimersByTimeAsync(0);
    expect(api.post).toHaveBeenCalledTimes(2);
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

  test('does not fire onWarning on a single outside ping — only after 2 consecutive', async () => {
    api.post.mockResolvedValue({
      data: { visit: { last_location_status: 'outside', log_out_alert_sent: false }, distance_meters: 287 },
    });
    const onWarning = jest.fn();

    startVisitMonitoring({ visit: VISIT, onWarning });
    // Immediate check on start = 1st outside ping — not enough on its own.
    expect(onWarning).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    // 2nd consecutive outside ping — now it fires, exactly once.
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(287);

    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS);
    // 3rd ping still outside, but the streak was already warned about.
    expect(onWarning).toHaveBeenCalledTimes(1);
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

  test('stopVisitMonitoring clears the interval and the foreground listener', async () => {
    api.post.mockResolvedValue({ data: { visit: { last_location_status: 'inside', log_out_alert_sent: false } } });
    startVisitMonitoring({ visit: VISIT });
    await jest.advanceTimersByTimeAsync(0); // let the immediate on-start check settle
    stopVisitMonitoring();
    api.post.mockClear();

    await jest.advanceTimersByTimeAsync(__testing.CHECK_INTERVAL_MS * 5);
    goToForeground();
    await jest.advanceTimersByTimeAsync(0);

    expect(api.post).not.toHaveBeenCalled();
  });
});
