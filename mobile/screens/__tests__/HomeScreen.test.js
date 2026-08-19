import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { AppStateContext, PendingSyncContext } from '../../src/context/AppStateContext';
import HomeScreen from '../HomeScreen';

jest.mock('../../src/services/location', () => ({
  openBatteryOptimizationSettings: jest.fn(),
}));
jest.mock('../../src/services/miui', () => ({ isMiuiDevice: jest.fn(() => false) }));

const NEARBY_DEALER = {
  regionId: 'assignment-1', assignmentId: 1, dealerId: 10, dealerName: 'Dealer A',
  dealerAddress: 'Addr A', dealerLat: 11.0, dealerLng: 77.0, radiusMeters: 150,
};

async function renderScreen(overrides = {}) {
  const value = {
    employee: { name: 'Rep One', role: 'rep' },
    dayStatus: 'logged_in',
    pendingVisitsCount: 0,
    distanceTravelled: '0.0 km',
    attendance: { login_time: new Date().toISOString() },
    visits: [],
    refreshing: false,
    locationPermissionDenied: false,
    locationPermissionCanAskAgain: true,
    backgroundLocationDenied: false,
    onOpenLocationSettings: jest.fn(),
    fetchTodayState: jest.fn(),
    onSelectDealer: jest.fn(),
    fetchAssignedDealers: jest.fn(),
    nearbyDealer: null,
    refreshNearbyDealer: jest.fn(),
    ...overrides,
  };
  const focusCallbacks = [];
  const navigation = {
    navigate: jest.fn(),
    addListener: jest.fn((event, cb) => {
      if (event === 'focus') focusCallbacks.push(cb);
      return jest.fn();
    }),
  };
  const utils = await render(
    <AppStateContext.Provider value={value}>
      <PendingSyncContext.Provider value={{ pendingSyncCount: 0, setPendingSyncCount: jest.fn() }}>
        <HomeScreen navigation={navigation} />
      </PendingSyncContext.Provider>
    </AppStateContext.Provider>
  );
  return { ...utils, value, navigation, focusCallbacks };
}

describe('HomeScreen', () => {
  test('shows no "Dealer login" card when no assigned dealer is nearby', async () => {
    const { queryByText } = await renderScreen();
    expect(queryByText('Dealer login')).toBeNull();
  });

  test('shows a "Dealer login" card when an assigned dealer is nearby', async () => {
    const { findByText } = await renderScreen({ nearbyDealer: NEARBY_DEALER });
    expect(await findByText("You're near a dealer")).toBeTruthy();
    expect(await findByText('Dealer A')).toBeTruthy();
    expect(await findByText('Dealer login')).toBeTruthy();
  });

  test('hides the card when there is already an active (open) visit', async () => {
    const { queryByText } = await renderScreen({
      nearbyDealer: NEARBY_DEALER,
      visits: [{ dealer_id: 99, dealer_name: 'Dealer B', logout_time: null }],
    });
    expect(queryByText('Dealer login')).toBeNull();
  });

  test('hides the card when the rep has not logged in for the day', async () => {
    const { queryByText } = await renderScreen({ dayStatus: 'not_logged_in', attendance: null, nearbyDealer: NEARBY_DEALER });
    expect(queryByText('Dealer login')).toBeNull();
  });

  test('tapping "Dealer login" calls onSelectDealer with the nearby dealer, mapped to the shape DealerLoginScreen expects', async () => {
    const { findByText, value, navigation } = await renderScreen({ nearbyDealer: NEARBY_DEALER });
    fireEvent.press(await findByText('Dealer login'));

    expect(value.onSelectDealer).toHaveBeenCalledWith(
      { id: 10, name: 'Dealer A', address: 'Addr A', latitude: 11.0, longitude: 77.0, radius_meters: 150 },
      true,
      navigation
    );
  });

  test('refreshes the nearby-dealer check whenever the tab regains focus, alongside the assigned-dealer list', async () => {
    const { value, focusCallbacks } = await renderScreen();
    expect(focusCallbacks.length).toBe(1);

    focusCallbacks[0]();

    expect(value.fetchAssignedDealers).toHaveBeenCalled();
    expect(value.refreshNearbyDealer).toHaveBeenCalled();
  });
});
