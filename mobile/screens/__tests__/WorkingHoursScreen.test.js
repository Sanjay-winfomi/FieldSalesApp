jest.mock('../../src/services/api', () => ({
  api: { get: jest.fn() },
}));

import React from 'react';
import { render } from '@testing-library/react-native';
import { api } from '../../src/services/api';
import WorkingHoursScreen from '../WorkingHoursScreen';

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

describe('WorkingHoursScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  test('shows the overall total and each day\'s hours, with time spent per dealer', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') {
        return Promise.resolve({
          data: {
            attendance: [
              { login_time: '2026-08-10T04:00:00Z', total_distance_km: 1, total_duration_minutes: 320 },
              { login_time: '2026-08-09T04:00:00Z', total_distance_km: 1, total_duration_minutes: 100 },
            ],
          },
        });
      }
      if (url === '/visits') {
        return Promise.resolve({
          data: {
            visits: [
              { id: 1, dealer_id: 10, dealer_name: 'Dealer A', login_time: '2026-08-10T05:00:00Z', logout_time: '2026-08-10T05:45:00Z', visit_duration_minutes: 45 },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<WorkingHoursScreen navigation={navigation} />);
    navigation._fireFocus();

    // Overall total: 320 + 100 minutes = 7h 0m
    expect(await findByText('7h 0m')).toBeTruthy();
    expect(await findByText('Total working hours')).toBeTruthy();
    expect(await findByText('45 min spent with dealer')).toBeTruthy();
    expect(await findByText('Dealer A')).toBeTruthy();
  });

  test('shows "currently with dealer" for a visit still in progress', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') {
        return Promise.resolve({ data: { attendance: [{ login_time: '2026-08-10T04:00:00Z', total_distance_km: 1, total_duration_minutes: 60 }] } });
      }
      if (url === '/visits') {
        return Promise.resolve({ data: { visits: [{ id: 1, dealer_id: 10, dealer_name: 'Dealer A', login_time: '2026-08-10T05:00:00Z', logout_time: null }] } });
      }
      return Promise.reject(new Error('unexpected'));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<WorkingHoursScreen navigation={navigation} />);
    navigation._fireFocus();

    expect(await findByText('Currently with dealer')).toBeTruthy();
  });

  test('shows an empty state with no activity', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/attendance') return Promise.resolve({ data: { attendance: [] } });
      if (url === '/visits') return Promise.resolve({ data: { visits: [] } });
      return Promise.reject(new Error('unexpected'));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<WorkingHoursScreen navigation={navigation} />);
    navigation._fireFocus();

    expect(await findByText('No working hours recorded yet')).toBeTruthy();
  });
});
