jest.mock('../api', () => ({ api: { request: jest.fn() } }));
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => () => {}),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api';
import {
  enqueueAction,
  getPendingCount,
  clearQueue,
  flushQueue,
  setConflictHandler,
} from '../syncManager';

const QUEUE_KEY = '@offline_action_queue';

describe('syncManager', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    api.request.mockReset();
    setConflictHandler(null);
  });

  test('enqueueAction persists an action and getPendingCount reflects it', async () => {
    await enqueueAction('post', '/attendance/check-in', { lat: 1, lng: 2 });
    expect(await getPendingCount()).toBe(1);
  });

  test('clearQueue empties the queue', async () => {
    await enqueueAction('post', '/attendance/check-in', { lat: 1, lng: 2 });
    await clearQueue();
    expect(await getPendingCount()).toBe(0);
  });

  test('flushQueue sends queued actions and removes them on success', async () => {
    await enqueueAction('post', '/attendance/check-in', { lat: 1, lng: 2 });
    api.request.mockResolvedValueOnce({ data: { attendance: { id: 10 } } });

    await flushQueue();

    expect(api.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post', url: '/attendance/check-in' })
    );
    expect(await getPendingCount()).toBe(0);
  });

  test('resolves a temp offline id in a dependent queued action once the first syncs', async () => {
    const localId = 'offline-123';
    await enqueueAction('post', '/attendance/check-in', { lat: 1, lng: 2 }, { localId, resolves: 'attendance' });
    await enqueueAction('post', '/visits/check-in', { attendance_id: localId, dealer_id: 5 });

    api.request
      .mockResolvedValueOnce({ data: { attendance: { id: 77 } } })
      .mockResolvedValueOnce({ data: { visit: { id: 200 } } });

    await flushQueue();

    expect(api.request.mock.calls[1][0].data.attendance_id).toBe(77);
    expect(await getPendingCount()).toBe(0);
  });

  test('keeps a network-failed action queued for retry', async () => {
    await enqueueAction('post', '/attendance/check-in', { lat: 1, lng: 2 });
    api.request.mockRejectedValueOnce({ code: 'ERR_NETWORK', message: 'Network Error' });

    await flushQueue();

    expect(await getPendingCount()).toBe(1);
  });

  test('reconciles a 409 conflict via the conflict handler instead of silently dropping it', async () => {
    await enqueueAction('post', '/attendance/check-out', { attendance_id: 5, lat: 1, lng: 2 });
    api.request.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'Already checked out today', attendance: { id: 5, check_out_time: 'now' } } },
    });
    const conflictHandler = jest.fn();
    setConflictHandler(conflictHandler);

    await flushQueue();

    expect(conflictHandler).toHaveBeenCalledWith(
      expect.objectContaining({ serverError: 'Already checked out today', attendance: { id: 5, check_out_time: 'now' } })
    );
    // The conflicting action is reconciled away, not left stuck in the queue.
    expect(await getPendingCount()).toBe(0);
  });

  test('discards a genuine client error after exceeding max retries', async () => {
    const queue = [{
      id: 'a1', method: 'post', url: '/visits/check-in', data: {}, localId: null, resolves: null,
      retryCount: 8, timestamp: new Date().toISOString(),
    }];
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    api.request.mockRejectedValueOnce({ response: { status: 400, data: { error: 'bad request' } } });

    await flushQueue();

    expect(await getPendingCount()).toBe(0);
  });
});
