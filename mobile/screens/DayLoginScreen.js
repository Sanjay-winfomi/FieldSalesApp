import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView } from 'react-native';
import { Building2, MapPin } from 'lucide-react-native';
import { getCurrentLocation, getReadableAddress, MAX_ACCEPTABLE_ACCURACY_METERS } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { showAlert } from '../src/services/themedAlert';
import { getErrorMessage } from '../src/services/apiError';
import { AppHeader, GPSStatusCard, PrimaryButton, FadeSlideIn } from '../src/components';
import { colors, typography, spacing, radius } from '../src/theme';

export default function DayLoginScreen({ onLogin, onAlreadyLoggedIn, navigation }) {
  const [loading, setLoading] = useState(false);
  const [locationStatus, setLocationStatus] = useState('');
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');
  // 'office' — the rep isn't going out on field visits today (working from
  // their own company office instead). No location is acquired or sent at
  // all for an office day (see the effect below) — there's no dealer-visit
  // distance/radius math depending on it, so asking for a GPS fix (and the
  // permission prompt that comes with it) would just be friction for no
  // reason. Still records a login/logout and work duration either way.
  const [workMode, setWorkMode] = useState('field');
  // Guards against setState after the user navigates away mid-acquisition —
  // acquireLocation is an unguarded async chain, so without this a slow GPS/
  // geocode response can still resolve and update state on an unmounted screen.
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // Only ever acquires location for a field day. Keyed on workMode (not a
  // one-time mount effect) so switching from office back to field, having
  // never fetched, still triggers it — but switching TO office never fires a
  // new request, and the mode starting as 'field' means the common case
  // (most days ARE field days) still gets its GPS fix immediately, same as
  // before this toggle existed.
  useEffect(() => {
    if (workMode === 'field' && !coords) {
      acquireLocation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workMode]);

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
    if (workMode === 'field' && !coords) {
      showAlert('Location Required', 'Please wait for GPS to acquire your location.');
      return;
    }

    setLoading(true);
    setLocationStatus('Syncing login...');

    // No location fields at all for an office day without a fix on hand —
    // omitted, not sent as null, so this reads identically to a client that
    // predates this field entirely (attendance.routes.js treats a missing
    // lat/lng as "no location for this login", same as an old app build).
    const payload = coords
      ? { lat: coords.lat, lng: coords.lng, accuracy_meters: coords.accuracyMeters, work_mode: workMode }
      : { work_mode: workMode };

    try {
      let attendanceData = null;
      try {
        const response = await api.post('/attendance/login', payload);
        attendanceData = response.data.attendance;
      } catch (error) {
        if (!error.response) {
          // Network error - enqueue
          const localId = 'offline-' + Date.now();
          await enqueueAction('post', '/attendance/login', payload, { localId, resolves: 'attendance' });
          showAlert('Offline Mode', 'Login saved locally and will sync when online.');

          // Provide mock attendance block so app can progress
          attendanceData = {
            id: localId,
            login_time: new Date().toISOString(),
            login_lat: coords?.lat ?? null,
            login_lng: coords?.lng ?? null,
            total_distance_km: 0,
            work_mode: workMode,
          };
        } else if (error.response.status === 409) {
          showAlert('Already logged in', 'You have already logged in for today.');
          if (onAlreadyLoggedIn) await onAlreadyLoggedIn();
          return;
        } else if (error.response.data?.error === 'gps_accuracy_exceeded') {
          showAlert('GPS Too Imprecise', 'Your GPS accuracy is too low to log in. Move to an open area for a stronger signal.');
          return;
        } else {
          throw error;
        }
      }

      if (attendanceData && onLogin) {
        onLogin(attendanceData);
      }

    } catch (error) {
      console.error('Login error:', error);
      showAlert('Error', getErrorMessage(error, 'Failed to log in. Please try again.'));
    } finally {
      setLoading(false);
      setLocationStatus('');
    }
  };

  const accuracyOk = !!coords && coords.accuracyMeters != null && coords.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS;
  const accuracyMessage = coords && !accuracyOk
    ? `GPS accuracy is ±${Math.round(coords.accuracyMeters)}m — move to an open area for a stronger signal.`
    : locationStatus;
  // Office mode never depends on coords at all — it's not required, and if
  // one happens to already be on hand (mode was switched after a fix came
  // in) it's sent along but never gates the button either way.
  const canSubmit = workMode === 'office' || (!!coords && accuracyOk);

  return (
    <View style={styles.screen}>
      <AppHeader title="Login" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container}>
        <FadeSlideIn>
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeChip, workMode === 'field' && styles.modeChipSelected]}
              onPress={() => setWorkMode('field')}
              accessibilityRole="button"
              accessibilityLabel="Field visit day"
            >
              <MapPin size={16} color={workMode === 'field' ? colors.textInverse : colors.textSecondary} />
              <Text style={[styles.modeChipText, workMode === 'field' && styles.modeChipTextSelected]}>Field visit</Text>
            </Pressable>
            <Pressable
              style={[styles.modeChip, workMode === 'office' && styles.modeChipSelected]}
              onPress={() => setWorkMode('office')}
              accessibilityRole="button"
              accessibilityLabel="Office day, not visiting dealers"
            >
              <Building2 size={16} color={workMode === 'office' ? colors.textInverse : colors.textSecondary} />
              <Text style={[styles.modeChipText, workMode === 'office' && styles.modeChipTextSelected]}>Office day</Text>
            </Pressable>
          </View>

          {workMode === 'field' ? (
            <GPSStatusCard
              address={address}
              coords={coords}
              statusMessage={accuracyMessage}
              accuracyMeters={coords?.accuracyMeters}
            />
          ) : (
            <View style={styles.officeNotice}>
              <Building2 size={18} color={colors.textMuted} />
              <Text style={styles.officeNoticeText}>No location needed for an office day.</Text>
            </View>
          )}

          <PrimaryButton
            title="Login for the day"
            onPress={handleLogin}
            disabled={!canSubmit}
            loading={loading}
            style={styles.submitButton}
          />

          <Text style={styles.helperText}>
            {workMode === 'office'
              ? 'Marks today as an office day — no dealer visits expected.'
              : 'Records your start location and timestamp.'}
          </Text>
        </FadeSlideIn>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, padding: spacing.screenHorizontal, justifyContent: 'center' },
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  modeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: radius.input,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  modeChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  modeChipText: { ...typography.body, fontWeight: '600', color: colors.textSecondary },
  modeChipTextSelected: { color: colors.textInverse },
  officeNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 54,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  officeNoticeText: { ...typography.body, color: colors.textMuted },
  submitButton: { marginTop: spacing.buttonMargin, marginBottom: spacing.md },
  helperText: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
});
