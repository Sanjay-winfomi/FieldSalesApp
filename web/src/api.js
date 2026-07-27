import axios from 'axios';

// Vite inlines VITE_-prefixed vars from a .env file at build time — see
// web/.env.example. Without this, a production build kept calling
// localhost and every request would fail for real users.
export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export const apiClient = axios.create({ baseURL: API_BASE });

let authToken = null;

export function setAuthToken(token) {
  authToken = token;
}

// Called once (by App.js) so an expired/invalid session can be handled in one
// place instead of every page re-implementing its own 401 check — previously
// most pages (Reports, Admin, Rep details) had no 401 handling at all, so an
// expired token just showed a generic "failed to load" error forever with no
// way back to Login short of a manual page refresh.
let sessionExpiredHandler = null;
export function setSessionExpiredHandler(fn) {
  sessionExpiredHandler = fn;
}

apiClient.interceptors.request.use((config) => {
  if (authToken) {
    config.headers.Authorization = `Bearer ${authToken}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && sessionExpiredHandler) {
      sessionExpiredHandler();
    }
    return Promise.reject(error);
  }
);
