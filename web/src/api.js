import axios from 'axios';

// Next.js inlines NEXT_PUBLIC_-prefixed vars at build time — see
// web/.env.example. A production build (`next build` with the default
// NODE_ENV=production) that silently fell back to localhost would ship
// completely broken for real users, so it fails the build loudly instead;
// local dev keeps the convenient fallback.
function resolveApiBase() {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_API_URL must be set for production builds.');
  }

  console.warn(
    'NEXT_PUBLIC_API_URL is not set — falling back to a local-dev default. ' +
    'Set it in web/.env (see .env.example) to point at your backend.'
  );
  return 'http://localhost:3001/api';
}

export const API_BASE = resolveApiBase();

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
