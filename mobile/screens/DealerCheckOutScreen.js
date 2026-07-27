import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Alert, ScrollView } from 'react-native';
import { Timer } from 'lucide-react-native';
import { getCurrentLocation, getReadableAddress, MAX_ACCEPTABLE_ACCURACY_METERS } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';
import { AppHeader, LocationCard, PrimaryButton, TextField, Card, FadeSlideIn } from '../src/components';
import { colors, typography, spacing } from '../src/theme';

const MIN_REASON_LENGTH = 20;

export default function DealerCheckOutScreen({ dealer, activeVisit, onCheckOut, navigation }) {
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');
  const [locationStatus, setLocationStatus] = useState('');
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

  const handleCheckOut = async () => {
    if (!coords) {
      Alert.alert('Location Required', 'Please wait for GPS to acquire your location.');
      return;
    }
    if (!activeVisit) {
      Alert.alert('Error', 'No active dealer visit found.');
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
        const response = await api.post('/visits/check-out', payload);
        updatedVisit = response.data.visit;
      } catch (error) {
        if (!error.response) {
          // Network error — enqueue and proceed
          await enqueueAction('post', '/visits/check-out', payload);
          Alert.alert('Offline Mode', 'Dealer check-out saved locally and will sync when online.');
          updatedVisit = {
            ...activeVisit,
            id: activeVisit.id,
            check_out_time: new Date().toISOString(),
          };
        } else if (error.response.data?.error === 'reason_required') {
          setReasonRequired({ distanceMeters: error.response.data.distanceMeters });
          return;
        } else if (error.response.data?.error === 'gps_accuracy_exceeded') {
          Alert.alert('GPS Too Imprecise', 'Your GPS accuracy is too low to check out. Move to an open area for a stronger signal.');
          return;
        } else {
          throw error;
        }
      }

      if (updatedVisit && onCheckOut) {
        onCheckOut(updatedVisit);
      }
    } catch (error) {
      console.error('Dealer check-out error:', error);
      Alert.alert('Error', error.response?.data?.error || 'Failed to check out. Please try again.');
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

  // Calculate elapsed time if activeVisit has a check_in_time
  const getElapsedMinutes = () => {
    if (!activeVisit?.check_in_time) return null;
    const start = new Date(activeVisit.check_in_time);
    return Math.round((Date.now() - start) / 60000);
  };

  const formatVisitStart = () => {
    if (!activeVisit?.check_in_time) return '—';
    return new Date(activeVisit.check_in_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  const dealerName = dealer?.name || 'Dealer';
  const elapsedMinutes = getElapsedMinutes();

  return (
    <View style={styles.screen}>
      <AppHeader title="Dealer check-out" subtitle={dealerName} onBack={() => navigation.goBack()} />
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

          <LocationCard address={address} coords={coords} statusMessage={accuracyMessage} />

          {needsReason && (
            <TextField
              label={`You're ~${Math.round(reasonRequired.distanceMeters)}m from the dealer. Enter a reason (min ${MIN_REASON_LENGTH} characters) to continue.`}
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. Dealer accompanied me to warehouse"
              style={styles.reasonField}
            />
          )}

          <PrimaryButton
            title={needsReason ? 'Submit reason & check out' : 'Check out of dealer'}
            onPress={handleCheckOut}
            disabled={!coords || !accuracyOk || (needsReason && !reasonOk)}
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
});
