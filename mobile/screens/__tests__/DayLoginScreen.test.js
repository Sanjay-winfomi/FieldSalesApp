jest.mock('../../src/services/api', () => ({
  api: { post: jest.fn() },
}));
jest.mock('../../src/services/location', () => ({
  getCurrentLocation: jest.fn(),
  getReadableAddress: jest.fn(() => Promise.resolve('123 Main St')),
  MAX_ACCEPTABLE_ACCURACY_METERS: 30,
}));
jest.mock('../../src/services/syncManager', () => ({
  enqueueAction: jest.fn(() => Promise.resolve()),
}));

import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { api } from '../../src/services/api';
import { getCurrentLocation } from '../../src/services/location';
import DayLoginScreen from '../DayLoginScreen';

jest.setTimeout(15000);

const navigation = { goBack: jest.fn() };

describe('DayLoginScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('defaults to Field visit mode, with Login disabled while GPS accuracy is poor', async () => {
    getCurrentLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 80 });

    const { findByText, findByRole } = await render(
      <DayLoginScreen onLogin={jest.fn()} onAlreadyLoggedIn={jest.fn()} navigation={navigation} />
    );

    await findByText(/GPS accuracy is/);
    const loginBtn = await findByRole('button', { name: 'Login for the day' });
    expect(loginBtn.props.accessibilityState.disabled).toBe(true);

    fireEvent.press(loginBtn);
    expect(api.post).not.toHaveBeenCalled();
  });

  test('selecting Office day drops the accuracy gate and sends work_mode: office', async () => {
    getCurrentLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 80 });
    api.post.mockResolvedValue({ data: { attendance: { id: 5, login_time: new Date().toISOString(), work_mode: 'office' } } });
    const onLogin = jest.fn();

    const { findByLabelText, findByText } = await render(
      <DayLoginScreen onLogin={onLogin} onAlreadyLoggedIn={jest.fn()} navigation={navigation} />
    );

    fireEvent.press(await findByLabelText('Office day, not visiting dealers'));
    expect(await findByText(/Marks today as an office day/)).toBeTruthy();

    fireEvent.press(await findByText('Login for the day'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/attendance/login',
      expect.objectContaining({ work_mode: 'office' })
    ));
    await waitFor(() => expect(onLogin).toHaveBeenCalled());
  });

  test('selecting Office day before GPS resolves logs in with no location at all', async () => {
    // GPS never resolves in this test — proves office day doesn't wait on
    // (or need) a location fix to become submittable.
    getCurrentLocation.mockReturnValue(new Promise(() => {}));
    api.post.mockResolvedValue({ data: { attendance: { id: 6, login_time: new Date().toISOString(), work_mode: 'office' } } });
    const onLogin = jest.fn();

    const { findByLabelText, findByText, findByRole } = await render(
      <DayLoginScreen onLogin={onLogin} onAlreadyLoggedIn={jest.fn()} navigation={navigation} />
    );

    fireEvent.press(await findByLabelText('Office day, not visiting dealers'));
    expect(await findByText('No location needed for an office day.')).toBeTruthy();

    const loginBtn = await findByRole('button', { name: 'Login for the day' });
    expect(loginBtn.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(loginBtn);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/attendance/login', { work_mode: 'office' }));
    await waitFor(() => expect(onLogin).toHaveBeenCalled());

    // Only the one call from the initial (default field mode) mount — never
    // called again after switching to office.
    expect(getCurrentLocation).toHaveBeenCalledTimes(1);
  });

  test('field mode (the default) sends work_mode: field', async () => {
    getCurrentLocation.mockResolvedValue({ lat: 12.9, lng: 77.6, accuracyMeters: 10 });
    api.post.mockResolvedValue({ data: { attendance: { id: 5, login_time: new Date().toISOString(), work_mode: 'field' } } });

    const { findByText } = await render(
      <DayLoginScreen onLogin={jest.fn()} onAlreadyLoggedIn={jest.fn()} navigation={navigation} />
    );

    fireEvent.press(await findByText('Login for the day'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/attendance/login',
      expect.objectContaining({ work_mode: 'field' })
    ));
  });
});
