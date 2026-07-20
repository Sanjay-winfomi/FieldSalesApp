import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ActivityIndicator, Alert } from 'react-native';
import { Store, Check, AlertTriangle, MapPin } from 'lucide-react-native';
import { getCurrentLocation, getReadableAddress } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';

export default function DealerCheckInScreen({ dealer, attendance, onCheckIn, onCancel }) {
  const [loading, setLoading] = useState(false);
  const [locationStatus, setLocationStatus] = useState('');
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');

  useEffect(() => {
    acquireLocation();
  }, []);

  const acquireLocation = async () => {
    setLocationStatus('Getting GPS location...');
    const loc = await getCurrentLocation();
    if (loc) {
      setCoords(loc);
      setLocationStatus('Resolving address...');
      const addr = await getReadableAddress(loc.lat, loc.lng);
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
      Alert.alert('Error', 'No active attendance session found. Please check in for the day first.');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        attendance_id: attendance.id,
        dealer_id: dealer.id,
        lat: coords.lat,
        lng: coords.lng,
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
          await enqueueAction('post', '/visits/check-in', payload);
          Alert.alert('Offline Mode', 'Dealer check-in saved locally and will sync when online.');
          visitData = {
            id: 'offline-' + Date.now(),
            check_in_time: new Date().toISOString(),
            dealer_id: dealer.id,
            dealer_name: dealer.name,
            check_in_lat: coords.lat,
            check_in_lng: coords.lng,
            within_radius: true,
          };
        } else {
          throw error;
        }
      }

      if (visitData && onCheckIn) {
        onCheckIn(visitData);
      }
    } catch (error) {
      console.error('Dealer check-in error:', error);
      Alert.alert('Error', error.response?.data?.error || 'Failed to check in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const dealerName = dealer?.name || 'Selected Dealer';

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Dealer check-in</Text>
      <Text style={styles.subtitle}>{dealerName}</Text>

      {/* Location Placeholder */}
      <View style={styles.storePlaceholder}>
        <View style={styles.storeCircle}>
          {coords ? <Store size={32} color="#0082D1" /> : <MapPin size={32} color="#8A8A8A" />}
        </View>
        <Text style={styles.storeText}>
          {address ? address : coords ? `GPS: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : 'Acquiring location...'}
        </Text>
        {locationStatus ? (
          <Text style={styles.locationStatus}>{locationStatus}</Text>
        ) : null}
      </View>

      {/* Radius Status Row (shown after acquiring coords) */}
      {coords && (
        <View style={styles.statusRow}>
          <View style={styles.checkCircle}>
            <Check size={16} color="#1E6B4B" />
          </View>
          <Text style={styles.statusText}>Location acquired — ready to check in</Text>
        </View>
      )}

      {/* Primary Action */}
      <TouchableOpacity
        style={[styles.primaryButton, (!coords || loading) && styles.primaryButtonDisabled]}
        onPress={handleCheckIn}
        disabled={!coords || loading}
      >
        {loading ? (
          <ActivityIndicator color="#FFFFFF" size="small" />
        ) : (
          <Text style={styles.primaryButtonText}>Check in at dealer</Text>
        )}
      </TouchableOpacity>

      {onCancel && (
        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAFA', padding: 20, justifyContent: 'center' },
  heading: { fontSize: 22, fontWeight: '500', color: '#434343', marginBottom: 4 },
  subtitle: { fontSize: 16, color: '#8A8A8A', marginBottom: 24 },
  storePlaceholder: { height: 200, backgroundColor: '#F2F9FD', borderRadius: 12, borderWidth: 0.5, borderColor: '#D0E3F0', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  storeCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center', marginBottom: 10, borderWidth: 0.5, borderColor: '#0082D1' },
  storeText: { fontSize: 12, color: '#8A8A8A' },
  locationStatus: { fontSize: 12, color: '#0082D1', marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F4FBF8', padding: 16, borderRadius: 12, borderWidth: 0.5, borderColor: '#4FD29F', marginBottom: 24 },
  checkCircle: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 0.5, borderColor: '#4FD29F', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  statusText: { fontSize: 14, fontWeight: '500', color: '#1E6B4B' },
  primaryButton: { height: 48, backgroundColor: '#0082D1', borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  primaryButtonDisabled: { backgroundColor: '#A0C8E8' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
  cancelButton: { height: 44, borderWidth: 0.5, borderColor: '#D0D0D0', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  cancelButtonText: { color: '#8A8A8A', fontSize: 14 },
});
