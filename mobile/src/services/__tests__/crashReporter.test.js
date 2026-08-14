jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';
import { initCrashReporter, captureException, isInitialized, __testing } from '../crashReporter';

describe('initCrashReporter', () => {
  const originalEnv = process.env.EXPO_PUBLIC_SENTRY_DSN;
  afterEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_SENTRY_DSN = originalEnv;
  });

  test('no-ops when no DSN is configured', () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    initCrashReporter();
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  test('initializes Sentry with a beforeSend scrub hook when a DSN is set', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    initCrashReporter();
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
      beforeSend: expect.any(Function),
      sendDefaultPii: false,
    }));
  });
});

describe('captureException', () => {
  afterEach(() => jest.clearAllMocks());

  test('forwards the error to Sentry', () => {
    const error = new Error('boom');
    captureException(error);
    expect(Sentry.captureException).toHaveBeenCalledWith(error, undefined);
  });

  test('scrubs sensitive keys out of extra context before sending', () => {
    const error = new Error('boom');
    captureException(error, { area: 'appstate-listener', lat: 12.9716, dealer_name: 'Dealer A' });
    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      extra: { area: 'appstate-listener', lat: '[redacted]', dealer_name: '[redacted]' },
    });
  });

  test('does not throw if Sentry.captureException itself throws', () => {
    Sentry.captureException.mockImplementationOnce(() => { throw new Error('sentry down'); });
    expect(() => captureException(new Error('boom'))).not.toThrow();
  });
});

describe('scrubEvent', () => {
  test('removes event.user entirely', () => {
    const event = __testing.scrubEvent({ user: { username: 'arun' }, message: 'ok' });
    expect(event.user).toBeUndefined();
  });

  test('redacts coordinate-shaped numbers embedded in free-text messages', () => {
    const scrubbed = __testing.scrubString('GPS fix 12.9716,77.5946 out of radius');
    expect(scrubbed).toBe('GPS fix [coord],[coord] out of radius');
  });

  test('redacts sensitive keys in nested breadcrumb data', () => {
    const event = __testing.scrubEvent({
      breadcrumbs: [{ message: 'login attempt', data: { lat: 12.9, dealer_name: 'Dealer A', method: 'POST' } }],
    });
    expect(event.breadcrumbs[0].data).toEqual({ lat: '[redacted]', dealer_name: '[redacted]', method: 'POST' });
  });
});
