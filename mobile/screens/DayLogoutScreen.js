import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';
import { Clock, TrendingUp } from 'lucide-react-native';
import { getCurrentLocation, getReadableAddress, MAX_ACCEPTABLE_ACCURACY_METERS } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { showAlert } from '../src/services/themedAlert';
import { getErrorMessage } from '../src/services/apiError';
import { AppHeader, LocationCard, PrimaryButton, Card, FadeSlideIn } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

export default function DayLogoutScreen({ attendance, onLogout, navigation }) {
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

  const handleLogout = async () => {
    if (!coords) {
      showAlert('Location Required', 'Please wait for GPS to acquire your location.');
      return;
    }
    if (!attendance) {
      showAlert('Error', 'No active attendance session found.');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        attendance_id: attendance.id,
        lat: coords.lat,
        lng: coords.lng,
        accuracy_meters: coords.accuracyMeters,
      };

      let updatedAttendance = null;
      try {
        const response = await api.post('/attendance/logout', payload);
        updatedAttendance = response.data.attendance;
      } catch (error) {
        if (!error.response) {
          await enqueueAction('post', '/attendance/logout', payload);
          showAlert('Offline Mode', 'Logout saved locally and will sync when online.');
          updatedAttendance = {
            ...attendance,
            logout_time: new Date().toISOString(),
          };
        } else if (error.response.data?.error === 'gps_accuracy_exceeded') {
          showAlert('GPS Too Imprecise', 'Your GPS accuracy is too low to log out. Move to an open area for a stronger signal.');
          return;
        } else {
          throw error;
        }
      }

      if (updatedAttendance && onLogout) {
        onLogout(updatedAttendance);
      }
    } catch (error) {
      console.error('Logout error:', error);
      showAlert('Error', getErrorMessage(error, 'Failed to log out. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  const distanceKm = attendance
    ? parseFloat(attendance.total_distance_km || 0).toFixed(1)
    : '0.0';

  const accuracyOk = !!coords && coords.accuracyMeters != null && coords.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS;
  const accuracyMessage = coords && !accuracyOk
    ? `GPS accuracy is ±${Math.round(coords.accuracyMeters)}m — move to an open area for a stronger signal.`
    : locationStatus;

  return (
    <View style={styles.screen}>
      <AppHeader title="Logout" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.container}>
        <FadeSlideIn>
          <Card style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={styles.summaryLeft}>
                <Clock size={16} color={colors.textMuted} style={{ marginRight: 8 }} />
                <Text style={styles.summaryLabel}>Login</Text>
              </View>
              <Text style={styles.summaryValue}>{formatTime(attendance?.login_time)}</Text>
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
          {coords && !accuracyOk && (
            <Text style={styles.accuracyWarning}>{accuracyMessage}</Text>
          )}

          <PrimaryButton
            title="Logout for the day"
            onPress={handleLogout}
            disabled={!coords || !accuracyOk}
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
  accuracyWarning: { ...typography.caption, color: colors.primary, textAlign: 'center', marginBottom: spacing.sm },
});
