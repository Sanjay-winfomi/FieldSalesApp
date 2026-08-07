import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, User, BarChart3, Settings, Menu, X, LogOut, ChevronDown, LayoutDashboard, Bell } from 'lucide-react';
import { colors, typography, spacing, shadows } from '../../theme';

// Served from web/public/winfomi-logo.png — see LoginPage.jsx for why this
// is a plain path string rather than a module import under Next.js.
const winfomiLogo = '/winfomi-logo.png';

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'admin', label: 'Admin', icon: Settings },
];

function initials(name) {
  if (!name) return 'M';
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

/**
 * Sticky top navigation — logo/app name, primary nav with an active
 * indicator, a manager profile menu (name, region, logout), and last-sync
 * time. Collapses the nav links behind a hamburger below ~860px.
 */
export default function AppHeader({ activeView, onNavigate, manager, lastUpdated, loading, onRefresh, onLogout, unreadNotifications = 0, onOpenNotifications }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef(null);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <header style={styles.header} className="ft-topbar">
      <div style={styles.inner}>
        <div style={styles.logoSection}>
          <img src={winfomiLogo} alt="Winfomi" style={styles.logoImg} />

          <button
            className="ft-hamburger-btn ft-icon-btn"
            style={styles.hamburgerBtn}
            onClick={() => setMobileNavOpen((v) => !v)}
            aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileNavOpen}
          >
            {mobileNavOpen ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>

        <nav style={styles.navRow} className={`ft-navrow ${mobileNavOpen ? 'ft-navrow-open' : ''}`} aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const active = activeView === item.key;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className={`ft-nav-link ${active ? 'ft-nav-link-active' : ''}`}
                style={{ ...styles.navBtn, color: active ? colors.primary : colors.textSecondary, fontWeight: active ? 700 : 600 }}
                onClick={() => { onNavigate(item.key); setMobileNavOpen(false); }}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={15} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div style={styles.rightSection} className="ft-topbar-right">
          {onOpenNotifications && (
            <button
              type="button"
              className="ft-icon-btn"
              style={styles.bellBtn}
              onClick={onOpenNotifications}
              title="Notifications"
              aria-label={unreadNotifications > 0 ? `Notifications, ${unreadNotifications} unread` : 'Notifications'}
            >
              <Bell size={17} color={colors.textSecondary} />
              {unreadNotifications > 0 && (
                <span style={styles.bellBadge}>{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>
              )}
            </button>
          )}

          <button
            type="button"
            className="ft-icon-btn"
            style={styles.syncPill}
            onClick={onRefresh}
            title="Refresh dashboard data"
            aria-label="Refresh dashboard data"
          >
            <RefreshCw size={13} className={loading ? 'ft-spin' : ''} />
            <span className="ft-manager-badge-text">
              {lastUpdated ? `Synced ${lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Sync'}
            </span>
          </button>

          <div ref={profileRef} style={{ position: 'relative' }}>
            <button
              type="button"
              style={styles.profileBtn}
              onClick={() => setProfileOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={profileOpen}
            >
              <div style={styles.avatar}>{initials(manager?.name)}</div>
              <span className="ft-manager-badge-text" style={styles.profileName}>{manager?.name || 'Manager'}</span>
              <ChevronDown size={14} color={colors.textMuted} />
            </button>

            {profileOpen && (
              <div style={styles.profileMenu} className="ft-scale-in" role="menu">
                <div style={styles.profileMenuHeader}>
                  <div style={styles.profileMenuName}>{manager?.name || 'Manager'}</div>
                  <div style={styles.profileMenuMeta}>{manager?.region || 'All regions'}</div>
                </div>
                <button type="button" style={styles.profileMenuItem} onClick={() => { setProfileOpen(false); onLogout(); }} role="menuitem">
                  <LogOut size={15} color={colors.danger} />
                  <span style={{ color: colors.danger }}>Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

const styles = {
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 100,
    backgroundColor: colors.card,
    borderBottom: `1px solid ${colors.border}`,
    boxShadow: shadows.card,
  },
  inner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 64,
    padding: `0 ${spacing.xxl}px`,
    maxWidth: 1920,
    margin: '0 auto',
    width: '100%',
    position: 'relative',
  },
  logoSection: { display: 'flex', alignItems: 'center', gap: spacing.md },
  logoImg: { height: 28, width: 'auto', display: 'block' },
  hamburgerBtn: { width: 36, height: 36, marginLeft: spacing.sm },
  navRow: { gap: 4 },
  navBtn: {
    display: 'flex', alignItems: 'center', gap: 7, height: 40, padding: '0 16px', borderRadius: 8,
    border: 'none', backgroundColor: 'transparent', fontSize: 14,
  },
  rightSection: { display: 'flex', alignItems: 'center', gap: spacing.md },
  syncPill: {
    display: 'flex', alignItems: 'center', gap: 7, height: 36, padding: '0 14px', borderRadius: 999,
    fontSize: 12, fontWeight: 600, color: colors.textSecondary,
  },
  bellBtn: {
    position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 36, height: 36, borderRadius: 999,
  },
  bellBadge: {
    position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: colors.danger, color: '#FFFFFF', fontSize: 10, fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
    lineHeight: 1, border: `1.5px solid ${colors.card}`,
  },
  profileBtn: {
    display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 6px 0 6px', borderRadius: 10,
    border: `1px solid ${colors.border}`, backgroundColor: colors.card,
  },
  avatar: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary, color: '#FFFFFF',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0,
  },
  profileName: { ...typography.body, fontSize: 13, fontWeight: 600, color: colors.text },
  profileMenu: {
    position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 220, backgroundColor: colors.card,
    border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: shadows.dropdown, overflow: 'hidden', zIndex: 200,
  },
  profileMenuHeader: { padding: '14px 16px', borderBottom: `1px solid ${colors.border}` },
  profileMenuName: { ...typography.bodyMedium, color: colors.text },
  profileMenuMeta: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  profileMenuItem: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 16px', border: 'none',
    backgroundColor: 'transparent', fontSize: 13, fontWeight: 600, textAlign: 'left',
  },
};
