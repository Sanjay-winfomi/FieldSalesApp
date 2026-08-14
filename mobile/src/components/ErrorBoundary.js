import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import * as Updates from 'expo-updates';
import PrimaryButton from './buttons/PrimaryButton';
import { captureException } from '../services/crashReporter';
import { colors, typography, spacing } from '../theme';

/**
 * Wraps the navigation root (App.js) so a thrown render/lifecycle error
 * shows this friendly screen instead of a blank/frozen frame or the default
 * red-box-then-crash behavior a release build falls back to. This only
 * catches errors from React's render tree (render/lifecycle) — NOT errors
 * from event handlers, promises, or native code; those are handled
 * separately by index.js's `global.ErrorUtils.setGlobalHandler`, and
 * AppState/background-task callbacks' own try/catch blocks (App.js,
 * geofenceTask.js, assignedDealerGeofence.js, visitMonitor.js).
 */
export default class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Caught by ErrorBoundary:', error, info?.componentStack);
    captureException(error, { area: 'error-boundary', componentStack: info?.componentStack });
  }

  handleRestart = async () => {
    try {
      // A real app reload (not just clearing local state) so anything left
      // in a broken in-memory state (navigation, contexts, native module
      // bindings) gets a clean start — expo-updates makes this available
      // without needing a fresh install.
      await Updates.reloadAsync();
    } catch (err) {
      // Updates.reloadAsync() isn't available in Expo Go / a dev client —
      // fall back to just clearing the boundary so children re-mount.
      this.setState({ error: null });
    }
  };

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>
            The app hit an unexpected error. Your data is safe — tap below to restart.
          </Text>
          <PrimaryButton title="Restart app" onPress={this.handleRestart} style={styles.button} />
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    backgroundColor: colors.background,
  },
  title: { ...typography.sectionTitle, color: colors.text, marginBottom: spacing.md, textAlign: 'center' },
  message: { ...typography.body, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl },
  button: { maxWidth: 240 },
});
