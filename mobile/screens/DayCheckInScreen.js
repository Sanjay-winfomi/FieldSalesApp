import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ActivityIndicator, Alert } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { getCurrentLocation, getReadableAddress } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';

export default function DayCheckInScreen({ onCheckIn }) {
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
          await enqueueAction('post', '/attendance/check-in', coords);
          Alert.alert('Offline Mode', 'Check-in saved locally and will sync when online.');
          
          // Provide mock attendance block so app can progress
          attendanceData = {
            id: 'offline-' + Date.now(),
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
    <View style={styles.container}>
      <Text style={styles.heading}>Day check-in</Text>

      <View style={styles.mapPlaceholder}>
        <View style={styles.mapPinCircle}>
          <MapPin size={32} color="#0082D1" />
        </View>
        <Text style={styles.mapText}>
          {address ? address : coords ? `GPS: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : 'Acquiring location...'}
        </Text>
        {locationStatus ? (
          <Text style={styles.locationStatus}>{locationStatus}</Text>
        ) : null}
      </View>

      <View style={styles.accuracyRow}>
        <Text style={styles.accuracyLabel}>GPS status</Text>
        <View style={styles.accuracyBadge}>
          <Text style={styles.accuracyValue}>{coords ? 'Location acquired' : 'Acquiring...'}</Text>
        </View>
      </View>

      <TouchableOpacity 
        style={[styles.primaryButton, (!coords || loading) && styles.primaryButtonDisabled]}
        onPress={handleCheckIn}
        disabled={!coords || loading}
      >
        {loading ? (
          <ActivityIndicator color="#FFFFFF" size="small" />
        ) : (
          <Text style={styles.primaryButtonText}>Check in for the day</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.helperText}>
        Records your start location and timestamp.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FAFAFA', padding: 20, justifyContent: 'center' },
  heading: { fontSize: 22, fontWeight: '500', color: '#434343', marginBottom: 20 },
  mapPlaceholder: { height: 200, backgroundColor: '#F2F9FD', borderRadius: 12, borderWidth: 0.5, borderColor: '#D0E3F0', justifyContent: 'center', alignItems: 'center', marginBottom: 20, padding: 16 },
  mapPinCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center', marginBottom: 10, borderWidth: 0.5, borderColor: '#0082D1' },
  mapText: { fontSize: 13, color: '#8A8A8A', textAlign: 'center', lineHeight: 18 },
  locationStatus: { fontSize: 12, color: '#0082D1', marginTop: 6 },
  accuracyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FFFFFF', padding: 16, borderRadius: 12, borderWidth: 0.5, borderColor: '#E0E0E0', marginBottom: 24 },
  accuracyLabel: { fontSize: 14, fontWeight: '500', color: '#434343' },
  accuracyBadge: { backgroundColor: '#F4FBF8', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 0.5, borderColor: '#4FD29F' },
  accuracyValue: { fontSize: 12, fontWeight: '500', color: '#1E6B4B' },
  primaryButton: { height: 48, backgroundColor: '#0082D1', borderRadius: 8, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  primaryButtonDisabled: { backgroundColor: '#A0C8E8' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
  helperText: { fontSize: 12, color: '#A0A0A0', textAlign: 'center' }
});
