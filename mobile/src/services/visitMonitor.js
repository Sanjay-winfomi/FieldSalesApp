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
 * Foreground-only means this pauses whenever the app is backgrounded and
 * resumes on the next check after it's foregrounded again — an intentional
 * tradeoff for battery life and to avoid the background-location permission
 * prompt, not a bug.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let timer = null;
let logoutAlertAlready = false;

/**
 * @param {object} params
 * @param {{id: number|string}} params.visit - the open visit to monitor
 * @param {(distanceMeters: number) => void} [params.onWarning] - called every
 *   time a ping comes back outside the dealer's radius
 * @param {(distanceMeters: number) => void} [params.onLogoutAlert] - called
 *   once per visit, the first time the backend reports 2+ cumulative breaches
 */
export function startVisitMonitoring({ visit, onWarning, onLogoutAlert }) {
  stopVisitMonitoring();

  if (!visit?.id) return;

  logoutAlertAlready = false;

  const check = async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return; // silent — GPSStatusCard/permission banner already covers this

      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = location.coords.latitude;
      const lng = location.coords.longitude;

      await reportLocationCheck(visit.id, lat, lng, { onWarning, onLogoutAlert });
    } catch (error) {
      // GPS acquisition failures here are non-fatal (best-effort background
      // check) — swallow rather than surface a disruptive alert mid-visit.
      console.warn('Visit monitor check failed:', error.message);
    }
  };

  timer = setInterval(check, CHECK_INTERVAL_MS);
}

export function stopVisitMonitoring() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  logoutAlertAlready = false;
}

async function reportLocationCheck(visitId, lat, lng, { onWarning, onLogoutAlert }) {
  const payload = { lat, lng };
  try {
    const res = await api.post(`/visits/${visitId}/location-check`, payload);
    const { visit, distance_meters: distanceMeters } = res.data;

    if (visit?.last_location_status === 'outside' && onWarning) {
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
      // check-in), so no temp-id resolution is needed.
      await enqueueAction('post', `/visits/${visitId}/location-check`, payload);
    } else {
      console.warn('Failed to report location check:', error.message);
    }
  }
}

export const __testing = { CHECK_INTERVAL_MS };
