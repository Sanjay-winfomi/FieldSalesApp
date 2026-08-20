jest.mock('../../src/services/api', () => ({
  api: { post: jest.fn(), patch: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../../src/services/location', () => ({
  getApproximateLocation: jest.fn(),
  haversineMeters: jest.fn(),
}));

import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { api } from '../../src/services/api';
import { getApproximateLocation, haversineMeters } from '../../src/services/location';
import { __fitToCoordinatesMock } from 'react-native-maps';
import DealerNavigationScreen from '../DealerNavigationScreen';

// The first render in this file pays a one-time cold-start cost for the
// icon/SVG/map mock transform pipeline — comfortably past the default 5s
// per-test timeout on a slower machine, even though the component itself
// resolves in well under a second.
jest.setTimeout(15000);

const ASSIGNMENT = {
  id: 5,
  dealer_id: 20,
  dealer_name: 'Dealer A',
  dealer_address: '123 Main St',
  dealer_lat: 13.0,
  dealer_lng: 77.0,
  radius_meters: 200,
};

describe('DealerNavigationScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('shows an error state when GPS location cannot be acquired', async () => {
    getApproximateLocation.mockResolvedValue(null);

    const { findByText } = await render(
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) }} onArrived={jest.fn()} />
    );

    expect(await findByText(/Could not get your GPS location/)).toBeTruthy();
  });

  test('computes and displays the route once GPS and the backend succeed', async () => {
    getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });
    api.post.mockResolvedValue({
      data: {
        navigation: {
          id: 100,
          status: 'navigating',
          distance_meters: 4200,
          duration_seconds: 600,
          duration_in_traffic_seconds: 660,
          expected_arrival_time: new Date().toISOString(),
          encoded_polyline: null,
        },
      },
    });

    const { findByText } = await render(
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) }} onArrived={jest.fn()} />
    );

    expect(await findByText('4.2 km')).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith('/navigation/compute', {
      dealer_id: 20,
      assignment_id: 5,
      origin_lat: 12.9,
      origin_lng: 77.6,
    });
  });

  test('shows a retry message when the backend cannot reach Google (no straight-line fallback exists anymore)', async () => {
    getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });
    api.post.mockRejectedValue({ response: { status: 502, data: { error: 'route_computation_failed', message: 'Request timed out — Retry' } } });

    const { findByText } = await render(
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) }} onArrived={jest.fn()} />
    );

    expect(await findByText('Request timed out — Retry')).toBeTruthy();
  });

  test('surfaces a distinct message for a dealer with no registered coordinates', async () => {
    getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });

    const { findByText } = await render(
      <DealerNavigationScreen
        assignment={{ ...ASSIGNMENT, dealer_lat: null, dealer_lng: null }}
        navigation={{ goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) }}
        onArrived={jest.fn()}
      />
    );

    expect(await findByText(/no registered coordinates/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  test('treats a non-numeric dealer coordinate as missing rather than crashing on NaN', async () => {
    getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });

    const { findByText } = await render(
      <DealerNavigationScreen
        assignment={{ ...ASSIGNMENT, dealer_lat: 'not-a-number', dealer_lng: 'also-bad' }}
        navigation={{ goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) }}
        onArrived={jest.fn()}
      />
    );

    expect(await findByText(/no registered coordinates/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  test('fits the map to both the rep and dealer markers once ready, instead of relying on Android\'s unreliable initialRegion', async () => {
    getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });
    api.post.mockResolvedValue({
      data: { navigation: { id: 100, status: 'navigating', distance_meters: 4200, duration_seconds: 600, duration_in_traffic_seconds: 660, encoded_polyline: null } },
    });

    await render(
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) }} onArrived={jest.fn()} />
    );

    await waitFor(() => expect(__fitToCoordinatesMock).toHaveBeenCalledWith(
      [{ latitude: 12.9, longitude: 77.6 }, { latitude: 13.0, longitude: 77.0 }],
      expect.objectContaining({ animated: false })
    ));
  });

  test('cancelling stops the position poll and patches the backend before navigating back', async () => {
    getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });
    api.post.mockResolvedValue({
      data: {
        navigation: {
          id: 100,
          status: 'navigating',
          distance_meters: 4200,
          duration_seconds: 600,
          duration_in_traffic_seconds: 660,
          expected_arrival_time: new Date().toISOString(),
          encoded_polyline: null,
        },
      },
    });
    const goBack = jest.fn();

    const { findByText, getByText } = await render(
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack, addListener: jest.fn(() => jest.fn()) }} onArrived={jest.fn()} />
    );

    await findByText('4.2 km');
    fireEvent.press(getByText('Cancel navigation'));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/navigation/100/status', { status: 'cancelled' }));
    expect(goBack).toHaveBeenCalled();
  });

  test('does not start a second position check while one is still in flight', async () => {
    jest.useFakeTimers();
    try {
      api.post.mockResolvedValue({
        data: { navigation: { id: 100, status: 'navigating', distance_meters: 4200, duration_seconds: 600 } },
      });
      // Mount's own computeRoute() call resolves immediately...
      getApproximateLocation.mockResolvedValueOnce({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });
      // ...but every poll tick after that hangs until the test resolves it,
      // simulating a slow getApproximateLocation() call that overruns
      // POSITION_POLL_MS.
      let resolvePoll;
      getApproximateLocation.mockImplementation(() => new Promise((resolve) => { resolvePoll = resolve; }));
      haversineMeters.mockReturnValue(9999);

      const navigation = { goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) };
      const { findByText } = await render(
        <DealerNavigationScreen assignment={ASSIGNMENT} navigation={navigation} onArrived={jest.fn()} />
      );
      await findByText('4.2 km');
      const callsAfterMount = getApproximateLocation.mock.calls.length;

      const POSITION_POLL_MS = 15000;
      // First poll tick starts and hangs.
      await jest.advanceTimersByTimeAsync(POSITION_POLL_MS);
      expect(getApproximateLocation.mock.calls.length - callsAfterMount).toBe(1);

      // A second interval tick fires while the first is still unresolved —
      // without the in-flight guard this used to start a second concurrent
      // getApproximateLocation() call.
      await jest.advanceTimersByTimeAsync(POSITION_POLL_MS);
      expect(getApproximateLocation.mock.calls.length - callsAfterMount).toBe(1);

      // Only once the hung call finally resolves does the next tick proceed.
      resolvePoll({ lat: 13.0, lng: 77.0, accuracyMeters: 10 });
      await jest.advanceTimersByTimeAsync(0);
      getApproximateLocation.mockImplementation(() => Promise.resolve({ lat: 13.0, lng: 77.0, accuracyMeters: 10 }));
      await jest.advanceTimersByTimeAsync(POSITION_POLL_MS);
      expect(getApproximateLocation.mock.calls.length - callsAfterMount).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('pauses position polling while the screen is not focused, resumes on refocus', async () => {
    jest.useFakeTimers();
    try {
      api.post.mockResolvedValue({
        data: { navigation: { id: 100, status: 'navigating', distance_meters: 4200, duration_seconds: 600 } },
      });
      getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });
      haversineMeters.mockReturnValue(9999);

      const listeners = {};
      const navigation = {
        goBack: jest.fn(),
        addListener: jest.fn((event, handler) => {
          listeners[event] = handler;
          return jest.fn();
        }),
      };
      const { findByText } = await render(
        <DealerNavigationScreen assignment={ASSIGNMENT} navigation={navigation} onArrived={jest.fn()} />
      );
      await findByText('4.2 km');

      const POSITION_POLL_MS = 15000;
      const callsBeforeBlur = getApproximateLocation.mock.calls.length;

      listeners.blur();
      await jest.advanceTimersByTimeAsync(POSITION_POLL_MS * 3);
      // Blurred (e.g. this screen is still mounted underneath a pushed
      // Check-In screen reached via an arrival notification) — no further
      // GPS calls while the rep can't even see this screen.
      expect(getApproximateLocation.mock.calls.length).toBe(callsBeforeBlur);

      listeners.focus();
      await jest.advanceTimersByTimeAsync(POSITION_POLL_MS);
      expect(getApproximateLocation.mock.calls.length).toBeGreaterThan(callsBeforeBlur);
    } finally {
      jest.useRealTimers();
    }
  });
});
