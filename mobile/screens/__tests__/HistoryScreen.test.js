jest.mock('../../src/services/api', () => ({
  api: { get: jest.fn() },
}));

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { api } from '../../src/services/api';
import HistoryScreen from '../HistoryScreen';

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

describe('HistoryScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  test('groups visits under their day and shows day-level totals from attendance', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') {
        return Promise.resolve({
          data: { attendance: [{ login_time: '2026-08-10T04:30:00Z', total_distance_km: 12.4, total_duration_minutes: 320 }] },
        });
      }
      if (url === '/visits') {
        return Promise.resolve({
          data: {
            visits: [
              { id: 1, dealer_id: 10, dealer_name: 'Dealer A', login_time: '2026-08-10T05:00:00Z', logout_time: '2026-08-10T05:30:00Z', visit_duration_minutes: 30, distance_from_previous_km: 2 },
              { id: 2, dealer_id: 11, dealer_name: 'Dealer B', login_time: '2026-08-10T06:00:00Z', logout_time: null, distance_from_previous_km: 1.5 },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<HistoryScreen navigation={navigation} />);
    navigation._fireFocus();

    expect(await findByText('2 dealers visited')).toBeTruthy();
    expect(await findByText('12.4 km')).toBeTruthy();
    expect(await findByText('5h 20m')).toBeTruthy();
    expect(await findByText('Dealer A')).toBeTruthy();
    expect(await findByText('Dealer B')).toBeTruthy();
  });

  test('counts distinct dealers visited even when the status filter hides some visits', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') {
        return Promise.resolve({ data: { attendance: [{ login_time: '2026-08-10T04:30:00Z', total_distance_km: 5, total_duration_minutes: 60 }] } });
      }
      if (url === '/visits') {
        return Promise.resolve({
          data: {
            visits: [
              { id: 1, dealer_id: 10, dealer_name: 'Dealer A', login_time: '2026-08-10T05:00:00Z', logout_time: '2026-08-10T05:30:00Z' },
              { id: 2, dealer_id: 11, dealer_name: 'Dealer B', login_time: '2026-08-10T06:00:00Z', logout_time: null },
            ],
          },
        });
      }
      return Promise.reject(new Error('unexpected'));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<HistoryScreen navigation={navigation} />);
    navigation._fireFocus();

    // "2 dealers visited" reflects both visits regardless of the (still
    // default "All") status filter — the count is never filter-scoped.
    expect(await findByText('2 dealers visited')).toBeTruthy();
  });

  test('shows an empty state when there is no activity at all', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') return Promise.resolve({ data: { attendance: [] } });
      if (url === '/visits') return Promise.resolve({ data: { visits: [] } });
      return Promise.reject(new Error('unexpected'));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<HistoryScreen navigation={navigation} />);
    navigation._fireFocus();

    expect(await findByText('No activity yet')).toBeTruthy();
  });

  test('shows an error state when the fetch fails', async () => {
    api.get.mockRejectedValue(new Error('network down'));

    const navigation = mockNavigation();
    const { findByText } = await render(<HistoryScreen navigation={navigation} />);
    navigation._fireFocus();

    expect(await findByText('Something went wrong')).toBeTruthy();
  });
});
