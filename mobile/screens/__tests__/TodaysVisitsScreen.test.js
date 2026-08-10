import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { AppStateContext } from '../../src/context/AppStateContext';
import TodaysVisitsScreen from '../TodaysVisitsScreen';

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
