jest.mock('../../src/services/api', () => ({
  api: { get: jest.fn() },
}));

import React from 'react';
import { render } from '@testing-library/react-native';
import { api } from '../../src/services/api';
import DistanceHistoryScreen from '../DistanceHistoryScreen';

jest.setTimeout(15000);

function mockNavigation() {
  const listeners = {};
  return {
    goBack: jest.fn(),
    addListener: jest.fn((event, handler) => {
      listeners[event] = handler;
      return jest.fn();
    }),
    _fireFocus: () => listeners.focus?.(),
  };
}

describe('DistanceHistoryScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  test('shows the overall total and each day\'s distance, with km between stops', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') {
        return Promise.resolve({
          data: {
            attendance: [
              { login_time: '2026-08-10T04:00:00Z', total_distance_km: 12.4, total_duration_minutes: 300 },
              { login_time: '2026-08-09T04:00:00Z', total_distance_km: 5.6, total_duration_minutes: 200 },
            ],
          },
        });
      }
      if (url === '/visits') {
        return Promise.resolve({
          data: {
            visits: [
              { id: 1, dealer_id: 10, dealer_name: 'Dealer A', login_time: '2026-08-10T05:00:00Z', distance_from_previous_km: 3 },
              { id: 2, dealer_id: 11, dealer_name: 'Dealer B', login_time: '2026-08-10T06:00:00Z', distance_from_previous_km: 2.5 },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<DistanceHistoryScreen navigation={navigation} />);
    navigation._fireFocus();

    // Overall total: 12.4 + 5.6
    expect(await findByText('18.0 km')).toBeTruthy();
    expect(await findByText('Total distance travelled')).toBeTruthy();
    expect(await findByText('2.5 km from previous stop')).toBeTruthy();
    expect(await findByText('Dealer A')).toBeTruthy();
  });

  test('shows a "start of day" stop when there is no prior distance', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') {
        return Promise.resolve({ data: { attendance: [{ login_time: '2026-08-10T04:00:00Z', total_distance_km: 3, total_duration_minutes: 60 }] } });
      }
      if (url === '/visits') {
        return Promise.resolve({ data: { visits: [{ id: 1, dealer_id: 10, dealer_name: 'Dealer A', login_time: '2026-08-10T05:00:00Z', distance_from_previous_km: 0 }] } });
      }
      return Promise.reject(new Error('unexpected'));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<DistanceHistoryScreen navigation={navigation} />);
    navigation._fireFocus();

    expect(await findByText('Start of day')).toBeTruthy();
  });

  test('shows an empty state with no activity', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') return Promise.resolve({ data: { attendance: [] } });
      if (url === '/visits') return Promise.resolve({ data: { visits: [] } });
      return Promise.reject(new Error('unexpected'));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<DistanceHistoryScreen navigation={navigation} />);
    navigation._fireFocus();

    expect(await findByText('No distance recorded yet')).toBeTruthy();
  });
});
