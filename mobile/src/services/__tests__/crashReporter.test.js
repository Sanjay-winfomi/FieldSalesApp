import { initCrashReporter, captureException, isInitialized } from '../crashReporter';

describe('crashReporter (local-only, no external reporting)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('initCrashReporter marks the reporter as initialized', () => {
    initCrashReporter();
    expect(isInitialized()).toBe(true);
  });

  test('captureException logs the error locally without throwing', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    expect(() => captureException(error, { area: 'appstate-listener' })).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('[crashReporter]', error, { area: 'appstate-listener' });
  });

  test('captureException tolerates a missing context', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    expect(() => captureException(error)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('[crashReporter]', error, '');
  });
});
