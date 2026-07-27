import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Alert, ScrollView } from 'react-native';
import { getCurrentLocation, getReadableAddress } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { AppHeader, GPSStatusCard, PrimaryButton, FadeSlideIn } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

export default function DayCheckInScreen({ onCheckIn, navigation }) {
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

  const handleCheckIn = async () => {
    if (!coords) {
      Alert.alert('Location Required', 'Please wait for GPS to acquire your location.');
      return;
    }

    setLoading(true);
    setLocationStatus('Syncing check-in...');

    try {
      let attendanceData = null;
      try {
        const response = await api.post('/attendance/check-in', coords);
        attendanceData = response.data.attendance;
      } catch (error) {
        if (!error.response) {
          // Network error - enqueue
          const localId = 'offline-' + Date.now();
          await enqueueAction('post', '/attendance/check-in', coords, { localId, resolves: 'attendance' });
          Alert.alert('Offline Mode', 'Check-in saved locally and will sync when online.');

          // Provide mock attendance block so app can progress
          attendanceData = {
            id: localId,
            check_in_time: new Date().toISOString(),
            check_in_lat: coords.lat,
            check_in_lng: coords.lng,
            total_distance_km: 0
          };
        } else if (error.response.status === 409) {
          Alert.alert('Already checked in', 'You have already checked in for today.');
        } else {
          throw error;
        }
      }

      if (attendanceData && onCheckIn) {
        onCheckIn(attendanceData);
      }

    } catch (error) {
      console.error('Check-in error:', error);
      Alert.alert('Error', 'Failed to check in. Please try again.');
    } finally {
      setLoading(false);
      setLocationStatus('');
    }
  };

  return (
    <View style={styles.screen}>
      <AppHeader title="Day check-in" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container}>
        <FadeSlideIn>
          <GPSStatusCard
            address={address}
            coords={coords}
            statusMessage={locationStatus}
            accuracyMeters={coords?.accuracyMeters}
          />

          <PrimaryButton
            title="Check in for the day"
            onPress={handleCheckIn}
            disabled={!coords}
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
