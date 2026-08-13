import React, { useState } from 'react';
import { User, Lock } from 'lucide-react';
import { apiClient } from '../api';
import { Button, TextField } from '../components';
import { colors, typography, spacing, shadows, radius } from '../theme';

// Served from web/public/winfomi-logo.png — Next.js wraps module-imported
// images in a StaticImageData object (for next/image), so a plain <img src>
// tag needs the public/ URL instead of the old Vite-style asset import.
const winfomiLogo = '/winfomi-logo.png';

export default function LoginPage({ onLoginSuccess, onForgotPassword }) {
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
      <div style={styles.blobOne} aria-hidden="true" />
      <div style={styles.blobTwo} aria-hidden="true" />
      <div style={styles.blobThree} aria-hidden="true" />
      <div style={styles.glassOverlay} aria-hidden="true" />

      <div style={styles.card} className="ft-fade-in ft-login-split">
        <div style={styles.leftPanel} className="ft-login-left">
          <div style={styles.facetLight} aria-hidden="true" />
          <div style={styles.facetBand} aria-hidden="true" />
          <div style={styles.facetEdge} aria-hidden="true" />
          <div style={styles.facetDark} aria-hidden="true" />
          <div style={styles.leftVignette} aria-hidden="true" />
          <div style={styles.leftContent}>
            <div style={styles.logoChip}>
              <img src={winfomiLogo} alt="Winfomi" style={styles.logoImg} />
            </div>
            <p style={styles.brandTitle}>Field Sales App</p>
            <p style={styles.brandSubtitle}>Track visits, dealers, and your field team — all in one place.</p>
          </div>
        </div>

        <div style={styles.rightPanel} className="ft-login-right">
          <h1 style={styles.welcomeTitle}>Welcome!</h1>
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

            <button type="button" onClick={onForgotPassword} style={styles.forgotPasswordLink}>
              Forgot password?
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    position: 'relative', overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'center',
    minHeight: '100vh', background: '#EFFDF4', padding: spacing.xl, boxSizing: 'border-box',
  },
  blobOne: {
    position: 'absolute', top: '-18%', left: '-12%', width: 480, height: 480, borderRadius: '50%',
    background: 'rgba(34,197,94,0.55)', filter: 'blur(90px)', pointerEvents: 'none',
  },
  blobTwo: {
    position: 'absolute', bottom: '-22%', right: '-12%', width: 520, height: 520, borderRadius: '50%',
    background: 'rgba(74,222,128,0.5)', filter: 'blur(100px)', pointerEvents: 'none',
  },
  blobThree: {
    position: 'absolute', top: '30%', right: '15%', width: 320, height: 320, borderRadius: '50%',
    background: 'rgba(134,239,172,0.45)', filter: 'blur(80px)', pointerEvents: 'none',
  },
  glassOverlay: {
    position: 'absolute', inset: 0,
    background: 'rgba(255,255,255,0.12)',
    backdropFilter: 'blur(40px)',
    WebkitBackdropFilter: 'blur(40px)',
    pointerEvents: 'none',
  },

  card: {
    position: 'relative', backgroundColor: colors.card, borderRadius: radius.card, boxShadow: shadows.dropdown,
    width: '100%', maxWidth: 860, minHeight: 480, boxSizing: 'border-box', overflow: 'hidden',
  },

  leftPanel: {
    position: 'relative', overflow: 'hidden',
    backgroundColor: '#22C55E',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: spacing.xxl, boxSizing: 'border-box',
  },
  // Structured geometric "folded facet" 3D treatment — a light facet top-left,
  // a dark facet bottom-right (like folded paper/isometric planes), a thin
  // bright seam marking the fold line, plus an inner vignette for depth.
  facetLight: {
    position: 'absolute', inset: 0,
    clipPath: 'polygon(0 0, 62% 0, 0 48%)',
    background: 'linear-gradient(135deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0.08) 100%)',
    pointerEvents: 'none',
  },
  facetDark: {
    position: 'absolute', inset: 0,
    clipPath: 'polygon(100% 32%, 100% 100%, 22% 100%)',
    background: 'linear-gradient(315deg, #146B41 0%, #15803D 60%, #1C9A4C 100%)',
    pointerEvents: 'none',
  },
  facetEdge: {
    position: 'absolute', inset: 0,
    clipPath: 'polygon(100% 30.5%, 100% 33.5%, 23.5% 101%, 20.5% 99%)',
    background: 'rgba(255,255,255,0.55)',
    pointerEvents: 'none',
  },
  facetBand: {
    position: 'absolute', inset: 0,
    clipPath: 'polygon(0 62%, 100% 38%, 100% 46%, 0 70%)',
    background: 'rgba(255,255,255,0.10)',
    pointerEvents: 'none',
  },
  leftVignette: {
    position: 'absolute', inset: 0,
    boxShadow: 'inset 0 0 100px rgba(0,0,0,0.20)',
    pointerEvents: 'none',
  },
  leftContent: { position: 'relative', textAlign: 'center', maxWidth: 280 },
  logoChip: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: radius.card,
    padding: '14px 24px',
    boxShadow: '0 14px 30px rgba(0,0,0,0.30)',
    marginBottom: spacing.xl,
  },
  logoImg: { height: 34, width: 'auto', display: 'block' },
  brandTitle: { ...typography.sectionTitle, color: '#FFFFFF', fontSize: 22, margin: 0, textShadow: '0 2px 6px rgba(0,0,0,0.25)' },
  brandSubtitle: { ...typography.body, color: 'rgba(255,255,255,0.9)', marginTop: spacing.sm, lineHeight: 1.5, textShadow: '0 1px 4px rgba(0,0,0,0.2)' },

  rightPanel: {
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
    padding: '48px 44px', boxSizing: 'border-box',
  },
  welcomeTitle: { ...typography.dashboardTitle, color: colors.text, margin: 0 },
  subtitle: { ...typography.body, color: colors.textSecondary, margin: `${spacing.sm}px 0 ${spacing.xxl}px` },
  errorText: { ...typography.caption, color: colors.danger, margin: `0 0 ${spacing.lg}px`, textAlign: 'left' },
  forgotPasswordLink: {
    display: 'block', width: '100%', textAlign: 'center', marginTop: spacing.lg,
    background: 'none', border: 'none', color: colors.primary, fontWeight: 600,
    fontSize: 13, cursor: 'pointer', padding: 0,
  },
};
