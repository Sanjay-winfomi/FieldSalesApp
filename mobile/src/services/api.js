import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// EXPO_PUBLIC_-prefixed vars are inlined at build time by Expo (SDK 49+, no
// extra config needed) from a .env file — see mobile/.env.example. This lets
// each environment (dev machine, staging, production) point at its own
// backend without editing source, and lets a real production build ship with
// an https:// URL instead of a developer's home-LAN IP over plain HTTP.
const getBaseUrl = () => {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured;

  if (__DEV__) {
    console.warn(
      'EXPO_PUBLIC_API_URL is not set — falling back to a local-dev default. ' +
      'Set it in mobile/.env (see .env.example) to point at your backend.'
    );
    return 'http://192.168.0.57:3001/api';
  }

  throw new Error('EXPO_PUBLIC_API_URL must be set for production builds.');
};

const BASE_URL = getBaseUrl();

// 60s, not the usual few-second default: a free-tier host (e.g. Render's free
// web service) spins its instance down after idling and takes 30-60s to wake
// on the next request — a short timeout would abort right as the server was
// about to respond, misreporting a slow-but-working backend as unreachable.
export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 60000,
});

// Called once (by App.js) so that a refresh-token failure — meaning the
// session truly is dead — can reset app state and navigate to Login, instead
// of leaving the user stranded on a screen where every request silently fails.
let authInvalidatedHandler = null;
export const setAuthInvalidatedHandler = (fn) => {
  authInvalidatedHandler = fn;
};

// Shared across all concurrent 401s so that two requests failing around the
// same time (e.g. a foreground fetch + a background sync flush) trigger only
// one refresh call instead of each independently consuming/rotating the
// refresh token and racing each other.
let refreshPromise = null;

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
    
    // Login/refresh returning 401 means wrong credentials or an expired/invalid
    // refresh token — that's a real, final answer, not a signal to attempt a
    // token refresh. Only retry-via-refresh for OTHER protected endpoints.
    const isAuthEndpoint = originalRequest?.url?.includes('/auth/login') || originalRequest?.url?.includes('/auth/refresh');

    // If error is 401 and we haven't retried yet
    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true;

      if (!refreshPromise) {
        refreshPromise = (async () => {
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
          return accessToken;
        })().finally(() => {
          refreshPromise = null;
        });
      }

      try {
        const accessToken = await refreshPromise;
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh failed — the session is genuinely dead. Clear tokens and
        // let the app reset to the Login screen instead of leaving the user
        // stuck on a screen where every subsequent request silently 401s.
        await SecureStore.deleteItemAsync('accessToken');
        await SecureStore.deleteItemAsync('refreshToken');
        await AsyncStorage.removeItem('employeeData');
        if (authInvalidatedHandler) authInvalidatedHandler();
        return Promise.reject(refreshError);
      }
    }
    
    return Promise.reject(error);
  }
);
