import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getLocationPermissionStatus, openLocationSettings, requestBackgroundLocationPermission } from './src/services/location';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, setAuthInvalidatedHandler } from './src/services/api';
import { startAutoSync, stopAutoSync, getPendingCount, flushQueue, clearQueue, setConflictHandler } from './src/services/syncManager';
import { startVisitMonitoring, stopVisitMonitoring } from './src/services/visitMonitor';
import { startDealerGeofence, stopDealerGeofence } from './src/services/geofenceTask';
import { configureNotificationHandler } from './src/services/reminderNotifications';
import { configureGeofenceNotificationChannel, sendGeofenceNotification } from './src/services/geofenceNotifications';
import { AppStateContext } from './src/context/AppStateContext';
import MainTabs from './src/navigation/MainTabs';
import { colors } from './src/theme';
import { ThemedAlertHost } from './src/components';
import { showAlert } from './src/services/themedAlert';

// Screen Imports
import SplashScreen from './screens/SplashScreen';
import LoginScreen from './screens/LoginScreen';
import ForgotPasswordScreen from './screens/ForgotPasswordScreen';
import DayLoginScreen from './screens/DayLoginScreen';
import DealerLoginScreen from './screens/DealerLoginScreen';
import DealerLogoutScreen from './screens/DealerLogoutScreen';
import DayLogoutScreen from './screens/DayLogoutScreen';
import NotesScreen from './screens/NotesScreen';
import NoteEditorScreen from './screens/NoteEditorScreen';
import RemindersScreen from './screens/RemindersScreen';
import ReminderEditorScreen from './screens/ReminderEditorScreen';
import AboutScreen from './screens/AboutScreen';

const Stack = createNativeStackNavigator();

// Owns the splash timing/auth-check, then hands off to Login or the main
// tab shell. A tiny wrapper rather than folding this into App() directly,
// since it needs `navigation` (only available inside a screen) to replace
// the route.
function SplashRoute({ navigation, setEmployee, fetchTodayState }) {
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const token = await SecureStore.getItemAsync('accessToken');
        const empStr = await AsyncStorage.getItem('employeeData');

        if (token && empStr) {
          setEmployee(JSON.parse(empStr));
          // Don't block leaving the splash on this — it hits the backend,
          // which can take up to a minute to respond on a Render cold start.
          // Navigate now; MainTabs already shows a refreshing state while
          // this resolves in the background.
          fetchTodayState();
          navigation.replace('MainTabs');
        } else {
          navigation.replace('Login');
        }
      } catch (error) {
        console.error('Error initializing app:', error);
        navigation.replace('Login');
      }
    }, 1500); // Minimum splash screen display time

    return () => clearTimeout(timer);
  }, []);

  return <SplashScreen />;
}

