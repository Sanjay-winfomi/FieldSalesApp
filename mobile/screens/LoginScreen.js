import React, { useRef, useState } from 'react';
import { StyleSheet, Text, View, KeyboardAvoidingView, ScrollView, Platform, Image, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { User, Lock, Eye, EyeOff } from 'lucide-react-native';
import * as SecureStore from 'expo-secure-store';
import { api } from '../src/services/api';
import { showAlert } from '../src/services/themedAlert';
import { PrimaryButton, TextField, FadeSlideIn } from '../src/components';
import { colors, spacing, typography, radius } from '../src/theme';

const winfomiLogo = require('../assets/brand/winfomi-logo.png');

// After this long waiting on a login response, it's more likely the free-tier
// backend is waking from an idle sleep than that something is actually stuck
// — surfacing that explains the delay instead of leaving a bare spinner that
// looks identical to a hang.
const COLD_START_HINT_DELAY_MS = 4000;

export default function LoginScreen({ onLoginSuccess, navigation }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showColdStartHint, setShowColdStartHint] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const insets = useSafeAreaInsets();
  const coldStartTimerRef = useRef(null);

  const handleLogin = async () => {
    if (!username || !password) {
      showAlert('Error', 'Please enter both username and password.');
      return;
    }

    setLoading(true);
    coldStartTimerRef.current = setTimeout(() => setShowColdStartHint(true), COLD_START_HINT_DELAY_MS);
    try {
      const response = await api.post('/auth/login', { username, password });

      const { accessToken, refreshToken, employee } = response.data;

      // Store tokens securely, store display metadata in normal AsyncStorage
      await SecureStore.setItemAsync('accessToken', accessToken);
      await SecureStore.setItemAsync('refreshToken', refreshToken);
      await AsyncStorage.setItem('employeeData', JSON.stringify(employee));

      if (onLoginSuccess) onLoginSuccess();
    } catch (error) {
      console.error('Login error:', error);
      showAlert(
        'Login Failed',
        error.response?.data?.error || 'Could not connect to the server. Please try again later.'
      );
    } finally {
      clearTimeout(coldStartTimerRef.current);
      setShowColdStartHint(false);
      setLoading(false);
    }
  };

  return (
    <LinearGradient colors={colors.gradientHeader} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.container}>
    <KeyboardAvoidingView
      style={styles.keyboardView}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.blobOne} pointerEvents="none" />
      <View style={styles.blobTwo} pointerEvents="none" />
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <FadeSlideIn>
          <View style={styles.logoPlate}>
            <Image source={winfomiLogo} style={styles.logoImg} resizeMode="contain" />
          </View>

          <View style={styles.card}>
            <Text style={styles.heading}>Log in</Text>
            <Text style={styles.subheading}>Enter your credentials to continue</Text>

            <TextField
              label="Username"
              value={username}
              onChangeText={setUsername}
              placeholder="Enter your username"
              autoCapitalize="none"
              icon={<User size={18} color={colors.textMuted} />}
              style={styles.field}
            />

            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="Enter your password"
              autoCapitalize="none"
              secureTextEntry={!showPassword}
              icon={<Lock size={18} color={colors.textMuted} />}
              rightAccessory={
                <View
                  onTouchEnd={() => setShowPassword((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
                    <EyeOff size={20} color={colors.textMuted} />
                  ) : (
                    <Eye size={20} color={colors.textMuted} />
                  )}
                </View>
              }
              style={styles.field}
            />

            <PrimaryButton
              title="Log in"
              onPress={handleLogin}
              loading={loading}
              style={styles.submitButton}
            />

            <Pressable
              onPress={() => navigation.navigate('ForgotPassword')}
              accessibilityRole="button"
              style={styles.forgotPasswordLink}
            >
              <Text style={styles.forgotPasswordText}>Forgot password?</Text>
            </Pressable>

            {showColdStartHint && (
              <Text style={styles.coldStartHint}>
                Starting server... This may take up to a minute on the first request.
              </Text>
            )}

            <Text style={styles.helperText}>
              Field representatives and managers use the same login screen; role decides where you land.
            </Text>
          </View>
        </FadeSlideIn>
      </ScrollView>
    </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  blobOne: {
    position: 'absolute', top: -60, left: -50, width: 220, height: 220, borderRadius: 110,
    backgroundColor: 'rgba(34,197,94,0.12)',
  },
  blobTwo: {
    position: 'absolute', bottom: -80, right: -60, width: 260, height: 260, borderRadius: 130,
    backgroundColor: 'rgba(34,197,94,0.16)',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.screenHorizontal,
  },
  logoPlate: {
    alignSelf: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: radius.card,
    paddingHorizontal: 24,
    paddingVertical: 14,
    marginBottom: spacing.xxl,
  },
  logoImg: {
    width: 140,
    height: 40,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: 20,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.20,
    shadowRadius: 24,
    elevation: 8,
  },
  heading: {
    ...typography.pageTitle,
    fontSize: 24,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  subheading: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.xxl,
  },
  field: {
    marginBottom: spacing.lg,
  },
  submitButton: {
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  forgotPasswordLink: {
    alignSelf: 'center',
    marginBottom: spacing.lg,
  },
  forgotPasswordText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  coldStartHint: {
    ...typography.caption,
    color: colors.primary,
    textAlign: 'center',
    marginTop: -spacing.sm,
    marginBottom: spacing.lg,
  },
  helperText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
});
