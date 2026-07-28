import React, { useState } from 'react';
import { StyleSheet, Text, View, Alert, KeyboardAvoidingView, ScrollView, Platform, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { User, Lock, Eye, EyeOff } from 'lucide-react-native';
import * as SecureStore from 'expo-secure-store';
import { api } from '../src/services/api';
import { PrimaryButton, TextField, FadeSlideIn } from '../src/components';
import { colors, spacing, typography } from '../src/theme';

const winfomiLogo = require('../assets/brand/winfomi-logo.png');

export default function LoginScreen({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const insets = useSafeAreaInsets();

  const handleLogin = async () => {
    if (!username || !password) {
      Alert.alert('Error', 'Please enter both username and password.');
      return;
    }

    setLoading(true);
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
      Alert.alert(
        'Login Failed',
        error.response?.data?.error || 'Could not connect to the server. Please try again later.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <FadeSlideIn>
          <Image source={winfomiLogo} style={styles.logoImg} resizeMode="contain" />

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

            <Text style={styles.helperText}>
              Field representatives and managers use the same login screen; role decides where you land.
            </Text>
          </View>
        </FadeSlideIn>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.screenHorizontal,
  },
  logoImg: {
    width: 140,
    height: 40,
    alignSelf: 'center',
    marginBottom: spacing.xxl,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
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
  helperText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
});