export default function App() {
  // App State — unchanged from before this redesign; only how it's *handed
  // to screens* changed (via AppStateContext instead of direct props), since
  // Home/Dealers/History/Profile are now separate tab routes instead of
  // panes inside one HomeScreen component.
  const [employee, setEmployee] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [visits, setVisits] = useState([]);
  const [selectedDealer, setSelectedDealer] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);
  const [locationPermissionCanAskAgain, setLocationPermissionCanAskAgain] = useState(true);
  const navigationRef = useNavigationContainerRef();
  // fetchTodayState is triggered from several independent, possibly-overlapping
  // sources (pull-to-refresh, sync-conflict reconciliation, post-logout
  // refresh, login) — sequences requests so a slower, older response can't
  // overwrite state a newer response already set.
  const todayStateSeqRef = useRef(0);

  // Computed state
  const dayStatus = !attendance
    ? 'not_logged_in'
    : attendance.logout_time
      ? 'day_ended'
      : 'logged_in';

  const visitsCount = visits.length;
  const distanceTravelled = attendance ? `${parseFloat(attendance.total_distance_km || 0).toFixed(1)} km` : '0.0 km';

  // Requests notification permission and sets up the Android notification
  // channel once at startup, so reminders scheduled later already have
  // permission in place rather than prompting mid-flow.
  useEffect(() => {
    configureNotificationHandler();
    configureGeofenceNotificationChannel();
  }, []);

  // Auto-sync any queued offline actions whenever a session is active, and
  // resume flushing automatically as soon as connectivity comes back.
  useEffect(() => {
    if (!employee) return;
    startAutoSync();
    return () => stopAutoSync();
  }, [employee]);

  // A queued offline action can conflict with state the server already has
  // (e.g. a retried day logout racing one that already succeeded) —
  // syncManager reconciles by dropping the redundant action but reports it
  // here, rather than leaving the UI silently out of sync with what the
  // server actually recorded.
  useEffect(() => {
    if (!employee) return;
    setConflictHandler(() => fetchTodayState());
    return () => setConflictHandler(null);
  }, [employee]);

  // Keep the "N pending sync" indicator up to date while a session is active.
  useEffect(() => {
    if (!employee) return;
    const refreshPendingCount = () => getPendingCount().then(setPendingSyncCount);
    refreshPendingCount();
    const interval = setInterval(refreshPendingCount, 10000);
    return () => clearInterval(interval);
  }, [employee]);

  // Random Location Verification: while there's an open dealer visit, ping
  // the backend with the rep's location every 10 minutes while the app is
  // foregrounded (visitMonitor.js), AND register a background geofence
  // around the dealer (geofenceTask.js) so the OS itself reports the rep
  // leaving/re-entering the radius even if the app is fully closed — reps
  // routinely log in and pocket the phone, so the foreground-only ping alone
  // left the dashboard showing a stale login-time status for the whole
  // visit. Both paths report to the same backend endpoint, so they
  // complement rather than conflict. Restarts whenever the active visit
  // changes (new login, or logged out — which clears it) so it always
  // tracks the current visit, never a stale one.
  const activeVisit = visits.find((v) => !v.logout_time);

  // Keyed on the active visit's id (not the `visits` array itself) — a
  // fetchTodayState() refresh of the SAME open visit (e.g. triggered by
  // onLogoutAlert below) produces a new `visits` array reference every time,
  // which would otherwise restart monitoring and reset its one-shot alert
  // dedupe (visitMonitor's logoutAlertAlready), re-firing onLogoutAlert,
  // re-triggering fetchTodayState, and looping the alert forever.
  const activeVisitId = activeVisit?.id ?? null;

  useEffect(() => {
    if (!activeVisit) {
      stopVisitMonitoring();
      stopDealerGeofence();
      return;
    }

    startVisitMonitoring({
      visit: activeVisit,
      onWarning: () => {
        sendGeofenceNotification({
          title: 'Leaving dealer premises',
          body: 'You appear to have left the dealer location. Please return, or log out if the visit has ended.',
        });
      },
      onLogoutAlert: () => {
        sendGeofenceNotification({
          title: 'Time to log out',
          body: 'You have been outside the dealer premises multiple times during this visit. Please return and log out — your manager has also been notified.',
        });
        fetchTodayState();
      },
      // Additive alongside onWarning/onLogoutAlert above (both unchanged) —
      // fed by the backend's new staged 10/20/30-min excursion tracker.
      // The server decides timing/copy; this just relays whatever it sends.
      onRepNotification: (notification) => {
        sendGeofenceNotification(notification);
      },
    });

    if (activeVisit.dealer_latitude != null && activeVisit.dealer_longitude != null) {
      requestBackgroundLocationPermission().then((granted) => {
        if (granted) {
          startDealerGeofence(activeVisit, {
            latitude: activeVisit.dealer_latitude,
            longitude: activeVisit.dealer_longitude,
            radius_meters: activeVisit.dealer_radius_meters,
          });
        }
      });
    }

    return () => {
      stopVisitMonitoring();
      stopDealerGeofence();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVisitId]);

  // Detect location permission revoked mid-session (e.g. via OS settings while
  // the app was backgrounded) so GPS-dependent screens can warn instead of
  // silently failing to acquire a location.
  useEffect(() => {
    if (!employee) return;

    const checkPermission = async () => {
      const { granted, canAskAgain } = await getLocationPermissionStatus();
      setLocationPermissionDenied(!granted);
      setLocationPermissionCanAskAgain(canAskAgain);
    };

    checkPermission();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') checkPermission();
    });
    return () => subscription.remove();
  }, [employee]);

  // If a token refresh ever fails (refresh token expired/invalid), the
  // session is genuinely over — api.js already cleared storage, so reset
  // in-memory state here and send the user back to Login. Without this the
  // user was previously stuck on whatever screen they were on, with every
  // request silently 401ing and no way back except force-quitting the app.
  useEffect(() => {
    setAuthInvalidatedHandler(() => {
      setEmployee(null);
      setAttendance(null);
      setVisits([]);
      setPendingSyncCount(0);
      setSelectedDealer(null);
      clearQueue();
      navigationRef.current?.resetRoot({ index: 0, routes: [{ name: 'Login' }] });
    });
    return () => setAuthInvalidatedHandler(null);
  }, []);

  const fetchTodayState = async () => {
    const seq = ++todayStateSeqRef.current;
    setRefreshing(true);
    try {
      const response = await api.get('/attendance/today');
      if (seq !== todayStateSeqRef.current) return; // a newer call has since started
      setAttendance(response.data.attendance);
      setVisits(response.data.visits || []);
    } catch (error) {
      if (seq !== todayStateSeqRef.current) return;
      console.error('Failed to fetch today state:', error);
    } finally {
      if (seq === todayStateSeqRef.current) setRefreshing(false);
    }
  };

  const handleLoginSuccess = async () => {
    const empStr = await AsyncStorage.getItem('employeeData');
    if (empStr) {
      try {
        setEmployee(JSON.parse(empStr));
      } catch (error) {
        console.error('Corrupt employeeData in storage:', error);
        await AsyncStorage.removeItem('employeeData');
        return;
      }
    }
    await fetchTodayState();
  };

  const handleDayLogin = (newAttendance) => {
    setAttendance(newAttendance);
  };

  const handleSelectDealer = (dealer, shouldLogin, navigation) => {
    setSelectedDealer(dealer);

    if (!shouldLogin) return; // First tap — just select, no navigation

    // Second tap — the user wants to check in at this dealer
    if (dayStatus === 'not_logged_in') {
      showAlert(
        'Login required',
        'You need to log in for the day before visiting a dealer. Go to the Home tab and tap "Login".',
        [
          { text: 'Go to Home', onPress: () => navigation.navigate('Home') },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    if (dayStatus === 'day_ended') {
      showAlert('Day ended', 'Your work day has already ended. You cannot log in to a dealer.');
      return;
    }

    // dayStatus === 'logged_in' — find if there is an active open visit for this dealer
    const activeVisit =
      visits.find(v => v.dealer_id === dealer.id && !v.logout_time) ||
      visits.find(v => !v.logout_time);

    if (activeVisit) {
      navigation.navigate('DealerLogout');
    } else {
      navigation.navigate('DealerLogin');
    }
  };

  const handleDealerLogin = (newVisit) => {
    setVisits((prev) => [...prev, newVisit]);
  };

  const handleDealerLogout = async (updatedVisit) => {
    setVisits((prev) => prev.map(v => v.id === updatedVisit.id ? updatedVisit : v));
    await fetchTodayState(); // Refresh to get updated total distance
  };

  const handleDayLogout = (updatedAttendance) => {
    setAttendance(updatedAttendance);
  };

  const handleLogout = async (navigation) => {
    try {
      // Best-effort: try to sync any pending actions under this user's identity
      // before clearing anything. Whatever's still left afterward (genuinely
      // offline) must be discarded, not carried over — otherwise the next
      // person who logs in on this device would have it flushed under their
      // own account instead.
      await flushQueue();
      await clearQueue();

      await SecureStore.deleteItemAsync('accessToken');
      await SecureStore.deleteItemAsync('refreshToken');
      await AsyncStorage.removeItem('employeeData');
      setEmployee(null);
      setAttendance(null);
      setVisits([]);
      setPendingSyncCount(0);
      setSelectedDealer(null);
      // Logout is dispatched from a screen nested inside MainTabs (the tab
      // navigator), which has no meaningful "replace" of its own — reach the
      // parent root Stack explicitly so the whole app resets to Login.
      (navigation.getParent() || navigation).replace('Login');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  // Bundles the state/handlers every tab screen needs, so Home/Dealers/
  // History/Profile can each read what they need without HomeScreen owning
  // all of them and passing them down as before.
  const appStateValue = {
    employee,
    attendance,
    visits,
    dayStatus,
    visitsCount,
    distanceTravelled,
    refreshing,
    pendingSyncCount,
    locationPermissionDenied,
    locationPermissionCanAskAgain,
    onOpenLocationSettings: openLocationSettings,
    fetchTodayState,
    onSelectDealer: handleSelectDealer,
    onLogout: handleLogout,
  };

  return (
    <SafeAreaProvider>
      <View style={styles.container}>
        {/* Not translucent: on Android this lets the OS reserve the status
            bar's own space (content starts safely below it) instead of
            drawing underneath it — mixing "translucent" with insets-based
            padding was fragile and let header text render up under the
            status bar on some devices. iOS already needs insets regardless
            of this setting, so it's unaffected there. */}
        <StatusBar style="dark" />
        <ThemedAlertHost />
        <NavigationContainer ref={navigationRef}>
          <AppStateContext.Provider value={appStateValue}>
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              <Stack.Screen name="Splash">
                {({ navigation }) => (
                  <SplashRoute navigation={navigation} setEmployee={setEmployee} fetchTodayState={fetchTodayState} />
                )}
              </Stack.Screen>

              <Stack.Screen name="Login">
                {({ navigation }) => (
                  <LoginScreen
                    navigation={navigation}
                    onLoginSuccess={async () => {
                      await handleLoginSuccess();
                      navigation.replace('MainTabs');
                    }}
                  />
                )}
              </Stack.Screen>

              <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />

              <Stack.Screen name="MainTabs" component={MainTabs} />

              <Stack.Screen name="DayLogin">
                {({ navigation }) => (
                  <DayLoginScreen
                    navigation={navigation}
                    onLogin={(data) => {
                      handleDayLogin(data);
                      navigation.navigate('MainTabs');
                    }}
                    onAlreadyLoggedIn={async () => {
                      // The local screen only rendered because dayStatus looked
                      // like 'not_logged_in' — a 409 here means the server's
                      // truth has since diverged (e.g. another device, or a
                      // queued offline login already synced). Resync from
                      // the server rather than leaving the rep stranded on a
                      // login screen with stale local state.
                      await fetchTodayState();
                      navigation.navigate('MainTabs');
                    }}
                  />
                )}
              </Stack.Screen>

              <Stack.Screen name="DealerLogin">
                {({ navigation }) => (
                  <DealerLoginScreen
                    navigation={navigation}
                    dealer={selectedDealer}
                    attendance={attendance}
                    onLogin={(data) => {
                      handleDealerLogin(data);
                      navigation.navigate('MainTabs');
                    }}
                  />
                )}
              </Stack.Screen>

              <Stack.Screen name="DealerLogout">
                {({ navigation }) => {
                  // Primary: match by dealer_id (both are integers from the API)
                  // Fallback: the most-recent open visit — handles edge cases where
                  // dealer_id was missing in state (e.g. app opened mid-session).
                  const activeVisit =
                    visits.find(v => v.dealer_id === selectedDealer?.id && !v.logout_time) ||
                    visits.find(v => !v.logout_time);
                  return (
                    <DealerLogoutScreen
                      navigation={navigation}
                      dealer={selectedDealer}
                      activeVisit={activeVisit}
                      onLogout={async (data) => {
                        await handleDealerLogout(data);
                        navigation.navigate('MainTabs');
                      }}
                    />
                  );
                }}
              </Stack.Screen>

              <Stack.Screen name="DayLogout">
                {({ navigation }) => (
                  <DayLogoutScreen
                    navigation={navigation}
                    attendance={attendance}
                    onLogout={(data) => {
                      handleDayLogout(data);
                      navigation.navigate('MainTabs');
                    }}
                  />
                )}
              </Stack.Screen>

              <Stack.Screen name="Notes" component={NotesScreen} />
              <Stack.Screen name="NoteEditor" component={NoteEditorScreen} />
              <Stack.Screen name="Reminders" component={RemindersScreen} />
              <Stack.Screen name="ReminderEditor" component={ReminderEditorScreen} />
              <Stack.Screen name="About" component={AboutScreen} />
            </Stack.Navigator>
          </AppStateContext.Provider>
        </NavigationContainer>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
