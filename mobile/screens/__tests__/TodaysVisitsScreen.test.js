import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { AppStateContext } from '../../src/context/AppStateContext';
import { getApproximateLocation } from '../../src/services/location';
import { api } from '../../src/services/api';
import TodaysVisitsScreen from '../TodaysVisitsScreen';

jest.mock('../../src/services/location', () => ({
  getApproximateLocation: jest.fn(() => Promise.resolve(null)),
  haversineMeters: jest.requireActual('../../src/services/location').haversineMeters,
}));

jest.mock('../../src/services/api', () => ({ api: { post: jest.fn() } }));

// First render in this file pays a one-time cold-start cost for the
// icon/SVG transform pipeline, same as DealerNavigationScreen.test.js.
jest.setTimeout(15000);

const ASSIGNMENT_A = {
  id: 1, sequence_order: 1, dealer_name: 'Dealer A', dealer_address: 'Addr A', status: 'pending',
};
const ASSIGNMENT_B = {
  id: 2, sequence_order: 2, dealer_name: 'Dealer B', dealer_address: 'Addr B', status: 'pending',
};

async function renderScreen(overrides = {}) {
  const value = {
    assignedDealers: [],
    fetchAssignedDealers: jest.fn(),
    onSelectAssignment: jest.fn(),
    ...overrides,
  };
  const navigation = { goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) };
  const utils = await render(
    <AppStateContext.Provider value={value}>
      <TodaysVisitsScreen navigation={navigation} />
    </AppStateContext.Provider>
  );
  return { ...utils, value, navigation };
}

describe('TodaysVisitsScreen', () => {
  test('shows an empty state when nothing is assigned today', async () => {
    const { findByText } = await renderScreen();
    expect(await findByText('No dealers assigned today')).toBeTruthy();
  });

  test('lists every assigned dealer in order', async () => {
    const { findByText } = await renderScreen({ assignedDealers: [ASSIGNMENT_A, ASSIGNMENT_B] });
    expect(await findByText('Dealer A')).toBeTruthy();
    expect(await findByText('Dealer B')).toBeTruthy();
  });

  test('tapping Navigate on a card calls onSelectAssignment with that assignment', async () => {
    const { findByLabelText, value, navigation } = await renderScreen({ assignedDealers: [ASSIGNMENT_A] });
    fireEvent.press(await findByLabelText('Navigate to Dealer A'));
    expect(value.onSelectAssignment).toHaveBeenCalledWith(ASSIGNMENT_A, navigation);
  });

  test('tapping "Request follow-up" opens the modal for that assignment', async () => {
    const { findByLabelText, findByText, queryByText } = await renderScreen({ assignedDealers: [ASSIGNMENT_A] });

    // Modal-only content ("Send request" submit button) isn't present
    // until a card's follow-up link is tapped.
    expect(queryByText('Send request')).toBeNull();

    fireEvent.press(await findByLabelText('Request follow-up for Dealer A'));

    expect(await findByText('Send request')).toBeTruthy();
    expect(await findByText('Follow-up date')).toBeTruthy();
  });

  test('shows an estimated distance once a GPS fix arrives, for a dealer with no routed distance yet', async () => {
    getApproximateLocation.mockResolvedValueOnce({ lat: 11.0098, lng: 76.9558, accuracyMeters: 10 });
    const assignmentWithCoords = { ...ASSIGNMENT_A, dealer_lat: 11.0234, dealer_lng: 77.0012 };
    let focusHandler;
    const navigation = {
      goBack: jest.fn(),
      addListener: jest.fn((event, handler) => {
        if (event === 'focus') focusHandler = handler;
        return jest.fn();
      }),
    };
    const { findByText } = await render(
      <AppStateContext.Provider value={{
        assignedDealers: [assignmentWithCoords], fetchAssignedDealers: jest.fn(), onSelectAssignment: jest.fn(),
      }}>
        <TodaysVisitsScreen navigation={navigation} />
      </AppStateContext.Provider>
    );

    focusHandler();

    expect(await findByText(/~5\.\d km/)).toBeTruthy();
  });

  test('tapping "Get accurate distance" fetches a real Google Maps distance and replaces the estimate', async () => {
    getApproximateLocation.mockResolvedValueOnce({ lat: 11.0098, lng: 76.9558, accuracyMeters: 10 });
    api.post.mockResolvedValueOnce({ data: { distanceMeters: 4800, durationSeconds: 500, durationInTrafficSeconds: 540 } });
    const assignmentWithCoords = { ...ASSIGNMENT_A, dealer_lat: 11.0234, dealer_lng: 77.0012 };
    let focusHandler;
    const navigation = {
      goBack: jest.fn(),
      addListener: jest.fn((event, handler) => {
        if (event === 'focus') focusHandler = handler;
        return jest.fn();
      }),
    };
    const { findByText, findByLabelText, queryByLabelText } = await render(
      <AppStateContext.Provider value={{
        assignedDealers: [assignmentWithCoords], fetchAssignedDealers: jest.fn(), onSelectAssignment: jest.fn(),
      }}>
        <TodaysVisitsScreen navigation={navigation} />
      </AppStateContext.Provider>
    );
    focusHandler();
    await findByText(/~5\.\d km/);

    fireEvent.press(await findByLabelText('Get accurate distance to Dealer A'));

    expect(await findByText('4.8 km')).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith('/navigation/distance-preview', {
      origin_lat: 11.0098, origin_lng: 76.9558, dest_lat: 11.0234, dest_lng: 77.0012,
    });
    expect(queryByLabelText('Get accurate distance to Dealer A')).toBeNull();
  });

  test('refreshes the assigned-dealer list when the screen gains focus', async () => {
    const fetchAssignedDealers = jest.fn();
    let focusHandler;
    const navigation = {
      goBack: jest.fn(),
      addListener: jest.fn((event, handler) => {
        if (event === 'focus') focusHandler = handler;
        return jest.fn();
      }),
    };
    await render(
      <AppStateContext.Provider value={{ assignedDealers: [], fetchAssignedDealers, onSelectAssignment: jest.fn() }}>
        <TodaysVisitsScreen navigation={navigation} />
      </AppStateContext.Provider>
    );
    expect(navigation.addListener).toHaveBeenCalledWith('focus', expect.any(Function));
    focusHandler();
    expect(fetchAssignedDealers).toHaveBeenCalled();
  });
});
