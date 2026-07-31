import * as Location from 'expo-location';
import { Linking } from 'react-native';
import { api } from './api';

// expo-location returns the full state name (e.g. "Tamil Nadu"), not the
// short code used in Indian postal addresses (e.g. "TN") — map it ourselves.
const INDIA_STATE_CODES = {
  'Andhra Pradesh': 'AP', 'Arunachal Pradesh': 'AR', 'Assam': 'AS', 'Bihar': 'BR',
  'Chhattisgarh': 'CG', 'Goa': 'GA', 'Gujarat': 'GJ', 'Haryana': 'HR',
  'Himachal Pradesh': 'HP', 'Jharkhand': 'JH', 'Karnataka': 'KA', 'Kerala': 'KL',
  'Madhya Pradesh': 'MP', 'Maharashtra': 'MH', 'Manipur': 'MN', 'Meghalaya': 'ML',
  'Mizoram': 'MZ', 'Nagaland': 'NL', 'Odisha': 'OD', 'Punjab': 'PB',
  'Rajasthan': 'RJ', 'Sikkim': 'SK', 'Tamil Nadu': 'TN', 'Telangana': 'TS',
  'Tripura': 'TR', 'Uttar Pradesh': 'UP', 'Uttarakhand': 'UK', 'West Bengal': 'WB',
  'Andaman and Nicobar Islands': 'AN', 'Chandigarh': 'CH',
  'Dadra and Nagar Haveli and Daman and Diu': 'DN', 'Delhi': 'DL',
  'Jammu and Kashmir': 'JK', 'Ladakh': 'LA', 'Lakshadweep': 'LD', 'Puducherry': 'PY',
};

// A reading worse than this (metres) is worth retrying for, up to the budget below.
const GOOD_ENOUGH_ACCURACY_METERS = 20;
// A reading worse than this is rejected outright for dealer check-in/out (Dealer
// Geofencing spec) — the rep is prompted to move to an open area instead of
// proceeding on an unreliable fix, mirrored by a hard backend-side check too.
export const MAX_ACCEPTABLE_ACCURACY_METERS = 30;
const MAX_ACQUIRE_ATTEMPTS = 3;
// Without a per-attempt timeout, a single poor-GPS reading (indoors, dense
// urban, no sky view) can hang indefinitely, leaving the check-in/out screens
// stuck on "Acquiring location..." with no way forward but restarting the app.
const ACQUIRE_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Location request timed out')), ms)),
  ]);
}

/**
 * Current foreground location permission state, plus whether the OS will
 * still show its own prompt if asked again — once a user taps "Don't allow"
 * a second time (Android) or denies once (iOS), canAskAgain is false and
 * requestForegroundPermissionsAsync() silently resolves to 'denied' with no
 * dialog at all, so the app must offer a way to the OS Settings screen
 * instead of just re-requesting into a no-op.
 * @returns {Promise<{granted: boolean, canAskAgain: boolean}>}
 */
export const getLocationPermissionStatus = async () => {
  const { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
  return { granted: status === 'granted', canAskAgain };
};

/**
 * Deep-links to this app's OS Settings screen, for when location permission
 * was permanently denied and the only way back is a manual toggle there.
 */
export const openLocationSettings = () => Linking.openSettings();

/**
 * Requests the "Always" location permission needed for geofencing to keep
 * working while the app is backgrounded/closed during an open dealer visit.
 * Must only be called after foreground permission is already granted (the OS
 * requires the two-step ask). A denial here isn't fatal to the visit itself —
 * the foreground-only periodic check in visitMonitor.js still runs as a
 * fallback whenever the app is open.
 * @returns {Promise<boolean>} whether background permission is granted
 */
export const requestBackgroundLocationPermission = async () => {
  try {
    const { status } = await Location.requestBackgroundPermissionsAsync();
    return status === 'granted';
  } catch (error) {
    console.warn('Background location permission request failed:', error.message);
    return false;
  }
};

/**
 * Request foreground permissions and fetch the current GPS location, taking
 * up to a few readings and keeping the most precise one — a single reading
 * can land 50m+ off right after GPS wakes up, especially indoors/urban, so
 * this trades a couple of extra seconds for a materially better fix.
 * @returns {Promise<{lat: number, lng: number, accuracyMeters: number|null} | null>}
 */
export const getCurrentLocation = async () => {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();

    if (status !== 'granted') {
      console.warn('Permission to access location was denied');
      return null;
    }

    let best = null;

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      let location;
      try {
        location = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }),
          ACQUIRE_TIMEOUT_MS
        );
      } catch (timeoutErr) {
        // This attempt hung too long — stop trying and return whatever we
        // already have (possibly null) rather than hanging indefinitely.
        console.warn('Location acquisition attempt timed out:', timeoutErr.message);
        break;
      }

      const reading = {
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        accuracyMeters: location.coords.accuracy ?? null,
      };

      if (!best || (reading.accuracyMeters != null && reading.accuracyMeters < (best.accuracyMeters ?? Infinity))) {
        best = reading;
      }

      const goodEnough = best.accuracyMeters != null && best.accuracyMeters <= GOOD_ENOUGH_ACCURACY_METERS;
      if (goodEnough || attempt === MAX_ACQUIRE_ATTEMPTS - 1) break;
    }

    return best;
  } catch (error) {
    console.error('Error fetching location:', error);
    return null;
  }
};

function formatAddressParts({ streetLine, locality, city, region, postalCode, country }) {
  const stateCode = region ? (INDIA_STATE_CODES[region] || region) : null;
  const statePostal = [stateCode, postalCode].filter(Boolean).join('-');
  const parts = [streetLine, locality, city, statePostal, country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Reverse-geocode via our backend's Google Geocoding API proxy — called
 * server-side rather than directly from the phone so the API key never ships
 * in the mobile bundle and usage stays centrally rate-limited/cached.
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string>}
 */
export const getReadableAddress = async (lat, lng) => {
  const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  try {
    const response = await api.get('/geocode/reverse', { params: { lat, lng } });
    const raw = response.data?.raw;

    if (raw) {
      const streetLine = [raw.house_number, raw.road].filter(Boolean).join(' ');
      const locality = raw.suburb || raw.neighbourhood || raw.city_district;
      const city = raw.city || raw.town || raw.village;
      const formatted = formatAddressParts({
        streetLine,
        locality,
        city,
        region: raw.state,
        postalCode: raw.postcode,
        country: raw.country,
      });
      if (formatted) return formatted;
    }

    return response.data?.address || fallback;
  } catch (error) {
    // Non-fatal — a coordinate-string fallback is always shown, and check-in/
    // out itself isn't blocked by this. console.warn (not .error) so it
    // doesn't trip Metro's full-screen LogBox during normal use (e.g. the
    // geocoding API key isn't configured yet in backend/.env).
    console.warn('Reverse geocoding failed, showing coordinates instead:', error.message);
    return fallback;
  }
};
