import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';
import { Timer, AlertTriangle } from 'lucide-react-native';
import {
  getCurrentLocation, getReadableAddress, haversineMeters,
  MAX_ACCEPTABLE_ACCURACY_METERS, LOGIN_MATCH_TOLERANCE_METERS,
} from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { showAlert } from '../src/services/themedAlert';
import { AppHeader, GPSStatusCard, PrimaryButton, TextField, Card, FadeSlideIn } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

// Task 5 Case 2/3 — a visit whose LOGIN already used an exception always
// requires a written logout reason, bounded 50-500 chars. Distinct from
// (and stricter than) the old MIN_REASON_LENGTH=20 escape hatch, which no
// longer applies to logout at all — see backend/src/routes/visits.routes.js.
const LOGOUT_EXCEPTION_REASON_MIN = 50;
const LOGOUT_EXCEPTION_REASON_MAX = 500;
// A dealer with no registered coordinates can't be geofenced — mirrors the
// backend's own "treat as inside" fallback for that case.
const DEFAULT_DEALER_RADIUS_METERS = 200;

export default function DealerLogoutScreen({ dealer, activeVisit, onLogout, navigation }) {
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');
  const [locationStatus, setLocationStatus] = useState('');
  const [reason, setReason] = useState('');
  const [blockedMessage, setBlockedMessage] = useState('');
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

  // Case 2/3 — the login already used an exception, so logout always needs
  // a written reason regardless of current distance.
  const loginWasException = activeVisit?.login_inside_radius === false;

  // Case 1 — a normal login: computed fully client-side from the freshly
  // acquired GPS fix, dealer coordinates, and the visit's own login
  // coordinates, so the button reflects reality without waiting on a
  // server round-trip. The server independently re-validates on submit.
  let insideDealerRadius = true;
  let matchedLoginSpot = false;
  if (coords && dealer?.latitude != null && dealer?.longitude != null) {
    const distanceToDealer = haversineMeters(dealer.latitude, dealer.longitude, coords.lat, coords.lng);
    insideDealerRadius = distanceToDealer <= (dealer.radius_meters ?? DEFAULT_DEALER_RADIUS_METERS);
  }
  if (coords && !insideDealerRadius && activeVisit?.login_lat != null && activeVisit?.login_lng != null) {
    const driftFromLogin = haversineMeters(activeVisit.login_lat, activeVisit.login_lng, coords.lat, coords.lng);
    matchedLoginSpot = driftFromLogin <= LOGIN_MATCH_TOLERANCE_METERS;
  }
  const case1CanLogout = insideDealerRadius || matchedLoginSpot;

  const handleLogout = async () => {
    if (!coords) {
      showAlert('Location Required', 'Please wait for GPS to acquire your location.');
      return;
    }
    if (!activeVisit) {
      showAlert('Error', 'No active dealer visit found.');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        visit_id: activeVisit.id,
        lat: coords.lat,
        lng: coords.lng,
        accuracy_meters: coords.accuracyMeters,
        reason: reason.trim() || undefined,
      };

      let updatedVisit = null;
      try {
        const response = await api.post('/visits/logout', payload);
        updatedVisit = response.data.visit;
      } catch (error) {
        if (!error.response) {
          // Network error — enqueue and proceed
          await enqueueAction('post', '/visits/logout', payload);
          showAlert('Offline Mode', 'Dealer logout saved locally and will sync when online.');
          updatedVisit = {
            ...activeVisit,
            id: activeVisit.id,
            logout_time: new Date().toISOString(),
          };
        } else if (error.response.data?.error === 'must_return_to_radius') {
          // Case 1 has no reason override — the button should already be
          // disabled for this, but the server is the final word. Shown as a
          // one-time alert (not blockedMessage) since the live Case 1 banner
          // below already reactively shows this exact message whenever the
          // button is actually disabled for this reason — a persistent
          // second banner here would just duplicate it and go stale.
          showAlert('Outside Dealer Premises', 'You must return inside dealer premises before logging out.');
          return;
        } else if (error.response.data?.error === 'reason_required') {
          setBlockedMessage(
            `Enter a reason (${error.response.data.minLength}-${error.response.data.maxLength || LOGOUT_EXCEPTION_REASON_MAX} characters) to continue.`
          );
          return;
        } else if (error.response.data?.error === 'gps_accuracy_exceeded') {
          showAlert('GPS Too Imprecise', 'Your GPS accuracy is too low to log out. Move to an open area for a stronger signal.');
          return;
        } else {
          throw error;
        }
      }

      if (updatedVisit && onLogout) {
        onLogout(updatedVisit);
      }
    } catch (error) {
      console.error('Dealer logout error:', error);
      showAlert('Error', error.response?.data?.error || 'Failed to log out. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const accuracyOk = !!coords && coords.accuracyMeters != null && coords.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS;
  const accuracyMessage = coords && !accuracyOk
    ? `GPS accuracy is ±${Math.round(coords.accuracyMeters)}m — move to an open area for a stronger signal.`
    : locationStatus;
  const reasonOk = reason.trim().length >= LOGOUT_EXCEPTION_REASON_MIN && reason.trim().length <= LOGOUT_EXCEPTION_REASON_MAX;

  const canSubmit = !!coords && accuracyOk && (loginWasException ? reasonOk : case1CanLogout);

  // Calculate elapsed time if activeVisit has a login_time
  const getElapsedMinutes = () => {
    if (!activeVisit?.login_time) return null;
    const start = new Date(activeVisit.login_time);
    return Math.round((Date.now() - start) / 60000);
  };

  const formatVisitStart = () => {
    if (!activeVisit?.login_time) return '—';
    return new Date(activeVisit.login_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  const dealerName = dealer?.name || 'Dealer';
  const elapsedMinutes = getElapsedMinutes();

  return (
    <View style={styles.screen}>
      <AppHeader title="Dealer Logout" subtitle={dealerName} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container}>
        <FadeSlideIn>
          <Card style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Visit started</Text>
              <Text style={styles.summaryValue}>{formatVisitStart()}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.summaryRow}>
              <View style={styles.summaryLeft}>
                <Timer size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
                <Text style={styles.summaryLabel}>Visit duration</Text>
              </View>
              <Text style={styles.summaryValue}>{elapsedMinutes != null ? `${elapsedMinutes} min` : '—'}</Text>
            </View>
          </Card>

          <GPSStatusCard address={address} coords={coords} statusMessage={accuracyMessage} accuracyMeters={coords?.accuracyMeters} />

          {loginWasException ? (
            // Case 2/3 — login used an exception: always require a written
            // reason, regardless of current distance.
            <TextField
              label={`This visit's login used an exception — enter a reason for this logout (${LOGOUT_EXCEPTION_REASON_MIN}-${LOGOUT_EXCEPTION_REASON_MAX} characters).`}
              value={reason}
              // Clears a stale "enter a reason..." banner from a previous
              // failed attempt as soon as the rep starts fixing it — without
              // this it kept showing even once the reason was already valid.
              onChangeText={(text) => { setReason(text); if (blockedMessage) setBlockedMessage(''); }}
              placeholder="Explain why this logout is happening outside the dealer location..."
              multiline
              style={styles.reasonField}
            />
          ) : (
            // Case 1 — normal login: no reason field at all, just a
            // proactive block until back inside radius (or drift-matched).
            !!coords && !case1CanLogout && (
              <View style={styles.blockedBanner}>
                <AlertTriangle size={14} color={colors.dangerDark || colors.danger} style={{ marginRight: 8 }} />
                <Text style={styles.blockedText}>You must return inside dealer premises before logging out.</Text>
              </View>
            )
          )}

          {!!blockedMessage && (
            <View style={styles.blockedBanner}>
              <AlertTriangle size={14} color={colors.dangerDark || colors.danger} style={{ marginRight: 8 }} />
              <Text style={styles.blockedText}>{blockedMessage}</Text>
            </View>
          )}

          <PrimaryButton
            title={loginWasException ? 'Submit reason & logout' : 'Dealer Logout'}
            onPress={handleLogout}
            disabled={!canSubmit}
            loading={loading}
            variant="danger"
          />
        </FadeSlideIn>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, padding: spacing.screenHorizontal, justifyContent: 'center' },
  summaryCard: { marginBottom: spacing.cardGap },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm },
  summaryLeft: { flexDirection: 'row', alignItems: 'center' },
  summaryLabel: { ...typography.body, color: colors.textSecondary },
  summaryValue: { ...typography.bodyMedium, color: colors.text },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  reasonField: { marginBottom: spacing.buttonMargin },
  blockedBanner: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.dangerLight || colors.background,
    borderRadius: 10, padding: spacing.sm, marginBottom: spacing.buttonMargin,
  },
  blockedText: { ...typography.body, color: colors.dangerDark || colors.danger, flex: 1 },
});
