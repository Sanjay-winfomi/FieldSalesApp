import { createContext, useContext } from 'react';

/**
 * Shares the app-level state/handlers that already live in App.js (employee,
 * attendance, visits, sync status, and the existing action handlers) with
 * screens nested inside the bottom tab navigator — introduced purely so
 * Home/Dealers/History/Profile can be separate routes instead of children of
 * one HomeScreen. No business logic moves here; App.js still owns every
 * piece of state and every handler, this just avoids prop-drilling them
 * through the navigator.
 */
export const AppStateContext = createContext(null);

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppState() must be called within AppStateContext.Provider');
  }
  return ctx;
}

/**
 * pendingSyncCount changes on its own 10s poll (see App.js) independently of
 * everything else in AppStateContext. Sharing one context object for both
 * meant that 10s tick re-rendered every screen consuming useAppState() —
 * Home, Profile, DealerLogin, DealerLogout, DealerNavigation, etc. — even
 * though only the "N pending sync" banner on Home actually reads this value.
 * Splitting it into its own context confines that periodic re-render to just
 * the component(s) that call usePendingSync().
 */
export const PendingSyncContext = createContext(null);

export function usePendingSync() {
  const ctx = useContext(PendingSyncContext);
  if (!ctx) {
    throw new Error('usePendingSync() must be called within PendingSyncContext.Provider');
  }
  return ctx;
}
