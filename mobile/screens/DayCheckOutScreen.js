import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Alert, ScrollView } from 'react-native';
import { Clock, TrendingUp } from 'lucide-react-native';
import { getCurrentLocation, getReadableAddress } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { AppHeader, LocationCard, PrimaryButton, Card, FadeSlideIn } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

export default function DayCheckOutScreen({ attendance, onCheckOut, navigation }) {
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');
  const [locationStatus, setLocationStatus] = useState('');
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

  const formatTime = (isoStr) => {
    if (!isoStr) return '—';
    return new Date(isoStr).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  };

  const handleCheckOut = async () => {
    if (!coords) {
      Alert.alert('Location Required', 'Please wait for GPS to acquire your location.');
      return;
    }
    if (!attendance) {
      Alert.alert('Error', 'No active attendance session found.');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        attendance_id: attendance.id,
        lat: coords.lat,
        lng: coords.lng,
      };

      let updatedAttendance = null;
      try {
        const response = await api.post('/attendance/check-out', payload);
        updatedAttendance = response.data.attendance;
      } catch (error) {
        if (!error.response) {
          await enqueueAction('post', '/attendance/check-out', payload);
          Alert.alert('Offline Mode', 'Day check-out saved locally and will sync when online.');
          updatedAttendance = {
            ...attendance,
            check_out_time: new Date().toISOString(),
          };
        } else {
          throw error;
        }
      }

      if (updatedAttendance && onCheckOut) {
        onCheckOut(updatedAttendance);
      }
    } catch (error) {
      console.error('Day check-out error:', error);
      Alert.alert('Error', error.response?.data?.error || 'Failed to check out. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const distanceKm = attendance
    ? parseFloat(attendance.total_distance_km || 0).toFixed(1)
    : '0.0';

  return (
    <View style={styles.screen}>
      <AppHeader title="Day check-out" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container}>
        <FadeSlideIn>
          <Card style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryLeft}>
                <Clock size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
                <Text style={styles.summaryLabel}>Check-in</Text>
              </View>
              <Text style={styles.summaryValue}>{formatTime(attendance?.check_in_time)}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.summaryRow}>
              <View style={styles.summaryLeft}>
                <TrendingUp size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
                <Text style={styles.summaryLabel}>Distance travelled</Text>
              </View>
              <Text style={styles.summaryValue}>{distanceKm} km</Text>
            </View>
          </Card>

          <LocationCard address={address} coords={coords} statusMessage={locationStatus} />

          <PrimaryButton
            title="Check out for the day"
            onPress={handleCheckOut}
            disabled={!coords}
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
});
