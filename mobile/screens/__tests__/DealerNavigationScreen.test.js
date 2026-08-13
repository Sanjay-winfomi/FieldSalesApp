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
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack: jest.fn() }} onArrived={jest.fn()} />
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
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack: jest.fn() }} onArrived={jest.fn()} />
    );

    expect(await findByText('4.2 km')).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith('/navigation/compute', {
      dealer_id: 20,
      assignment_id: 5,
      origin_lat: 12.9,
      origin_lng: 77.6,
    });
  });

  test('shows a friendly message when the backend cannot reach Google', async () => {
    getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });
    api.post.mockRejectedValue({ response: { status: 502 } });

    const { findByText } = await render(
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack: jest.fn() }} onArrived={jest.fn()} />
    );

    expect(await findByText(/Couldn't reach Google's directions service/)).toBeTruthy();
  });

  test('surfaces a distinct message for a dealer with no registered coordinates', async () => {
    getApproximateLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });

    const { findByText } = await render(
      <DealerNavigationScreen
        assignment={{ ...ASSIGNMENT, dealer_lat: null, dealer_lng: null }}
        navigation={{ goBack: jest.fn() }}
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
        navigation={{ goBack: jest.fn() }}
        onArrived={jest.fn()}
      />
    );

    expect(await findByText(/no registered coordinates/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
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
      <DealerNavigationScreen assignment={ASSIGNMENT} navigation={{ goBack }} onArrived={jest.fn()} />
    );

    await findByText('4.2 km');
    fireEvent.press(getByText('Cancel navigation'));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/navigation/100/status', { status: 'cancelled' }));
    expect(goBack).toHaveBeenCalled();
  });
});
