import React, { useState } from 'react';
import { User, Lock } from 'lucide-react';
import { apiClient } from '../api';
import { Button, TextField } from '../components';
import { colors, typography, spacing, shadows } from '../theme';

export default function LoginPage({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiClient.post('/auth/login', { username, password });
      const { accessToken, employee } = res.data;
      if (employee.role !== 'manager') {
        setError('Only managers can access the web dashboard.');
        return;
      }
      onLoginSuccess(accessToken, employee);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Check credentials and that the backend is running.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card} className="ft-fade-in">
        <div style={styles.logoWrap}>
          <div style={styles.logoMark}>
            <div style={styles.logoRow}>
              <div style={{ ...styles.logoBlock, backgroundColor: colors.success }} />
              <div style={{ ...styles.logoBlock, backgroundColor: colors.warning }} />
            </div>
            <div style={styles.logoRow}>
              <div style={{ ...styles.logoBlock, backgroundColor: colors.primary }} />
              <div style={{ ...styles.logoBlock, backgroundColor: colors.text }} />
            </div>
          </div>
          <h1 style={styles.title}>FieldTrack</h1>
        </div>
        <p style={styles.subtitle}>Manager dashboard — sign in to continue</p>

        <form onSubmit={handleLogin}>
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
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
            icon={<Lock size={16} color={colors.textMuted} />}
            required
            style={{ marginBottom: spacing.lg }}
          />

          {error && <p style={styles.errorText}>{error}</p>}

          <Button type="submit" loading={loading} style={{ width: '100%', height: 46 }}>
            Sign in
          </Button>
        </form>

        {import.meta.env.DEV && (
          <p style={styles.hint}>
            Default credentials (dev only): <code>manager / manager123</code>
          </p>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh',
    backgroundColor: colors.background, padding: spacing.xl, boxSizing: 'border-box',
  },
  card: {
    backgroundColor: colors.card, borderRadius: 18, boxShadow: shadows.raised, width: '100%', maxWidth: 400,
    padding: '40px 32px', boxSizing: 'border-box', border: `1px solid ${colors.border}`,
  },
  logoWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: spacing.xl },
  logoMark: { width: 48, height: 48, borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', marginBottom: spacing.lg },
  logoRow: { display: 'flex', flex: 1 },
  logoBlock: { flex: 1 },
  title: { ...typography.sectionTitle, color: colors.text, margin: 0 },
  subtitle: { ...typography.body, color: colors.textSecondary, textAlign: 'center', margin: `${spacing.sm}px 0 ${spacing.xxl}px` },
  errorText: { ...typography.caption, color: colors.danger, margin: `0 0 ${spacing.lg}px`, textAlign: 'left' },
  hint: { ...typography.caption, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xxl, marginBottom: 0 },
};
