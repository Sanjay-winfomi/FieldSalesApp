import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, Pressable, Platform, Linking, ActivityIndicator } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { Navigation2, MapPin, Clock, AlertTriangle, X } from 'lucide-react-native';
import { getCurrentLocation, haversineMeters } from '../src/services/location';
import { decodePolyline } from '../src/utils/polyline';
import { api } from '../src/services/api';
import { isNetworkError } from '../src/services/syncManager';
import { AppHeader, PrimaryButton, LoadingCard } from '../src/components';
import { colors, typography, spacing, radius } from '../src/theme';

// How often to re-check the rep's position against the dealer's radius while
// this screen is open, to auto-detect arrival — polling (not
// watchPositionAsync) to match the existing poll-based pattern already used
// by visitMonitor.js elsewhere in this app.
const POSITION_POLL_MS = 15000;
const DEFAULT_RADIUS_METERS = 200;

const STATUS_LABELS = {
  loading: 'Loading',
  ready: 'Ready',
  navigating: 'Navigating',
  arrived: 'Arrived',
  completed: 'Completed',
  cancelled: 'Cancelled',
  error: 'Error',
};

function formatKm(meters) {
  if (meters == null) return null;
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(seconds) {
  if (seconds == null) return null;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Coerces a lat/lng that may arrive as a number, a numeric string, or a
// malformed value (e.g. a stale/corrupt cached assignment) to a finite
// number or null — `!= null` alone lets a bad string through as NaN, which
// then silently breaks MapView's region math and haversineMeters. Mirrors
// backend/src/routes/navigation.routes.js's parseCoord.
function toFiniteCoord(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function formatEta(isoString) {
  if (!isoString) return null;
  try {
    return new Date(isoString).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return null;
  }
}

// Deep-links into the native Maps app for actual voice-guided turn-by-turn —
// Google Routes API gives us distance/ETA/traffic/polyline for the in-app
// preview, but real driving guidance is deliberately handed off to the
// platform's own Maps app rather than reimplemented here.
async function openNativeNavigation(lat, lng) {
  if (Platform.OS === 'android') {
    return Linking.openURL(`google.navigation:q=${lat},${lng}&mode=d`);
  }
  const googleMapsUrl = `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`;
  const canOpenGoogleMaps = await Linking.canOpenURL(googleMapsUrl).catch(() => false);
  if (canOpenGoogleMaps) return Linking.openURL(googleMapsUrl);
  return Linking.openURL(`maps://?daddr=${lat},${lng}&dirflg=d`);
}

/**
 * In-app navigation preview for a single assigned (or manually selected)
 * dealer — current GPS, dealer marker, route polyline, distance/ETA/traffic,
 * and a status lifecycle (Ready -> Navigating -> Arrived -> Completed/
 * Cancelled). Registered in App.js's root Stack the same way as
 * DealerLogin/DealerLogout (render-prop, needs live props).
 *
 * @param {object} props
 * @param {object} props.assignment - { id, dealer_id, dealer_name, dealer_address,
 *   dealer_lat, dealer_lng, radius_meters }
 * @param {object} props.navigation
 * @param {(dealer: object) => void} props.onArrived - hands off into the
 *   existing (unmodified) Check-In flow once the rep is within the dealer's radius
 */
export default function DealerNavigationScreen({ assignment, navigation, onArrived }) {
  const [coords, setCoords] = useState(null);
  const [route, setRoute] = useState(null);
  const [navigationId, setNavigationId] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | navigating | arrived | error
  const [errorMessage, setErrorMessage] = useState(null);
  const isMountedRef = useRef(true);
  const pollRef = useRef(null);

  useEffect(() => () => { isMountedRef.current = false; }, []);

  const dealerLat = toFiniteCoord(assignment?.dealer_lat);
  const dealerLng = toFiniteCoord(assignment?.dealer_lng);
  const radiusMeters = assignment?.radius_meters ?? DEFAULT_RADIUS_METERS;

  const computeRoute = async () => {
    setStatus('loading');
    setErrorMessage(null);

    const loc = await getCurrentLocation();
    if (!isMountedRef.current) return;
    if (!loc) {
      setStatus('error');
      setErrorMessage('Could not get your GPS location. Check that location is enabled and try again.');
      return;
    }
    setCoords(loc);

    if (dealerLat == null || dealerLng == null) {
      setStatus('error');
      setErrorMessage('This dealer has no registered coordinates, so a route cannot be computed.');
      return;
    }

    try {
      const res = await api.post('/navigation/compute', {
        dealer_id: assignment.dealer_id,
        assignment_id: assignment.id ?? undefined,
        origin_lat: loc.lat,
        origin_lng: loc.lng,
      });
      if (!isMountedRef.current) return;
      setRoute(res.data.navigation);
      setNavigationId(res.data.navigation.id);
      setStatus('ready');
    } catch (err) {
      if (!isMountedRef.current) return;
      if (isNetworkError(err)) {
        setErrorMessage('No internet connection — a route needs connectivity. Check your connection and retry.');
      } else if (err.response?.status === 502) {
        setErrorMessage("Couldn't reach Google's directions service. Please retry.");
      } else {
        setErrorMessage('Could not compute a route right now. Please retry.');
      }
      setStatus('error');
    }
  };

  useEffect(() => {
    computeRoute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchStatus = async (nextStatus) => {
    if (!navigationId) return;
    try {
      await api.patch(`/navigation/${navigationId}/status`, { status: nextStatus });
    } catch (err) {
      console.error('Failed to update navigation status:', err.message);
    }
  };

  // Poll position while a route is active, to auto-detect arrival.
  useEffect(() => {
    if (status !== 'ready' && status !== 'navigating') {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    const checkArrival = async () => {
      const loc = await getCurrentLocation();
      if (!isMountedRef.current || !loc || dealerLat == null || dealerLng == null) return;
      setCoords(loc);
      const distanceMeters = haversineMeters(loc.lat, loc.lng, dealerLat, dealerLng);
      if (distanceMeters <= radiusMeters) {
        setStatus('arrived');
        patchStatus('arrived');
      }
    };

    pollRef.current = setInterval(checkArrival, POSITION_POLL_MS);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const handleStartNavigation = async () => {
    if (dealerLat == null || dealerLng == null) return;
    setStatus('navigating');
    patchStatus('navigating');
    try {
      await openNativeNavigation(dealerLat, dealerLng);
    } catch (err) {
      console.error('Failed to open native navigation:', err.message);
    }
  };

  const handleCancel = async () => {
    // Flip local status first (not just fire the backend patch) — this stops
    // the position-poll effect (below) synchronously, closing a race where a
    // poll tick lands in the gap between tapping Cancel and the screen
    // actually unmounting and flips this back to 'arrived' server-side right
    // after we told it 'cancelled'.
    setStatus('cancelled');
    await patchStatus('cancelled');
    navigation.goBack();
  };

  const handleProceedToCheckIn = () => {
    onArrived?.({
      id: assignment.dealer_id,
      name: assignment.dealer_name,
      address: assignment.dealer_address,
      latitude: dealerLat,
      longitude: dealerLng,
      radius_meters: radiusMeters,
    });
  };

  const polylinePoints = route?.encoded_polyline ? decodePolyline(route.encoded_polyline) : [];
  const statusLabel = STATUS_LABELS[status] || status;

  return (
    <View style={styles.screen}>
      <AppHeader
        title="Navigate"
        subtitle={assignment?.dealer_name}
        onBack={() => navigation.goBack()}
      />

      {status === 'loading' && <LoadingCard message="Getting your route..." />}

      {status === 'error' && (
        <View style={styles.errorContainer}>
          <AlertTriangle size={40} color={colors.dangerDark} />
          <Text style={styles.errorText}>{errorMessage}</Text>
          <PrimaryButton title="Retry" onPress={computeRoute} style={{ marginTop: spacing.lg }} />
        </View>
      )}

      {(status === 'ready' || status === 'navigating' || status === 'arrived') && dealerLat != null && (
        <>
          <MapView
            style={styles.map}
            provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
            initialRegion={{
              latitude: (coords?.lat ?? dealerLat) ,
              longitude: (coords?.lng ?? dealerLng),
              latitudeDelta: Math.abs((coords?.lat ?? dealerLat) - dealerLat) * 2 + 0.05,
              longitudeDelta: Math.abs((coords?.lng ?? dealerLng) - dealerLng) * 2 + 0.05,
            }}
          >
            {coords && (
              <Marker coordinate={{ latitude: coords.lat, longitude: coords.lng }} title="You" pinColor={colors.primary} />
            )}
            <Marker coordinate={{ latitude: dealerLat, longitude: dealerLng }} title={assignment.dealer_name} />
            {polylinePoints.length > 0 && (
              <Polyline coordinates={polylinePoints} strokeColor={colors.primary} strokeWidth={4} />
            )}
          </MapView>

          <View style={styles.infoPanel}>
            <View style={styles.statusRow}>
              <View style={[styles.statusPill, styles[`statusPill_${status}`] || styles.statusPill_ready]}>
                <Text style={styles.statusPillText}>{statusLabel}</Text>
              </View>
            </View>

            <View style={styles.metaRow}>
              {route?.distance_meters != null && (
                <View style={styles.metaItem}>
                  <MapPin size={14} color={colors.textMuted} />
                  <Text style={styles.metaText}>{formatKm(route.distance_meters)}</Text>
                </View>
              )}
              {route?.duration_in_traffic_seconds != null && (
                <View style={styles.metaItem}>
                  <Clock size={14} color={colors.textMuted} />
                  <Text style={styles.metaText}>{formatDuration(route.duration_in_traffic_seconds)}</Text>
                </View>
              )}
              {route?.expected_arrival_time && (
                <Text style={styles.metaText}>Arrival ~{formatEta(route.expected_arrival_time)}</Text>
              )}
            </View>

            {status === 'arrived' ? (
              <PrimaryButton title="Proceed to Check-In" onPress={handleProceedToCheckIn} />
            ) : (
              <PrimaryButton
                title={status === 'navigating' ? 'Open Maps again' : 'Start Navigation'}
                onPress={handleStartNavigation}
                icon={<Navigation2 size={16} color={colors.textInverse} />}
              />
            )}

            <Pressable onPress={handleCancel} style={styles.cancelBtn} accessibilityRole="button">
              <X size={14} color={colors.textMuted} />
              <Text style={styles.cancelBtnText}>Cancel navigation</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  map: { flex: 1 },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  errorText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  infoPanel: {
    padding: spacing.screenHorizontal,
    paddingTop: spacing.md,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  statusRow: { flexDirection: 'row', marginBottom: spacing.sm },
  statusPill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  statusPill_ready: { backgroundColor: colors.primaryLight },
  statusPill_navigating: { backgroundColor: colors.primaryLight },
  statusPill_arrived: { backgroundColor: colors.successLight },
  statusPillText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: spacing.md,
    flexWrap: 'wrap',
  },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 13, color: colors.textSecondary },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
  },
  cancelBtnText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
});
