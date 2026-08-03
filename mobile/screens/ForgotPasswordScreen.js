import React, { useState } from 'react';
import { StyleSheet, Text, View, Alert, KeyboardAvoidingView, ScrollView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { User, Phone, Lock, Eye, EyeOff } from 'lucide-react-native';
import { api } from '../src/services/api';
import { AppHeader, PrimaryButton, TextField, FadeSlideIn } from '../src/components';
import { colors, spacing, typography } from '../src/theme';

const MIN_PASSWORD_LENGTH = 6;

/**
 * Self-service password reset — a rep/manager proves ownership of the
 * account with their username + the phone number already on file (no
 * current password needed, no SMS/email infra required) and sets a new
 * password directly. Reachable from the login screen pre-auth.
 */
export default function ForgotPasswordScreen({ navigation }) {
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const insets = useSafeAreaInsets();

  const handleSubmit = async () => {
    if (!username || !phone || !newPassword || !confirmPassword) {
      Alert.alert('Missing information', 'Please fill in every field.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      Alert.alert('Password too short', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert("Passwords don't match", 'Re-type the same password in both fields.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/forgot-password', {
        username,
        phone,
        new_password: newPassword,
      });
      Alert.alert('Password updated', 'You can now log in with your new password.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (error) {
      console.error('Forgot password error:', error);
      Alert.alert(
        'Could not reset password',
        error.response?.data?.error || 'Could not connect to the server. Please try again later.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AppHeader title="Reset password" onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <FadeSlideIn>
          <View style={styles.card}>
            <Text style={styles.subheading}>
              Enter your username and the phone number on file for your account to set a new password.
            </Text>

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
              label="Registered phone number"
              value={phone}
              onChangeText={setPhone}
              placeholder="Enter your phone number"
              keyboardType="phone-pad"
              icon={<Phone size={18} color={colors.textMuted} />}
              style={styles.field}
            />

            <TextField
              label="New password"
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              autoCapitalize="none"
              secureTextEntry={!showPassword}
              icon={<Lock size={18} color={colors.textMuted} />}
              rightAccessory={
                <View
                  onTouchEnd={() => setShowPassword((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={20} color={colors.textMuted} /> : <Eye size={20} color={colors.textMuted} />}
                </View>
              }
              style={styles.field}
            />

            <TextField
              label="Retype new password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Retype your new password"
              autoCapitalize="none"
              secureTextEntry={!showPassword}
              icon={<Lock size={18} color={colors.textMuted} />}
              style={styles.field}
            />

            <PrimaryButton
              title="Reset password"
              onPress={handleSubmit}
              loading={loading}
              style={styles.submitButton}
            />
          </View>
        </FadeSlideIn>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1, padding: spacing.screenHorizontal },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.lg,
  },
  subheading: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.xl },
  field: { marginBottom: spacing.lg },
  submitButton: { marginTop: spacing.sm },
});
