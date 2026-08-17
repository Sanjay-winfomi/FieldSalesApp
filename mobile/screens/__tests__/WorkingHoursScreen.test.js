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

// Business day rolls over at 5am IST (DAY_BOUNDARY_HOUR), not calendar
// midnight — mirrors activityHistory.js's own businessDate() so "today" here
// always lands in the same bucket the screen groups into, regardless of
// what time the test suite happens to run.
function todayLoginIso(hourIst = 10) {
  const now = new Date();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(now.getTime() + IST_OFFSET_MS);
  const businessDateIst = new Date(nowIst.getTime() - 5 * 60 * 60 * 1000);
  const y = businessDateIst.getUTCFullYear();
  const m = businessDateIst.getUTCMonth();
  const d = businessDateIst.getUTCDate();
  const loginIst = new Date(Date.UTC(y, m, d, hourIst));
  return new Date(loginIst.getTime() - IST_OFFSET_MS).toISOString();
}

describe('WorkingHoursScreen', () => {
  beforeEach(() => jest.clearAllMocks());

  test('shows only today\'s total (not the full history sum), with time spent per dealer', async () => {
    const todayLogin = todayLoginIso(4);
    const yesterdayLogin = new Date(new Date(todayLogin).getTime() - 24 * 60 * 60 * 1000).toISOString();
    api.get.mockImplementation((url) => {
      if (url === '/attendance') {
        return Promise.resolve({
          data: {
            attendance: [
              { login_time: todayLogin, total_distance_km: 1, total_duration_minutes: 320 },
              { login_time: yesterdayLogin, total_distance_km: 1, total_duration_minutes: 100 },
            ],
          },
        });
      }
      if (url === '/visits') {
        return Promise.resolve({
          data: {
            visits: [
              { id: 1, dealer_id: 10, dealer_name: 'Dealer A', login_time: todayLoginIso(5), logout_time: todayLoginIso(5.75), visit_duration_minutes: 45 },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const navigation = mockNavigation();
    const { findByText } = await render(<WorkingHoursScreen navigation={navigation} />);
    navigation._fireFocus();

    // Today only: 320 minutes = 5h 20m, NOT 320 + 100
    expect(await findByText('5h 20m')).toBeTruthy();
    expect(await findByText("Today's working hours")).toBeTruthy();
    expect(await findByText('45 min spent with dealer')).toBeTruthy();
    expect(await findByText('Dealer A')).toBeTruthy();
  });

  test('shows "currently with dealer" for a visit still in progress', async () => {
    const todayLogin = todayLoginIso(4);
    api.get.mockImplementation((url) => {
      if (url === '/attendance') {
        return Promise.resolve({ data: { attendance: [{ login_time: todayLogin, total_distance_km: 1, total_duration_minutes: 60 }] } });
      }
      if (url === '/visits') {
        return Promise.resolve({ data: { visits: [{ id: 1, dealer_id: 10, dealer_name: 'Dealer A', login_time: todayLoginIso(5), logout_time: null }] } });
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
