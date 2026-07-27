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
