jest.mock('../../services/api', () => ({ api: { post: jest.fn() } }));
jest.mock('../../services/syncManager', () => ({
  enqueueAction: jest.fn(),
  isNetworkError: jest.fn(() => false),
}));
jest.mock('@react-native-community/datetimepicker', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  // Stub: tapping it fires onChange with a fixed future date. The real
  // component now renders this inside its own in-app sheet (spinner mode,
  // with a separate "Done" button confirming the pick) on both platforms,
  // so picking a date here no longer closes anything by itself.
  return function MockDateTimePicker({ onChange }) {
    return React.createElement(
      Pressable,
      { testID: 'mock-date-picker', onPress: () => onChange({ type: 'set' }, new Date('2099-01-02T00:00:00')) },
      React.createElement(Text, null, 'mock-date-picker')
    );
  };
});

jest.mock('../../services/themedAlert', () => ({ showAlert: jest.fn() }));

import React from 'react';
import { Platform } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { api } from '../../services/api';
import { enqueueAction, isNetworkError } from '../../services/syncManager';
import { showAlert } from '../../services/themedAlert';
import FollowupRequestModal from '../FollowupRequestModal';

Platform.OS = 'android';

const ASSIGNMENT = { id: 7, dealer_id: 15, dealer_name: 'Dealer A' };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function fillAndSubmit({ getByLabelText, getByText, getByPlaceholderText, findByTestId, queryByTestId }, reason = 'Dealer asked to come back tomorrow') {
  fireEvent.press(getByLabelText('Select follow-up date'));
  const picker = await findByTestId('mock-date-picker');
  fireEvent.press(picker);
  await flush();
  fireEvent.press(getByText('Done'));
  await waitFor(() => expect(queryByTestId('mock-date-picker')).toBeNull());
  await flush();
  fireEvent.changeText(getByPlaceholderText(/dealer asked to meet/i), reason);
  await flush();
  fireEvent.press(getByText('Send request'));
}

describe('FollowupRequestModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isNetworkError.mockReturnValue(false);
  });

  test('Send request is disabled until a date is picked and the reason is long enough', async () => {
    const utils = await render(
      <FollowupRequestModal visible assignment={ASSIGNMENT} onClose={jest.fn()} onSubmitted={jest.fn()} />
    );
    const sendButton = utils.getByText('Send request');
    expect(sendButton.props.disabled ?? sendButton.parent?.props?.accessibilityState?.disabled).toBeTruthy();
  });

  test('submits the request with the picked date and reason, then notifies success', async () => {
    api.post.mockResolvedValue({});
    const onSubmitted = jest.fn();
    const utils = await render(
      <FollowupRequestModal visible assignment={ASSIGNMENT} onClose={jest.fn()} onSubmitted={onSubmitted} />
    );

    await fillAndSubmit(utils);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/followup-requests', {
      dealer_id: 15,
      assignment_id: 7,
      requested_date: '2099-01-02',
      reason: 'Dealer asked to come back tomorrow',
    }));
    expect(showAlert).toHaveBeenCalledWith('Request sent', expect.any(String));
    expect(onSubmitted).toHaveBeenCalled();
  });

  test('queues the request offline and still calls onSubmitted when there is no network', async () => {
    isNetworkError.mockReturnValue(true);
    api.post.mockRejectedValue(new Error('network down'));
    const onSubmitted = jest.fn();
    const utils = await render(
      <FollowupRequestModal visible assignment={ASSIGNMENT} onClose={jest.fn()} onSubmitted={onSubmitted} />
    );

    await fillAndSubmit(utils);

    await waitFor(() => expect(enqueueAction).toHaveBeenCalledWith('post', '/followup-requests', expect.objectContaining({ dealer_id: 15 })));
    expect(showAlert).toHaveBeenCalledWith('Offline Mode', expect.any(String));
    expect(onSubmitted).toHaveBeenCalled();
  });

  test('shows a friendly message for a too-short reason from the server', async () => {
    api.post.mockRejectedValue({ response: { data: { error: 'reason_too_short' } } });
    const utils = await render(
      <FollowupRequestModal visible assignment={ASSIGNMENT} onClose={jest.fn()} onSubmitted={jest.fn()} />
    );

    await fillAndSubmit(utils);

    await waitFor(() => expect(showAlert).toHaveBeenCalledWith('Reason too short', expect.any(String)));
  });
});
