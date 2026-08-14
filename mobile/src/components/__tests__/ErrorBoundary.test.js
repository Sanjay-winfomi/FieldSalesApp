jest.mock('../../services/crashReporter', () => ({ captureException: jest.fn() }));
jest.mock('expo-updates', () => ({ reloadAsync: jest.fn(() => Promise.resolve()) }));

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { captureException } from '../../services/crashReporter';
import ErrorBoundary from '../ErrorBoundary';

function Bomb() {
  throw new Error('render blew up');
}

describe('ErrorBoundary', () => {
  afterEach(() => jest.clearAllMocks());

  test('reports the caught error to the crash reporter', async () => {
    // React logs the caught error to console.error internally too — silence
    // it for this test so the expected failure doesn't look like test noise.
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const { findByText } = await render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    expect(await findByText('Something went wrong')).toBeTruthy();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'render blew up' }),
      expect.objectContaining({ area: 'error-boundary' })
    );

    console.error.mockRestore();
  });

  test('renders children normally when nothing throws', async () => {
    const { Text } = require('react-native');
    const { findByText } = await render(
      <ErrorBoundary>
        <Text>all good</Text>
      </ErrorBoundary>
    );
    expect(await findByText('all good')).toBeTruthy();
    expect(captureException).not.toHaveBeenCalled();
  });
});
