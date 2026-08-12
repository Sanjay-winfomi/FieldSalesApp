import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import AssignedDealerCard from '../AssignedDealerCard';

const BASE_ASSIGNMENT = {
  id: 1,
  sequence_order: 2,
  dealer_name: 'Dealer A',
  dealer_address: '123 Main St',
  status: 'pending',
};

describe('AssignedDealerCard', () => {
  test('renders the manager-set order number and dealer info', async () => {
    const { getByText } = await render(<AssignedDealerCard assignment={BASE_ASSIGNMENT} onNavigate={() => {}} />);
    expect(getByText('2')).toBeTruthy();
    expect(getByText('Dealer A')).toBeTruthy();
    expect(getByText('123 Main St')).toBeTruthy();
    expect(getByText('Pending')).toBeTruthy();
  });

  test('calls onNavigate with the assignment when the Navigate button is pressed', async () => {
    const onNavigate = jest.fn();
    const { getByLabelText } = await render(<AssignedDealerCard assignment={BASE_ASSIGNMENT} onNavigate={onNavigate} />);
    fireEvent.press(getByLabelText('Navigate to Dealer A'));
    expect(onNavigate).toHaveBeenCalledWith(BASE_ASSIGNMENT);
  });

  test('shows distance/ETA once a navigation attempt has computed them', async () => {
    const assignment = {
      ...BASE_ASSIGNMENT,
      status: 'navigating',
      distance_meters: 4200,
      expected_arrival_time: new Date().toISOString(),
    };
    const { getByText } = await render(<AssignedDealerCard assignment={assignment} onNavigate={() => {}} />);
    expect(getByText('4.2 km')).toBeTruthy();
    expect(getByText('Navigating')).toBeTruthy();
  });

  test('shows an estimated (straight-line) distance before Navigate has been tapped', async () => {
    const { getByText } = await render(
      <AssignedDealerCard assignment={BASE_ASSIGNMENT} estimatedDistanceKm={3.2} onNavigate={() => {}} />
    );
    expect(getByText('~3.2 km')).toBeTruthy();
  });

  test('prefers the real routed distance over the estimate once both are available', async () => {
    const assignment = { ...BASE_ASSIGNMENT, status: 'navigating', distance_meters: 4200 };
    const { getByText, queryByText } = await render(
      <AssignedDealerCard assignment={assignment} estimatedDistanceKm={3.2} onNavigate={() => {}} />
    );
    expect(getByText('4.2 km')).toBeTruthy();
    expect(queryByText('~3.2 km')).toBeNull();
  });

  test('shows a "Get accurate distance" link when an estimate exists and onFetchAccurateDistance is provided', async () => {
    const onFetchAccurateDistance = jest.fn();
    const { getByLabelText } = await render(
      <AssignedDealerCard
        assignment={BASE_ASSIGNMENT}
        estimatedDistanceKm={3.2}
        onNavigate={() => {}}
        onFetchAccurateDistance={onFetchAccurateDistance}
      />
    );
    fireEvent.press(getByLabelText('Get accurate distance to Dealer A'));
    expect(onFetchAccurateDistance).toHaveBeenCalledWith(BASE_ASSIGNMENT);
  });

  test('prefers a fetched precise distance over the straight-line estimate, and hides the link once it has one', async () => {
    const { getByText, queryByLabelText } = await render(
      <AssignedDealerCard
        assignment={BASE_ASSIGNMENT}
        estimatedDistanceKm={3.2}
        preciseDistanceKm={2.8}
        onNavigate={() => {}}
        onFetchAccurateDistance={() => {}}
      />
    );
    expect(getByText('2.8 km')).toBeTruthy();
    expect(queryByLabelText('Get accurate distance to Dealer A')).toBeNull();
  });

  test('shows a loading state while fetching the precise distance', async () => {
    const { getByText, getByLabelText } = await render(
      <AssignedDealerCard
        assignment={BASE_ASSIGNMENT}
        estimatedDistanceKm={3.2}
        fetchingPreciseDistance
        onNavigate={() => {}}
        onFetchAccurateDistance={() => {}}
      />
    );
    expect(getByText('Getting distance…')).toBeTruthy();
    expect(getByLabelText('Get accurate distance to Dealer A')).toBeDisabled();
  });

  test('hides the Navigate button once completed', async () => {
    const assignment = { ...BASE_ASSIGNMENT, status: 'completed' };
    const { queryByLabelText } = await render(<AssignedDealerCard assignment={assignment} onNavigate={() => {}} />);
    expect(queryByLabelText('Navigate to Dealer A')).toBeNull();
  });

  test('does not render a "Request follow-up" link when onRequestFollowup is not provided', async () => {
    const { queryByLabelText } = await render(<AssignedDealerCard assignment={BASE_ASSIGNMENT} onNavigate={() => {}} />);
    expect(queryByLabelText('Request follow-up for Dealer A')).toBeNull();
  });

  test('calls onRequestFollowup with the assignment when the follow-up link is pressed', async () => {
    const onRequestFollowup = jest.fn();
    const { getByLabelText } = await render(
      <AssignedDealerCard assignment={BASE_ASSIGNMENT} onNavigate={() => {}} onRequestFollowup={onRequestFollowup} />
    );
    fireEvent.press(getByLabelText('Request follow-up for Dealer A'));
    expect(onRequestFollowup).toHaveBeenCalledWith(BASE_ASSIGNMENT);
  });
});
