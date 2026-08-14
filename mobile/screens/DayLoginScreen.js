import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';
import { getCurrentLocation, getReadableAddress, MAX_ACCEPTABLE_ACCURACY_METERS } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { showAlert } from '../src/services/themedAlert';
import { AppHeader, GPSStatusCard, PrimaryButton, FadeSlideIn } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

export default function DayLoginScreen({ onLogin, onAlreadyLoggedIn, navigation }) {
  const [loading, setLoading] = useState(false);
  const [locationStatus, setLocationStatus] = useState('');
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');
  // Guards against setState after the user navigates away mid-acquisition —
  // acquireLocation is an unguarded async chain, so without this a slow GPS/
  // geocode response can still resolve and update state on an unmounted screen.
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

    setLoading(true);
    setLocationStatus('Syncing login...');

    const payload = { lat: coords.lat, lng: coords.lng, accuracy_meters: coords.accuracyMeters };

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
            login_lat: coords.lat,
            login_lng: coords.lng,
            total_distance_km: 0
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
      showAlert('Error', 'Failed to log in. Please try again.');
    } finally {
      setLoading(false);
      setLocationStatus('');
    }
  };

  const accuracyOk = !!coords && coords.accuracyMeters != null && coords.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS;
  const accuracyMessage = coords && !accuracyOk
    ? `GPS accuracy is ±${Math.round(coords.accuracyMeters)}m — move to an open area for a stronger signal.`
    : locationStatus;

  return (
    <View style={styles.screen}>
      <AppHeader title="Login" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container}>
        <FadeSlideIn>
          <GPSStatusCard
            address={address}
            coords={coords}
            statusMessage={accuracyMessage}
            accuracyMeters={coords?.accuracyMeters}
          />

          <PrimaryButton
            title="Login for the day"
            onPress={handleLogin}
            disabled={!coords || !accuracyOk}
            loading={loading}
            style={styles.submitButton}
          />

          <Text style={styles.helperText}>
            Records your start location and timestamp.
          </Text>
        </FadeSlideIn>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, padding: spacing.screenHorizontal, justifyContent: 'center' },
  submitButton: { marginTop: spacing.buttonMargin, marginBottom: spacing.md },
  helperText: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
});
