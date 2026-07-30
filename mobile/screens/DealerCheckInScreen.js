import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Alert, ScrollView } from 'react-native';
import { getCurrentLocation, getReadableAddress, MAX_ACCEPTABLE_ACCURACY_METERS } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { AppHeader, GPSStatusCard, PrimaryButton, TextField, FadeSlideIn } from '../src/components';
import { colors, spacing } from '../src/theme';

const MIN_REASON_LENGTH = 20;

export default function DealerCheckInScreen({ dealer, attendance, onCheckIn, navigation }) {
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

  const handleCheckIn = async () => {
    if (!coords) {
      Alert.alert('Location Required', 'Please wait for GPS to acquire your location.');
      return;
    }
    if (!attendance) {
      Alert.alert('Error', 'No active attendance session found. Please log in for the day first.');
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
        const response = await api.post('/visits/check-in', payload);
        // Merge dealer_id explicitly — guarantees the field is present for
        // the active-visit lookup in App.js regardless of RETURNING clause state.
        visitData = { ...response.data.visit, dealer_id: dealer.id };
      } catch (error) {
        if (!error.response) {
          // Network error — enqueue and proceed
          const localId = 'offline-' + Date.now();
          await enqueueAction('post', '/visits/check-in', payload, { localId, resolves: 'visit' });
          Alert.alert('Offline Mode', 'Dealer login saved locally and will sync when online.');
          visitData = {
            id: localId,
            check_in_time: new Date().toISOString(),
            dealer_id: dealer.id,
            dealer_name: dealer.name,
            check_in_lat: coords.lat,
            check_in_lng: coords.lng,
            within_radius: true,
          };
        } else if (error.response.data?.error === 'reason_required') {
          setReasonRequired({ distanceMeters: error.response.data.distanceMeters });
          return;
        } else if (error.response.data?.error === 'gps_accuracy_exceeded') {
          Alert.alert('GPS Too Imprecise', 'Your GPS accuracy is too low to log in. Move to an open area for a stronger signal.');
          return;
        } else {
          throw error;
        }
      }

      if (visitData && onCheckIn) {
        onCheckIn(visitData);
      }
    } catch (error) {
      console.error('Dealer login error:', error);
      Alert.alert('Error', error.response?.data?.error || 'Failed to log in. Please try again.');
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
            onPress={handleCheckIn}
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
