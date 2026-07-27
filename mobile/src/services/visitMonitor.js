import * as Location from 'expo-location';
import { haversineKm, isWithinRadius } from '../utils/haversine';
import { api } from './api';
import { enqueueAction } from './syncManager';

/**
 * visitMonitor.js — Random Location Verification.
 *
 * Instead of continuous background GPS tracking (heavy battery cost, requires
 * a background-location permission and a custom dev build), this periodically
 * samples location *while the app is foregrounded* during an open dealer
 * visit: every CHECK_INTERVAL_MS, check whether the rep is still inside the
 * dealer's geofence. If they've been outside for longer than GRACE_PERIOD_MS
 * (not just a single noisy reading), the visit is flagged "interrupted" —
 * once — and reported to the backend for manager review.
 *
 * Foreground-only means this pauses whenever the app is backgrounded and
 * resumes on the next check after it's foregrounded again — an intentional
 * tradeoff for battery life and to avoid the background-location permission
 * prompt, not a bug.
 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const GRACE_PERIOD_MS = 10 * 60 * 1000; // how long outside before flagging
const CONSECUTIVE_OUTSIDE_TO_INTERRUPT = Math.ceil(GRACE_PERIOD_MS / CHECK_INTERVAL_MS);

let timer = null;
let consecutiveOutsideCount = 0;
let interruptedAlready = false;

/**
 * @param {object} params
 * @param {{id: number|string}} params.visit - the open visit to monitor
 * @param {{latitude: number, longitude: number, radius_meters: number}} params.dealer
 * @param {(distanceMeters: number) => void} [params.onWarning] - called the moment
 *   the rep is first detected outside the radius (before the grace period elapses)
 * @param {(distanceMeters: number) => void} [params.onInterrupted] - called once,
 *   when the grace period has elapsed while still outside
 */
export function startVisitMonitoring({ visit, dealer, onWarning, onInterrupted }) {
  stopVisitMonitoring();

  if (!dealer?.latitude || !dealer?.longitude || !visit?.id) return;

  consecutiveOutsideCount = 0;
  interruptedAlready = false;

  const radiusMeters = dealer.radius_meters ?? 200;

  const check = async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return; // silent — GPSStatusCard/permission banner already covers this

      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = location.coords.latitude;
      const lng = location.coords.longitude;

      const inside = isWithinRadius(dealer.latitude, dealer.longitude, lat, lng, radiusMeters);

      if (inside) {
        consecutiveOutsideCount = 0;
        return;
      }

      consecutiveOutsideCount += 1;
      const distanceMeters = Math.round(haversineKm(dealer.latitude, dealer.longitude, lat, lng) * 1000);

      if (consecutiveOutsideCount === 1 && onWarning) {
        onWarning(distanceMeters);
      }

      if (!interruptedAlready && consecutiveOutsideCount >= CONSECUTIVE_OUTSIDE_TO_INTERRUPT) {
        interruptedAlready = true;
        await reportInterrupted(visit.id, lat, lng, distanceMeters);
        if (onInterrupted) onInterrupted(distanceMeters);
      }
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
  consecutiveOutsideCount = 0;
  interruptedAlready = false;
}

async function reportInterrupted(visitId, lat, lng, distanceMeters) {
  const payload = { lat, lng, distance_meters: distanceMeters };
  try {
    await api.post(`/visits/${visitId}/interrupt`, payload);
  } catch (error) {
    if (!error.response) {
      // Offline — queue it like any other action; the visit_id is a real
      // server id already (this only runs on visits that synced their
      // check-in), so no temp-id resolution is needed.
      await enqueueAction('post', `/visits/${visitId}/interrupt`, payload);
    } else {
      console.warn('Failed to report interrupted visit:', error.message);
    }
  }
}

export const __testing = { CHECK_INTERVAL_MS, GRACE_PERIOD_MS, CONSECUTIVE_OUTSIDE_TO_INTERRUPT };
