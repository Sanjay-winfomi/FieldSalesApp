import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ActivityIndicator, Alert } from 'react-native';
import { Check, MapPin } from 'lucide-react-native';
import { getCurrentLocation, getReadableAddress } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';

export default function DealerCheckOutScreen({ dealer, activeVisit, onCheckOut, onCancel }) {
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState(null);
  const [address, setAddress] = useState('');
  const [locationStatus, setLocationStatus] = useState('');

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

  // Calculate elapsed time if activeVisit has a check_in_time
  const getElapsedTime = () => {
    if (!activeVisit?.check_in_time) return '';
    const start = new Date(activeVisit.check_in_time);
    const now = new Date();
    const mins = Math.round((now - start) / 60000);
    return ` — visit ${mins} min`;
  };

  const dealerName = dealer?.name || 'Dealer';

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Dealer check-out</Text>
      <Text style={styles.subtitle}>{dealerName}{getElapsedTime()}</Text>

      {/* Location Status */}
      <View style={styles.locationBox}>
        <MapPin size={18} color={coords ? '#0082D1' : '#8A8A8A'} style={{ marginRight: 8 }} />
        <Text style={styles.locationText}>
          {address ? address : coords
            ? `GPS: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`
            : locationStatus || 'Acquiring location...'}
        </Text>
      </View>

      {coords && (
        <View style={styles.greenStatusRow}>
          <View style={styles.greenIconCircle}>
            <Check size={16} color="#1E6B4B" />
          </View>
          <Text style={styles.greenStatusText}>Location acquired — ready to check out</Text>
        </View>
      )}

      {/* Primary Action */}
      <TouchableOpacity
        style={[styles.primaryButton, (!coords || loading) && styles.primaryButtonDisabled]}
        onPress={handleCheckOut}
        disabled={!coords || loading}
      >
        {loading ? (
          <ActivityIndicator color="#FFFFFF" size="small" />
        ) : (
          <Text style={styles.primaryButtonText}>Check out of dealer</Text>
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
  subtitle: { fontSize: 16, color: '#8A8A8A', marginBottom: 20 },
  locationBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', padding: 16, borderRadius: 12, borderWidth: 0.5, borderColor: '#E0E0E0', marginBottom: 16 },
  locationText: { fontSize: 13, color: '#434343', flex: 1 },
  greenStatusRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F4FBF8', padding: 16, borderRadius: 12, borderWidth: 0.5, borderColor: '#4FD29F', marginBottom: 20 },
  greenIconCircle: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFFFFF', borderWidth: 0.5, borderColor: '#4FD29F', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  greenStatusText: { fontSize: 14, fontWeight: '500', color: '#1E6B4B' },
  primaryButton: { height: 48, backgroundColor: '#0082D1', borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  primaryButtonDisabled: { backgroundColor: '#A0C8E8' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
  cancelButton: { height: 44, borderWidth: 0.5, borderColor: '#D0D0D0', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  cancelButtonText: { color: '#8A8A8A', fontSize: 14 },
});
