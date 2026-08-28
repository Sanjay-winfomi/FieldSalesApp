import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, ScrollView } from 'react-native';
import { getCurrentLocation, getReadableAddress, haversineMeters, MAX_ACCEPTABLE_ACCURACY_METERS } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { showAlert } from '../src/services/themedAlert';
import { getErrorMessage } from '../src/services/apiError';
import { useAppState } from '../src/context/AppStateContext';
import { AppHeader, GPSStatusCard, PrimaryButton, TextField, FadeSlideIn } from '../src/components';
import { colors, spacing } from '../src/theme';

const MIN_REASON_LENGTH = 20;

export default function DealerLoginScreen({ dealer, attendance, onLogin, navigation }) {
  const { fetchTodayState } = useAppState();
  const [loading, setLoading] = useState(false);
  const [locationStatus, setLocationStatus] = useState('');
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');
  const [reason, setReason] = useState('');
  const [reasonRequired, setReasonRequired] = useState(null);
  // Guards against setState after the user navigates away mid-acquisition.
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  useEffect(() => {
    acquireLocation();
  }, []);

  const acquireLocation = async () => {
    setLocationStatus('Getting GPS location...');
    const loc = await getCurrentLocation();
    if (!isMountedRef.current) return;
    if (loc) {
      setCoords(loc);
      setLocationStatus('Resolving address...');
      const addr = await getReadableAddress(loc.lat, loc.lng);
      if (!isMountedRef.current) return;
      setAddress(addr);
      setLocationStatus('');
    } else {
      setLocationStatus('Unable to get location — check permissions.');
    }
  };

  const handleLogin = async () => {
    if (!coords) {
      showAlert('Location Required', 'Please wait for GPS to acquire your location.');
      return;
    }
    if (!attendance) {
      showAlert('Error', 'No active attendance session found. Please log in for the day first.');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        attendance_id: attendance.id,
        dealer_id: dealer.id,
        lat: coords.lat,
        lng: coords.lng,
        accuracy_meters: coords.accuracyMeters,
        reason: reason.trim() || undefined,
      };

      let visitData = null;
      try {
        const response = await api.post('/visits/login', payload);
        // Merge dealer_id/coordinates explicitly — guarantees these fields are
        // present for the active-visit lookup and background geofence setup
        // in App.js regardless of RETURNING clause state.
        visitData = {
          ...response.data.visit,
          dealer_id: dealer.id,
          dealer_latitude: dealer.latitude,
          dealer_longitude: dealer.longitude,
          dealer_radius_meters: dealer.radius_meters,
        };
      } catch (error) {
        if (!error.response) {
          // Network error — enqueue and proceed
          const localId = 'offline-' + Date.now();
          await enqueueAction('post', '/visits/login', payload, { localId, resolves: 'visit' });
          showAlert('Offline Mode', 'Dealer login saved locally and will sync when online.');
          // login_inside_radius (not "within_radius" — that field doesn't
          // exist anywhere else in the codebase) is what
          // DealerLogoutScreen's loginWasException check reads later to
          // decide whether a logout reason is required. Computed locally
          // from the dealer's known coordinates/radius, same haversine
          // check the server itself would run, since there's no server
          // round-trip to ask while offline.
          const loginInsideRadius = dealer.latitude == null || dealer.longitude == null
            ? true
            : haversineMeters(dealer.latitude, dealer.longitude, coords.lat, coords.lng) <= (dealer.radius_meters ?? 200);
          visitData = {
            id: localId,
            login_time: new Date().toISOString(),
            dealer_id: dealer.id,
            dealer_name: dealer.name,
            dealer_latitude: dealer.latitude,
            dealer_longitude: dealer.longitude,
            dealer_radius_meters: dealer.radius_meters,
            login_lat: coords.lat,
            login_lng: coords.lng,
            login_inside_radius: loginInsideRadius,
          };
        } else if (error.response.data?.error === 'reason_required') {
          setReasonRequired({ distanceMeters: error.response.data.distanceMeters });
          return;
        } else if (error.response.data?.error === 'gps_accuracy_exceeded') {
          showAlert('GPS Too Imprecise', 'Your GPS accuracy is too low to log in. Move to an open area for a stronger signal.');
          return;
        } else if (error.response.status === 409 && error.response.data?.error === 'visit_already_open') {
          // The server's truth has since diverged from this screen's stale
          // local state (e.g. another device, or a queued offline login that
          // already synced) — surface the raw code ("visit_already_open")
          // as a real sentence instead, and resync so Home/TodaysVisits stop
          // showing no active visit.
          const openDealerName = error.response.data?.visit?.dealer_name;
          showAlert(
            'Visit already open',
            openDealerName
              ? `You already have an open visit at ${openDealerName}. Log out of it before logging in elsewhere.`
              : 'You already have an open dealer visit. Log out of it before logging in elsewhere.'
          );
          await fetchTodayState();
          navigation.goBack();
          return;
        } else {
          throw error;
        }
      }

      if (visitData && onLogin) {
        onLogin(visitData);
      }
    } catch (error) {
      console.error('Dealer login error:', error);
      showAlert('Error', getErrorMessage(error, 'Failed to log in. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  const accuracyOk = !!coords && coords.accuracyMeters != null && coords.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS;
  const accuracyMessage = coords && !accuracyOk
    ? `GPS accuracy is ±${Math.round(coords.accuracyMeters)}m — move to an open area for a stronger signal.`
    : locationStatus;
  const needsReason = !!reasonRequired;
  const reasonOk = reason.trim().length >= MIN_REASON_LENGTH;

  const dealerName = dealer?.name || 'Selected Dealer';

  return (
    <View style={styles.screen}>
      <AppHeader title="Dealer Login" subtitle={dealerName} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container}>
        <FadeSlideIn>
          <GPSStatusCard
            address={address}
            coords={coords}
            statusMessage={accuracyMessage}
            accuracyMeters={coords?.accuracyMeters}
          />

          {needsReason && (
            <TextField
              label={`You're ~${Math.round(reasonRequired.distanceMeters)}m from the dealer. Enter a reason (min ${MIN_REASON_LENGTH} characters) to continue.`}
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. Dealer requested meeting at nearby warehouse"
              style={styles.reasonField}
            />
          )}

          <PrimaryButton
            title={needsReason ? 'Submit reason & login' : 'Dealer Login'}
            onPress={handleLogin}
            disabled={!coords || !accuracyOk || (needsReason && !reasonOk)}
            loading={loading}
            style={styles.submitButton}
          />
        </FadeSlideIn>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, padding: spacing.screenHorizontal, justifyContent: 'center' },
  reasonField: { marginBottom: spacing.buttonMargin },
  submitButton: { marginTop: spacing.buttonMargin },
});
