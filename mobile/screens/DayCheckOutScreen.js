import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ActivityIndicator, Alert } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { getCurrentLocation, getReadableAddress } from '../src/services/location';
import { api } from '../src/services/api';
import { enqueueAction } from '../src/services/syncManager';

export default function DayCheckOutScreen({ attendance, onCheckOut, onCancel }) {
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
    <View style={styles.container}>
      <Text style={styles.heading}>Day check-out</Text>

      {/* Summary Card */}
      <View style={styles.summaryCard}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Check-in</Text>
          <Text style={styles.summaryValue}>{formatTime(attendance?.check_in_time)}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Distance travelled</Text>
          <Text style={styles.summaryValue}>{distanceKm} km</Text>
        </View>
      </View>

      {/* Location Status Box */}
      <View style={styles.locationBox}>
        <MapPin size={18} color={coords ? '#0082D1' : '#8A8A8A'} style={{ marginRight: 8 }} />
        <Text style={styles.locationText}>
          {address ? address : coords
            ? `GPS: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`
            : locationStatus || 'Acquiring location...'}
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.primaryButton, (!coords || loading) && styles.primaryButtonDisabled]}
        onPress={handleCheckOut}
        disabled={!coords || loading}
      >
        {loading ? (
          <ActivityIndicator color="#FFFFFF" size="small" />
        ) : (
          <Text style={styles.primaryButtonText}>Check out for the day</Text>
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
  heading: { fontSize: 22, fontWeight: '500', color: '#434343', marginBottom: 20 },
  summaryCard: { backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 0.5, borderColor: '#E0E0E0', padding: 16, marginBottom: 16 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
  summaryLabel: { fontSize: 14, color: '#8A8A8A' },
  summaryValue: { fontSize: 14, fontWeight: '500', color: '#434343' },
  divider: { height: 0.5, backgroundColor: '#E0E0E0' },
  locationBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', padding: 16, borderRadius: 12, borderWidth: 0.5, borderColor: '#E0E0E0', marginBottom: 20 },
  locationText: { fontSize: 13, color: '#434343', flex: 1 },
  primaryButton: { height: 48, backgroundColor: '#0082D1', borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  primaryButtonDisabled: { backgroundColor: '#A0C8E8' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
  cancelButton: { height: 44, borderWidth: 0.5, borderColor: '#D0D0D0', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  cancelButtonText: { color: '#8A8A8A', fontSize: 14 },
});
