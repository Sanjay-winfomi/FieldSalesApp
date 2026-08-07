import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { api } from './api';
import { enqueueAction } from './syncManager';

/**
 * visitMonitor.js — Random Location Verification.
 *
 * Instead of continuous background GPS tracking (heavy battery cost, requires
 * a background-location permission and a custom dev build), this periodically
 * samples location *while the app is foregrounded* during an open dealer
 * visit: every CHECK_INTERVAL_MS, it reports the rep's position to
 * POST /visits/:id/location-check, which is the source of truth for
 * inside/outside status and the cumulative out-of-radius breach count (not
 * necessarily consecutive — 2 breaches anywhere in the visit trips the
 * "time to log out" alert, surfaced to both this device and the manager
 * dashboard).
 *
 * Foreground-only means the interval alone can leave the dashboard showing a
 * stale login-time status for hours if the rep just pockets the phone
 * after logging in — the interval only fires while foregrounded and won't
 * catch up on missed ticks. To keep that window as small as possible, a
 * check also fires immediately on start and every time the app returns to
 * the foreground during an open visit, so the very next time the rep glances
 * at their phone, the status refreshes instead of waiting on the timer.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let timer = null;
let appStateSubscription = null;
let logoutAlertAlready = false;
let consecutiveOutside = 0;
let warnedForCurrentStreak = false;

/**
 * @param {object} params
 * @param {{id: number|string}} params.visit - the open visit to monitor
 * @param {(distanceMeters: number) => void} [params.onWarning] - called only
 *   once a streak of 2 CONSECUTIVE checks (20 minutes apart) both come back
 *   outside the dealer's radius — a single outside ping is treated as GPS
 *   noise, not a real departure, so it doesn't alert on its own. Coming back
 *   inside resets the streak, so it takes 2 fresh consecutive misses again
 *   before the next alert.
 * @param {(distanceMeters: number) => void} [params.onLogoutAlert] - called
 *   once per visit, the first time the backend reports 2+ cumulative breaches
 * @param {({title: string, body: string}) => void} [params.onRepNotification]
 *   - additive alongside onWarning/onLogoutAlert (unchanged): fed by the
 *   backend's new staged 10/20/30-min excursion tracker (visit_radius_events),
 *   fired whenever that check's response says a rep-facing notification is
 *   due. The server decides timing/copy; this just relays it.
 */
export function startVisitMonitoring({ visit, onWarning, onLogoutAlert, onRepNotification }) {
  stopVisitMonitoring();

  if (!visit?.id) return;

  logoutAlertAlready = false;
  consecutiveOutside = 0;
  warnedForCurrentStreak = false;

  const check = async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return; // silent — GPSStatusCard/permission banner already covers this

      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = location.coords.latitude;
      const lng = location.coords.longitude;

      await reportLocationCheck(visit.id, lat, lng, { onWarning, onLogoutAlert, onRepNotification });
    } catch (error) {
      // GPS acquisition failures here are non-fatal (best-effort background
      // check) — swallow rather than surface a disruptive alert mid-visit.
      console.warn('Visit monitor check failed:', error.message);
    }
  };

  check();
  timer = setInterval(check, CHECK_INTERVAL_MS);
  appStateSubscription = AppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') check();
  });
}

export function stopVisitMonitoring() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  logoutAlertAlready = false;
  consecutiveOutside = 0;
  warnedForCurrentStreak = false;
}

async function reportLocationCheck(visitId, lat, lng, { onWarning, onLogoutAlert, onRepNotification }) {
  const payload = { lat, lng };
  try {
    const res = await api.post(`/visits/${visitId}/location-check`, payload);
    const { visit, distance_meters: distanceMeters, rep_notification: repNotification } = res.data;

    if (repNotification && onRepNotification) {
      onRepNotification(repNotification);
    }

    if (visit?.last_location_status === 'outside') {
      consecutiveOutside += 1;
    } else {
      consecutiveOutside = 0;
      warnedForCurrentStreak = false;
    }

    if (consecutiveOutside >= 2 && !warnedForCurrentStreak && onWarning) {
      warnedForCurrentStreak = true;
      onWarning(distanceMeters);
    }

    if (visit?.log_out_alert_sent && !logoutAlertAlready) {
      logoutAlertAlready = true;
      if (onLogoutAlert) onLogoutAlert(distanceMeters);
    }
  } catch (error) {
    if (!error.response) {
      // Offline — queue it like any other action; the visit_id is a real
      // server id already (this only runs on visits that synced their
      // login), so no temp-id resolution is needed.
      await enqueueAction('post', `/visits/${visitId}/location-check`, payload);
    } else {
      console.warn('Failed to report location check:', error.message);
    }
  }
}

export const __testing = { CHECK_INTERVAL_MS };
