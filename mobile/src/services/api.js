import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// Handle localhost routing for Android emulator vs iOS/Web
// For real devices, replace with the IP address of your machine running the backend
const getBaseUrl = () => {
  // 192.168.1.5 = this machine's LAN IP, required for Expo Go on a real
  // physical device (10.0.2.2 only works for the Android emulator, and
  // localhost only works if the app itself is running on this machine).
  // TODO before Stage 11: move this to an environment variable instead
  // of a hardcoded IP.
  return 'http://192.168.1.5:3001/api';
};

const BASE_URL = getBaseUrl();

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
});

// Interceptor to add auth token
api.interceptors.request.use(
  async (config) => {
    const token = await SecureStore.getItemAsync('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Interceptor to handle token refresh on 401
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    
    // If error is 401 and we haven't retried yet
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      
      try {
        const refreshToken = await SecureStore.getItemAsync('refreshToken');
        if (!refreshToken) {
          throw new Error('No refresh token available');
        }
        
        // Call refresh endpoint directly using axios to avoid loops
        const response = await axios.post(`${BASE_URL}/auth/refresh`, {
          refreshToken,
        });
        
        const { accessToken } = response.data;
        await SecureStore.setItemAsync('accessToken', accessToken);
        
        // Update header and retry original request
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh failed, clear tokens
        await SecureStore.deleteItemAsync('accessToken');
        await SecureStore.deleteItemAsync('refreshToken');
        await AsyncStorage.removeItem('employeeData');
        return Promise.reject(refreshError);
      }
    }
    
    return Promise.reject(error);
  }
);
