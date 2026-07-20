import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';

const QUEUE_KEY = '@offline_action_queue';

/**
 * Enqueue an API request to be processed later.
 * @param {string} method - e.g., 'post', 'put'
 * @param {string} url - endpoint, e.g., '/visits/check-in'
 * @param {object} data - payload
 */
export const enqueueAction = async (method, url, data) => {
  try {
    const queueJson = await AsyncStorage.getItem(QUEUE_KEY);
    const queue = queueJson ? JSON.parse(queueJson) : [];
    
    queue.push({
      id: Date.now().toString(),
      method,
      url,
      data,
      timestamp: new Date().toISOString(),
    });
    
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    console.log(`Action queued: ${method} ${url}`);
  } catch (error) {
    console.error('Failed to enqueue action:', error);
  }
};

/**
 * Attempt to flush the queue to the server.
 */
export const flushQueue = async () => {
  try {
    const queueJson = await AsyncStorage.getItem(QUEUE_KEY);
    if (!queueJson) return;

    const queue = JSON.parse(queueJson);
    if (queue.length === 0) return;

    console.log(`Flushing ${queue.length} offline actions...`);

    const failedActions = [];

    for (const action of queue) {
      try {
        await api.request({
          method: action.method,
          url: action.url,
          data: action.data,
        });
        console.log(`Successfully synced action: ${action.id}`);
      } catch (error) {
        // If network error, keep it in the queue. 
        // If 400/500, we might want to discard or log it separately.
        console.warn(`Failed to sync action ${action.id}:`, error.message);
        failedActions.push(action);
      }
    }

    // Save back remaining failed actions
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(failedActions));
    
  } catch (error) {
    console.error('Error during flush queue:', error);
  }
};
