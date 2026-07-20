import React, { useState, useEffect } from 'react';
import { StyleSheet, View, SafeAreaView, Alert } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { api } from './src/services/api';

// Screen Imports
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import HomeScreen from './screens/HomeScreen';
import DayCheckInScreen from './screens/DayCheckInScreen';
import DealerCheckInScreen from './screens/DealerCheckInScreen';
import DealerCheckOutScreen from './screens/DealerCheckOutScreen';
import DayCheckOutScreen from './screens/DayCheckOutScreen';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState('SPLASH');
  
  // App State
  const [employee, setEmployee] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [visits, setVisits] = useState([]);
  const [selectedDealer, setSelectedDealer] = useState(null);
  const [loading, setLoading] = useState(false);

  const [refreshing, setRefreshing] = useState(false);

  // Computed state
  const dayStatus = !attendance 
    ? 'not_checked_in' 
    : attendance.check_out_time 
      ? 'day_ended' 
      : 'checked_in';
      
  const visitsCount = visits.length;
  const distanceTravelled = attendance ? `${parseFloat(attendance.total_distance_km || 0).toFixed(1)} km` : '0.0 km';

  useEffect(() => {
    const initializeApp = async () => {
      try {
        const token = await SecureStore.getItemAsync('accessToken');
        const empStr = await AsyncStorage.getItem('employeeData');
        
        if (token && empStr) {
          setEmployee(JSON.parse(empStr));
          await fetchTodayState();
          setCurrentScreen('HOME');
        } else {
          setCurrentScreen('LOGIN');
        }
      } catch (error) {
        console.error('Error initializing app:', error);
        setCurrentScreen('LOGIN');
      }
    };

    if (currentScreen === 'SPLASH') {
      // Minimum 1.5s splash screen display
      const timer = setTimeout(() => {
        initializeApp();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [currentScreen]);

  const fetchTodayState = async () => {
    setRefreshing(true);
    try {
      const response = await api.get('/attendance/today');
      setAttendance(response.data.attendance);
      setVisits(response.data.visits || []);
    } catch (error) {
      console.error('Failed to fetch today state:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleLoginSuccess = async () => {
    const empStr = await AsyncStorage.getItem('employeeData');
    if (empStr) setEmployee(JSON.parse(empStr));
    await fetchTodayState();
    setCurrentScreen('HOME');
  };

  const handleDayCheckIn = async (newAttendance) => {
    setAttendance(newAttendance);
    setCurrentScreen('HOME');
  };

  const handleSelectDealer = (dealer, shouldCheckIn = false) => {
    setSelectedDealer(dealer);

    if (!shouldCheckIn) return; // First tap — just select, no navigation

    // Second tap — the user wants to check in at this dealer
    if (dayStatus === 'not_checked_in') {
      Alert.alert(
        'Day check-in required',
        'You need to check in for the day before visiting a dealer. Go to the Home tab and tap "Check in".',
        [
          { text: 'Go to Home', onPress: () => setCurrentScreen('HOME') },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    if (dayStatus === 'day_ended') {
      Alert.alert('Day ended', 'Your work day has already ended. You cannot check in at a dealer.');
      return;
    }

    // dayStatus === 'checked_in' — find if there is an active open visit for this dealer
    const activeVisit =
      visits.find(v => v.dealer_id === dealer.id && !v.check_out_time) ||
      visits.find(v => !v.check_out_time);

    if (activeVisit) {
      setCurrentScreen('DEALER_CHECK_OUT');
    } else {
      setCurrentScreen('DEALER_CHECK_IN');
    }
  };

  const handleDealerCheckIn = async (newVisit) => {
    // Add to local state immediately
    setVisits([...visits, newVisit]);
    setCurrentScreen('HOME');
  };

  const handleDealerCheckOut = async (updatedVisit) => {
    // Update local visit and attendance state
    setVisits(visits.map(v => v.id === updatedVisit.id ? updatedVisit : v));
    await fetchTodayState(); // Refresh to get updated total distance
    setCurrentScreen('HOME');
  };

  const handleDayCheckOut = async (updatedAttendance) => {
    setAttendance(updatedAttendance);
    setCurrentScreen('HOME');
  };

  const handleLogout = async () => {
    try {
      await SecureStore.deleteItemAsync('accessToken');
      await SecureStore.deleteItemAsync('refreshToken');
      await AsyncStorage.removeItem('employeeData');
      setEmployee(null);
      setAttendance(null);
      setVisits([]);
      setSelectedDealer(null);
      setCurrentScreen('LOGIN');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const renderActiveScreen = () => {
    switch (currentScreen) {
      case 'SPLASH':
        return <SplashScreen />;
      case 'LOGIN':
        return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
      case 'HOME':
        return (
          <HomeScreen
            employee={employee}
            dayStatus={dayStatus}
            visitsCount={visitsCount}
            distanceTravelled={distanceTravelled}
            attendance={attendance}
            visits={visits}
            refreshing={refreshing}
            onRefresh={fetchTodayState}
            onNavigateToDayCheckIn={() => setCurrentScreen('DAY_CHECK_IN')}
            onNavigateToDayCheckOut={() => {
              const activeVisit = visits.find(v => !v.check_out_time);
              if (activeVisit) {
                Alert.alert(
                  'Active Dealer Visit',
                  `You must check out from "${activeVisit.dealer_name || 'Dealer'}" before you can check out for the day.`
                );
              } else {
                setCurrentScreen('DAY_CHECK_OUT');
              }
            }}
            onSelectDealer={handleSelectDealer}
            onLogout={handleLogout}
          />
        );
      case 'DAY_CHECK_IN':
        return <DayCheckInScreen onCheckIn={handleDayCheckIn} />;
      case 'DEALER_CHECK_IN':
        return (
          <DealerCheckInScreen
            dealer={selectedDealer}
            attendance={attendance}
            onCheckIn={handleDealerCheckIn}
            onCancel={() => setCurrentScreen('HOME')}
          />
        );
      case 'DEALER_CHECK_OUT': {
        // Primary: match by dealer_id (both are integers from the API)
        // Fallback: the most-recent open visit — handles edge cases where
        // dealer_id was missing in state (e.g. app opened mid-session).
        const activeVisit =
          visits.find(v => v.dealer_id === selectedDealer?.id && !v.check_out_time) ||
          visits.find(v => !v.check_out_time);
        return (
          <DealerCheckOutScreen
            dealer={selectedDealer}
            activeVisit={activeVisit}
            onCheckOut={handleDealerCheckOut}
            onCancel={() => setCurrentScreen('HOME')}
          />
        );
      }
      case 'DAY_CHECK_OUT':
        return (
          <DayCheckOutScreen 
            attendance={attendance}
            onCheckOut={handleDayCheckOut} 
            onCancel={() => setCurrentScreen('HOME')}
          />
        );
      default:
        return <SplashScreen />;
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.screenContainer}>
        {renderActiveScreen()}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FAFAFA',
  },
  screenContainer: {
    flex: 1,
  },
});
