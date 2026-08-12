import React, { useState } from 'react';
import { User, Phone, Lock } from 'lucide-react';
import { apiClient } from '../api';
import { Button, TextField } from '../components';
import { colors, typography, spacing, shadows, radius } from '../theme';

const winfomiLogo = '/winfomi-logo.png';
const MIN_PASSWORD_LENGTH = 6;

/**
 * Self-service password reset for the manager dashboard — proves ownership
 * of the account with username + the phone number already on file (no
 * current password, no SMS/email infra) instead of a current password.
 */
export default function ForgotPasswordPage({ onBackToLogin }) {
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      await apiClient.post('/auth/forgot-password', {
        username,
        phone,
        new_password: newPassword,
      });
      setSuccess(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reset password. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.blobOne} aria-hidden="true" />
      <div style={styles.blobTwo} aria-hidden="true" />
      <div style={styles.card} className="ft-fade-in">
        <div style={styles.logoWrap}>
          <img src={winfomiLogo} alt="Winfomi" style={styles.logoImg} />
        </div>

        {success ? (
          <>
            <p style={styles.subtitle}>Your password has been updated. You can now sign in.</p>
            <Button onClick={onBackToLogin} style={{ width: '100%', height: 46 }}>
              Back to sign in
            </Button>
          </>
        ) : (
          <>
            <p style={styles.subtitle}>
              Enter your username and the phone number on file for your account to set a new password.
            </p>

            <form onSubmit={handleSubmit}>
              <TextField
                label="Username"
                value={username}
                onChange={setUsername}
                placeholder="your.username"
                icon={<User size={16} color={colors.textMuted} />}
                required
                style={{ marginBottom: spacing.lg }}
              />
              <TextField
                label="Registered phone number"
                value={phone}
                onChange={setPhone}
                placeholder="Your phone number"
                icon={<Phone size={16} color={colors.textMuted} />}
                required
                style={{ marginBottom: spacing.lg }}
              />
              <TextField
                label="New password"
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                icon={<Lock size={16} color={colors.textMuted} />}
                required
                minLength={MIN_PASSWORD_LENGTH}
                style={{ marginBottom: spacing.lg }}
              />
              <TextField
                label="Retype new password"
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder="Retype your new password"
                icon={<Lock size={16} color={colors.textMuted} />}
                required
                minLength={MIN_PASSWORD_LENGTH}
                style={{ marginBottom: spacing.lg }}
              />

              {error && <p style={styles.errorText}>{error}</p>}

              <Button type="submit" loading={loading} style={{ width: '100%', height: 46, marginBottom: spacing.md }}>
                Reset password
              </Button>
              <Button type="button" variant="secondary" onClick={onBackToLogin} style={{ width: '100%', height: 46 }}>
                Back to sign in
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    position: 'relative', overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'center',
    minHeight: '100vh', background: colors.gradientHero, padding: spacing.xl, boxSizing: 'border-box',
  },
  blobOne: {
    position: 'absolute', top: '-15%', left: '-10%', width: 420, height: 420, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 70%)', pointerEvents: 'none',
  },
  blobTwo: {
    position: 'absolute', bottom: '-20%', right: '-10%', width: 480, height: 480, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 70%)', pointerEvents: 'none',
  },
  card: {
    position: 'relative', backgroundColor: colors.card, borderRadius: radius.card, boxShadow: shadows.dropdown,
    width: '100%', maxWidth: 400, padding: '40px 32px', boxSizing: 'border-box',
  },
  logoWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: spacing.xl },
  logoImg: { height: 40, width: 'auto' },
  subtitle: { ...typography.body, color: colors.textSecondary, textAlign: 'center', margin: `${spacing.sm}px 0 ${spacing.xxl}px` },
  errorText: { ...typography.caption, color: colors.danger, margin: `0 0 ${spacing.lg}px`, textAlign: 'left' },
};
