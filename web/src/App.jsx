'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { apiClient, setAuthToken, setSessionExpiredHandler } from './api';
import AppHeader from './components/headers/AppHeader';
import LoginPage from './views/LoginPage';
import ForgotPasswordPage from './views/ForgotPasswordPage';
import RepDetailsPage from './views/RepDetailsPage';
import DashboardPage from './views/DashboardPage';
import ReportsPage from './views/ReportsPage';
import AdminPage from './views/AdminPage';
import NotificationsPage from './views/NotificationsPage';
import { colors } from './theme';
import './App.css';

export default function App() {
  // Next.js server-renders this Client Component's first pass (there's no
  // sessionStorage there), so these initializers must no-op on the server —
  // the real value gets picked up on the client re-render, same as before.
  const [token, setToken] = useState(() => (typeof window === 'undefined' ? '' : sessionStorage.getItem('ft_token') || ''));
  const [manager, setManager] = useState(() => {
    if (typeof window === 'undefined') return null;
    try { return JSON.parse(sessionStorage.getItem('ft_manager') || 'null'); } catch { return null; }
  });

  const [reps, setReps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState('');
  const [selectedRepId, setSelectedRepId] = useState(null);
  const [activeView, setActiveView] = useState('dashboard'); // 'dashboard' | 'reports' | 'admin' | 'notifications'
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  // Keep the shared apiClient's auth header in sync — every page's request
  // goes through apiClient's own interceptor, which always wins over any
  // manually-set Authorization header on an individual call.
  useEffect(() => {
    setAuthToken(token || null);
  }, [token]);

  const fetchDashboard = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get('/dashboard/today');
      setReps(res.data.reps || []);
      setLastUpdated(new Date());
    } catch (err) {
      if (err.response?.status === 401) {
        handleLogout();
      } else {
        setError(err.response?.data?.error || 'Failed to load dashboard data.');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchDashboard();
      const interval = setInterval(fetchDashboard, 30000);
      return () => clearInterval(interval);
    }
  }, [token, fetchDashboard]);

  const fetchUnreadNotifications = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apiClient.get('/notifications/unread-count');
      setUnreadNotifications(res.data.count || 0);
    } catch {
      // Non-fatal — the bell just won't show a fresh count until the next poll.
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchUnreadNotifications();
      const interval = setInterval(fetchUnreadNotifications, 30000);
      return () => clearInterval(interval);
    }
  }, [token, fetchUnreadNotifications]);

  const handleLoginSuccess = (accessToken, employee) => {
    sessionStorage.setItem('ft_token', accessToken);
    sessionStorage.setItem('ft_manager', JSON.stringify(employee));
    setToken(accessToken);
    setManager(employee);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('ft_token');
    sessionStorage.removeItem('ft_manager');
    setToken('');
    setManager(null);
    setReps([]);
    setSelectedRepId(null);
  };

  // Global 401 handling — without this, a token expiring while on Reports,
  // Admin, or a Rep Details page just showed a generic "failed to load"
  // error forever, since only the dashboard's own fetch had a 401 check.
  useEffect(() => {
    setSessionExpiredHandler(handleLogout);
    return () => setSessionExpiredHandler(null);
  }, []);

  if (!token) {
    if (showForgotPassword) {
      return <ForgotPasswordPage onBackToLogin={() => setShowForgotPassword(false)} />;
    }
    return <LoginPage onLoginSuccess={handleLoginSuccess} onForgotPassword={() => setShowForgotPassword(true)} />;
  }

  if (selectedRepId) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: colors.background }}>
        <AppHeader
          activeView={activeView}
          onNavigate={(view) => { setActiveView(view); setSelectedRepId(null); }}
          manager={manager}
          lastUpdated={lastUpdated}
          loading={loading}
          onRefresh={fetchDashboard}
          onLogout={handleLogout}
          unreadNotifications={unreadNotifications}
          onOpenNotifications={() => { setActiveView('notifications'); setSelectedRepId(null); }}
        />
        <RepDetailsPage
          repId={selectedRepId}
          onBack={() => setSelectedRepId(null)}
        />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: colors.background }}>
      <AppHeader
        activeView={activeView}
        onNavigate={setActiveView}
        manager={manager}
        lastUpdated={lastUpdated}
        loading={loading}
        onRefresh={fetchDashboard}
        onLogout={handleLogout}
        unreadNotifications={unreadNotifications}
        onOpenNotifications={() => setActiveView('notifications')}
      />

      {activeView === 'dashboard' && (
        <DashboardPage
          reps={reps}
          loading={loading}
          error={error}
          onSelectRep={setSelectedRepId}
        />
      )}

      {activeView === 'reports' && <ReportsPage />}
      {activeView === 'admin' && <AdminPage currentEmployeeId={manager?.id} currentUsername={manager?.username} />}
      {activeView === 'notifications' && (
        <NotificationsPage onUnreadCountChange={setUnreadNotifications} onBack={() => setActiveView('dashboard')} />
      )}
    </div>
  );
}
