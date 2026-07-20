import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Search, Map, Check, LogOut, AlertTriangle, User, ArrowLeft, Calendar, Compass, Shield } from 'lucide-react';
import axios from 'axios';

const API_BASE = 'http://localhost:3001/api';
const apiClient = axios.create({ baseURL: API_BASE });

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs} hr ago`;
  return d.toLocaleDateString('en-IN');
}

function formatTimeOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

// ─── Login Page ──────────────────────────────────────────────────────────────
function LoginPage({ onLoginSuccess }) {
  const [username, setUsername] = useState('manager');
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
    <div style={loginStyles.page}>
      <div style={loginStyles.card}>
        <div style={loginStyles.logoWrap}>
          <div style={loginStyles.logoMark}>
            <div style={loginStyles.logoRow}>
              <div style={{ ...loginStyles.logoBlock, backgroundColor: '#4FD29F' }} />
              <div style={{ ...loginStyles.logoBlock, backgroundColor: '#E9C03C' }} />
            </div>
            <div style={loginStyles.logoRow}>
              <div style={{ ...loginStyles.logoBlock, backgroundColor: '#0082D1' }} />
              <div style={{ ...loginStyles.logoBlock, backgroundColor: '#434343' }} />
            </div>
          </div>
          <h1 style={loginStyles.title}>FieldTrack</h1>
        </div>
        <p style={loginStyles.subtitle}>Manager dashboard — sign in to continue</p>

        <form onSubmit={handleLogin}>
          <div style={loginStyles.field}>
            <label style={loginStyles.label}>Username</label>
            <input
              style={loginStyles.input}
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="your.username"
              required
            />
          </div>
          <div style={loginStyles.field}>
            <label style={loginStyles.label}>Password</label>
            <input
              style={loginStyles.input}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          {error && <p style={loginStyles.errorText}>{error}</p>}
          <button type="submit" style={loginStyles.btn} disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        <p style={loginStyles.hint}>
          Default credentials: <code>manager / manager123</code>
        </p>
      </div>
    </div>
  );
}

// ─── Representative Details Page ──────────────────────────────────────────────
function RepDetailsPage({ token, repId, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchDetails = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get(`/dashboard/rep/${repId}/today`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch details.');
    } finally {
      setLoading(false);
    }
  }, [repId, token]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>Loading details...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={styles.container}>
        <div style={styles.errorBanner}>{error || 'Representative details not found.'}</div>
        <button style={styles.backBtn} onClick={onBack}>
          <ArrowLeft size={16} style={{ marginRight: 6 }} /> Back to Dashboard
        </button>
      </div>
    );
  }

  const { employee, attendance, visits } = data;

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.topBar}>
        <div style={styles.logoSection}>
          <button style={styles.backBtn} onClick={onBack}>
            <ArrowLeft size={16} style={{ marginRight: 6 }} />
          </button>
          <h1 style={styles.appTitle}>{employee.name} — Today's Timeline</h1>
        </div>
        <div style={styles.managerBadge}>
          <span>Region: {employee.region || 'N/A'}</span>
        </div>
      </header>

      <main style={styles.detailsLayout}>
        {/* Left Column: Attendance Overview & Stats */}
        <section style={styles.detailsCard}>
          <h2 style={styles.sectionTitle}>Attendance Status</h2>
          {attendance ? (
            <div>
              <div style={styles.metaRow}>
                <div style={styles.metaCol}>
                  <span style={styles.metaLabel}>Check In Time</span>
                  <span style={styles.metaValue}>{formatTimeOnly(attendance.check_in_time)}</span>
                  <span style={styles.coordVal}>GPS: {attendance.check_in_lat?.toFixed(5)}, {attendance.check_in_lng?.toFixed(5)}</span>
                </div>
                <div style={styles.metaCol}>
                  <span style={styles.metaLabel}>Check Out Time</span>
                  <span style={styles.metaValue}>{formatTimeOnly(attendance.check_out_time)}</span>
                  {attendance.check_out_time && (
                    <span style={styles.coordVal}>GPS: {attendance.check_out_lat?.toFixed(5)}, {attendance.check_out_lng?.toFixed(5)}</span>
                  )}
                </div>
              </div>

              <div style={styles.metaDivider} />

              <div style={styles.metaRow}>
                <div style={styles.metaCol}>
                  <span style={styles.metaLabel}>Travelled</span>
                  <span style={styles.metaValue}>{parseFloat(attendance.total_distance_km || 0).toFixed(2)} km</span>
                </div>
                <div style={styles.metaCol}>
                  <span style={styles.metaLabel}>Work Duration</span>
                  <span style={styles.metaValue}>
                    {attendance.total_duration_minutes 
                      ? `${attendance.total_duration_minutes} mins` 
                      : 'Active'}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div style={styles.emptyState}>No attendance recorded for today.</div>
          )}
        </section>

        {/* Right Column: Visits Timeline */}
        <section style={styles.timelineCard}>
          <h2 style={styles.sectionTitle}>Visits Timeline ({visits.length})</h2>
          <div style={styles.timelineList}>
            {visits.length === 0 ? (
              <div style={styles.emptyState}>No dealer visits logged today.</div>
            ) : (
              visits.map((visit, index) => (
                <div key={visit.id} style={styles.timelineItem}>
                  <div style={styles.timelineIndicator}>
                    <div style={styles.timelineDot} />
                    {index !== visits.length - 1 && <div style={styles.timelineLine} />}
                  </div>
                  <div style={styles.timelineContent}>
                    <div style={styles.timelineHeader}>
                      <h4 style={styles.dealerName}>{visit.dealer_name}</h4>
                      <span style={styles.timelineTime}>
                        {formatTimeOnly(visit.check_in_time)} - {formatTimeOnly(visit.check_out_time)}
                      </span>
                    </div>
                    <p style={styles.dealerAddress}>{visit.dealer_address}</p>
                    
                    <div style={styles.visitStats}>
                      <span>⏱ {visit.visit_duration_minutes ? `${visit.visit_duration_minutes} min duration` : 'Active'}</span>
                      {visit.distance_from_previous_km > 0 && (
                        <span> · 🚗 {parseFloat(visit.distance_from_previous_km).toFixed(2)} km from prev point</span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

// ─── Dashboard Main App ───────────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('ft_token') || '');
  const [manager, setManager] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('ft_manager') || 'null'); } catch { return null; }
  });

  const [reps, setReps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRepId, setSelectedRepId] = useState(null);

  const fetchDashboard = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get('/dashboard/today', {
        headers: { Authorization: `Bearer ${token}` },
      });
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

  if (!token) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  if (selectedRepId) {
    return (
      <RepDetailsPage 
        token={token} 
        repId={selectedRepId} 
        onBack={() => setSelectedRepId(null)} 
      />
    );
  }

  const filteredReps = reps.filter(rep => {
    if (statusFilter !== 'All') {
      const statusMap = {
        'Checked in': 'checked_in',
        'Not checked in': 'not_checked_in',
        'Day ended': 'day_ended',
      };
      if (rep.status !== statusMap[statusFilter]) return false;
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return rep.name.toLowerCase().includes(q) || (rep.last_activity || '').toLowerCase().includes(q);
    }
    return true;
  });

  const stats = {
    checked_in: reps.filter(r => r.status === 'checked_in').length,
    not_checked_in: reps.filter(r => r.status === 'not_checked_in').length,
    day_ended: reps.filter(r => r.status === 'day_ended').length,
  };

  return (
    <div style={styles.container}>
      {/* Top Bar */}
      <header style={styles.topBar}>
        <div style={styles.logoSection}>
          <div style={styles.logoMark}>
            <div style={styles.logoRow}>
              <div style={{ ...styles.logoBlock, backgroundColor: '#4FD29F' }} />
              <div style={{ ...styles.logoBlock, backgroundColor: '#E9C03C' }} />
            </div>
            <div style={styles.logoRow}>
              <div style={{ ...styles.logoBlock, backgroundColor: '#0082D1' }} />
              <div style={{ ...styles.logoBlock, backgroundColor: '#434343' }} />
            </div>
          </div>
          <h1 style={styles.appTitle}>Field team — today</h1>
        </div>

        <div style={styles.topBarRight}>
          <div style={styles.managerBadge}>
            <User size={14} style={{ marginRight: 6 }} />
            <span>{manager?.name || 'Manager'}</span>
          </div>
          <div
            style={styles.liveBadge}
            onClick={fetchDashboard}
            role="button"
            title="Click to refresh"
          >
            <RefreshCw size={12} className={loading ? 'spin' : ''} style={{ marginRight: 6, strokeWidth: 2 }} />
            <span>
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                : 'Live'}
            </span>
          </div>
          <button style={styles.logoutBtn} onClick={handleLogout} title="Sign out">
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {/* Stats Row */}
      <section style={styles.statsRow}>
        <div style={{ ...styles.statPill, borderColor: '#4FD29F', color: '#1E6B4B', background: '#F4FBF8' }}>
          <Check size={14} style={{ marginRight: 6 }} />
          {stats.checked_in} checked in
        </div>
        <div style={{ ...styles.statPill, borderColor: '#E9C03C', color: '#8E6C0C', background: '#FDF3E0' }}>
          {stats.day_ended} day ended
        </div>
        <div style={{ ...styles.statPill, borderColor: '#D0D0D0', color: '#8A8A8A', background: '#FAFAFA' }}>
          {stats.not_checked_in} not checked in
        </div>
      </section>

      {/* Error Banner */}
      {error && (
        <div style={styles.errorBanner}>
          <AlertTriangle size={16} style={{ marginRight: 8 }} />
          {error}
        </div>
      )}

      {/* Filter Row */}
      <section style={styles.filterRow}>
        <div style={styles.selectWrapper}>
          <select
            style={styles.dropdown}
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="All">All statuses</option>
            <option value="Checked in">Checked in</option>
            <option value="Not checked in">Not checked in</option>
            <option value="Day ended">Day ended</option>
          </select>
        </div>

        <div style={styles.searchWrapper}>
          <Search size={16} style={styles.searchIcon} />
          <input
            type="text"
            style={styles.searchInput}
            placeholder="Search rep or activity"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </section>

      {/* Main Layout */}
      <main style={styles.mainLayout}>
        {/* Left — Rep List */}
        <section style={styles.leftColumn}>
          <div style={styles.columnHeader}>
            Field representatives ({filteredReps.length})
          </div>

          <div style={styles.repList}>
            {loading && reps.length === 0 ? (
              <div style={styles.emptyState}>Loading...</div>
            ) : filteredReps.length === 0 ? (
              <div style={styles.emptyState}>No reps matching the criteria</div>
            ) : (
              filteredReps.map(rep => {
                let borderColor = '#8A8A8A';
                let badgeText = 'Not checked in';
                let badgeBg = '#FAFAFA';
                let badgeBorder = '#D0D0D0';
                let badgeColor = '#8A8A8A';

                if (rep.status === 'checked_in') {
                  borderColor = '#4FD29F';
                  badgeText = 'Checked in';
                  badgeBg = '#F4FBF8';
                  badgeBorder = '#4FD29F';
                  badgeColor = '#1E6B4B';
                } else if (rep.status === 'day_ended') {
                  borderColor = '#E9C03C';
                  badgeText = 'Day ended';
                  badgeBg = '#FDF3E0';
                  badgeBorder = '#E9C03C';
                  badgeColor = '#8E6C0C';
                }

                return (
                  <div
                    key={rep.id}
                    style={{ ...styles.repCard, borderLeft: `4px solid ${borderColor}`, cursor: 'pointer' }}
                    onClick={() => setSelectedRepId(rep.id)}
                  >
                    <div style={styles.cardMain}>
                      <div style={{ flex: 1 }}>
                        <h3 style={styles.repName}>{rep.name}</h3>
                        <p style={styles.repActivity}>{rep.last_activity}</p>
                        <p style={styles.repDetail}>
                          {rep.visits_count} visit{rep.visits_count !== 1 ? 's' : ''} today
                          {rep.total_distance_km > 0 && ` · ${rep.total_distance_km.toFixed(1)} km`}
                          {rep.region && ` · ${rep.region}`}
                        </p>
                      </div>
                      <div style={styles.cardRight}>
                        <span style={{ ...styles.badge, background: badgeBg, border: `0.5px solid ${badgeBorder}`, color: badgeColor }}>
                          {badgeText}
                        </span>
                        <span style={styles.timestamp}>{formatTimestamp(rep.last_updated)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right — Map Placeholder */}
        <section style={styles.rightColumn}>
          <div style={styles.mapPanel}>
            <div style={styles.mapPinContainer}>
              <Map size={36} style={{ color: '#0082D1', strokeWidth: 1.5 }} />
            </div>
            <p style={styles.mapText}>Map view — most recent check-in pins for each rep</p>

            {/* Last known locations */}
            <div style={{ width: '100%', marginTop: 8 }}>
              {reps.filter(r => r.last_lat && r.last_lng).map(rep => (
                <div key={rep.id} style={styles.coordRow}>
                  <div style={{
                    ...styles.coordDot,
                    backgroundColor: rep.status === 'checked_in' ? '#4FD29F' : '#E9C03C',
                  }} />
                  <div>
                    <div style={styles.coordName}>{rep.name}</div>
                    <div style={styles.coordValue}>
                      {rep.last_lat.toFixed(4)}, {rep.last_lng.toFixed(4)}
                    </div>
                  </div>
                </div>
              ))}
              {reps.filter(r => r.last_lat && r.last_lng).length === 0 && (
                <p style={styles.mapText}>No location data yet.</p>
              )}
            </div>

            <div style={styles.mapLegend}>
              <div style={styles.legendItem}>
                <span style={{ ...styles.legendDot, backgroundColor: '#4FD29F' }} />
                <span>Checked in</span>
              </div>
              <div style={styles.legendItem}>
                <span style={{ ...styles.legendDot, backgroundColor: '#E9C03C' }} />
                <span>Checked out</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spin { animation: spin 0.8s linear infinite; }
        select, input { outline: none; }
        button { outline: none; cursor: pointer; }
      `}</style>
    </div>
  );
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', maxWidth: '1200px', margin: '0 auto', padding: '24px', width: '100%', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, backgroundColor: '#FFFFFF', padding: '14px 20px', borderRadius: '12px', border: '0.5px solid #E0E0E0' },
  logoSection: { display: 'flex', alignItems: 'center', gap: '12px' },
  logoMark: { width: 32, height: 32, borderRadius: '6px', overflow: 'hidden', display: 'flex', flexDirection: 'column', marginRight: 12 },
  logoRow: { display: 'flex', flex: 1 },
  logoBlock: { flex: 1 },
  appTitle: { fontSize: '20px', fontWeight: 500, color: '#434343' },
  topBarRight: { display: 'flex', alignItems: 'center', gap: '12px' },
  managerBadge: { display: 'flex', alignItems: 'center', fontSize: '13px', color: '#8A8A8A', padding: '6px 12px', backgroundColor: '#FAFAFA', borderRadius: '20px', border: '0.5px solid #E0E0E0' },
  liveBadge: { display: 'flex', alignItems: 'center', backgroundColor: '#F4FBF8', color: '#1E6B4B', padding: '6px 14px', borderRadius: '20px', border: '0.5px solid #4FD29F', fontSize: '12px', fontWeight: 500, cursor: 'pointer', userSelect: 'none' },
  logoutBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: '8px', border: '0.5px solid #D0D0D0', backgroundColor: '#FFFFFF', color: '#8A8A8A' },
  backBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '36px', padding: '0 12px', borderRadius: '8px', border: '0.5px solid #D0D0D0', backgroundColor: '#FFFFFF', color: '#8A8A8A', fontSize: '14px', cursor: 'pointer' },
  statsRow: { display: 'flex', gap: '12px', marginBottom: 20, flexWrap: 'wrap' },
  statPill: { display: 'flex', alignItems: 'center', fontSize: '13px', fontWeight: 500, padding: '8px 16px', borderRadius: '20px', border: '0.5px solid' },
  errorBanner: { display: 'flex', alignItems: 'center', backgroundColor: '#FBEAE9', color: '#D8534A', border: '0.5px solid #F5C2BF', borderRadius: '10px', padding: '12px 16px', marginBottom: 16, fontSize: '14px' },
  filterRow: { display: 'flex', gap: '16px', marginBottom: 24 },
  selectWrapper: { minWidth: '180px' },
  dropdown: { width: '100%', height: '40px', border: '0.5px solid #D0D0D0', borderRadius: '8px', padding: '0 12px', fontSize: '14px', color: '#434343', backgroundColor: '#FFFFFF', cursor: 'pointer' },
  searchWrapper: { flex: 1, position: 'relative', display: 'flex', alignItems: 'center' },
  searchIcon: { position: 'absolute', left: '14px', color: '#8A8A8A', pointerEvents: 'none' },
  searchInput: { width: '100%', height: '40px', border: '0.5px solid #D0D0D0', borderRadius: '8px', paddingLeft: '40px', paddingRight: '12px', fontSize: '14px', color: '#434343', backgroundColor: '#FFFFFF', boxSizing: 'border-box' },
  mainLayout: { display: 'grid', gridTemplateColumns: '1fr 320px', gap: '24px', alignItems: 'start' },
  detailsLayout: { display: 'grid', gridTemplateColumns: '350px 1fr', gap: '24px', alignItems: 'start', marginTop: '20px' },
  detailsCard: { backgroundColor: '#FFFFFF', borderRadius: '12px', border: '0.5px solid #E0E0E0', padding: '24px' },
  timelineCard: { backgroundColor: '#FFFFFF', borderRadius: '12px', border: '0.5px solid #E0E0E0', padding: '24px' },
  sectionTitle: { fontSize: '18px', fontWeight: 500, color: '#434343', marginBottom: '20px', borderBottom: '1px solid #E5E7EB', paddingBottom: '10px' },
  metaRow: { display: 'flex', gap: '16px', marginBottom: '16px' },
  metaCol: { flex: 1, display: 'flex', flexDirection: 'column' },
  metaLabel: { fontSize: '11px', color: '#8A8A8A', textTransform: 'uppercase', marginBottom: '4px' },
  metaValue: { fontSize: '15px', fontWeight: 500, color: '#434343' },
  coordVal: { fontSize: '11px', color: '#8A8A8A', fontFamily: 'monospace', marginTop: '2px' },
  metaDivider: { height: '1px', backgroundColor: '#E5E7EB', margin: '16px 0' },
  timelineList: { display: 'flex', flexDirection: 'column' },
  timelineItem: { display: 'flex', gap: '16px', position: 'relative' },
  timelineIndicator: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  timelineDot: { width: '12px', height: '12px', borderRadius: '6px', backgroundColor: '#0082D1', marginTop: '6px' },
  timelineLine: { width: '2px', flex: 1, backgroundColor: '#E5E7EB' },
  timelineContent: { flex: 1, paddingBottom: '24px' },
  timelineHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' },
  dealerName: { fontSize: '15px', fontWeight: 500, color: '#434343', margin: 0 },
  timelineTime: { fontSize: '12px', color: '#8A8A8A' },
  dealerAddress: { fontSize: '13px', color: '#8A8A8A', margin: '4px 0 8px' },
  visitStats: { display: 'flex', gap: '8px', fontSize: '12px', color: '#A0A0A0' },
  leftColumn: { display: 'flex', flexDirection: 'column' },
  columnHeader: { fontSize: '13px', fontWeight: 500, color: '#8A8A8A', marginBottom: 12 },
  repList: { display: 'flex', flexDirection: 'column', gap: '12px' },
  repCard: { backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '16px', border: '0.5px solid #E0E0E0', transition: 'box-shadow 0.2s' },
  cardMain: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  repName: { fontSize: '16px', fontWeight: 500, color: '#434343', margin: '0 0 4px' },
  repActivity: { fontSize: '14px', color: '#8A8A8A', margin: '0 0 4px' },
  repDetail: { fontSize: '12px', color: '#A0A0A0', margin: 0 },
  cardRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', marginLeft: 16 },
  badge: { fontSize: '11px', fontWeight: 500, padding: '4px 10px', borderRadius: '20px', whiteSpace: 'nowrap' },
  timestamp: { fontSize: '12px', color: '#A0A0A0' },
  emptyState: { backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '40px', textAlign: 'center', color: '#8A8A8A', border: '0.5px solid #E0E0E0' },
  rightColumn: { position: 'sticky', top: '24px' },
  mapPanel: { backgroundColor: '#F2F9FD', border: '0.5px solid #D0E3F0', borderRadius: '12px', padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' },
  mapPinContainer: { width: '64px', height: '64px', borderRadius: '32px', backgroundColor: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '0.5px solid #0082D1', marginBottom: 12 },
  mapText: { fontSize: '13px', color: '#8A8A8A', lineHeight: 1.6, marginBottom: 16, maxWidth: '220px' },
  coordRow: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderTop: '0.5px solid #D0E3F0', width: '100%', textAlign: 'left' },
  coordDot: { width: 10, height: 10, borderRadius: '50%', marginTop: 4, flexShrink: 0 },
  coordName: { fontSize: '13px', fontWeight: 500, color: '#434343' },
  coordValue: { fontSize: '11px', color: '#8A8A8A', fontFamily: 'monospace' },
  mapLegend: { display: 'flex', gap: '16px', borderTop: '0.5px solid #D0E3F0', paddingTop: '14px', marginTop: 12, width: '100%', justifyContent: 'center' },
  legendItem: { display: 'flex', alignItems: 'center', fontSize: '12px', color: '#8A8A8A' },
  legendDot: { width: '8px', height: '8px', borderRadius: '4px', marginRight: 6 },
};

const loginStyles = {
  page: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    backgroundColor: '#F3F4F6',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    padding: '20px',
    boxSizing: 'border-box'
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: '16px',
    boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
    width: '100%',
    maxWidth: '400px',
    padding: '40px 32px',
    boxSizing: 'border-box',
    border: '0.5px solid #E0E0E0'
  },
  logoWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    marginBottom: '24px'
  },
  logoMark: {
    width: '48px',
    height: '48px',
    borderRadius: '8px',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    marginBottom: '16px'
  },
  logoRow: {
    display: 'flex',
    flex: 1
  },
  logoBlock: {
    flex: 1
  },
  title: {
    fontSize: '28px',
    fontWeight: '700',
    color: '#111827',
    margin: 0
  },
  subtitle: {
    fontSize: '14px',
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: '32px',
    margin: '8px 0 32px 0'
  },
  field: {
    marginBottom: '20px',
    display: 'flex',
    flexDirection: 'column'
  },
  label: {
    fontSize: '13px',
    fontWeight: '500',
    color: '#374151',
    marginBottom: '6px'
  },
  input: {
    width: '100%',
    height: '42px',
    border: '1px solid #D1D5DB',
    borderRadius: '8px',
    padding: '0 14px',
    fontSize: '14px',
    color: '#1F2937',
    backgroundColor: '#FFFFFF',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s',
    outline: 'none'
  },
  errorText: {
    fontSize: '13px',
    color: '#DC2626',
    margin: '0 0 16px 0',
    textAlign: 'left'
  },
  btn: {
    width: '100%',
    height: '44px',
    backgroundColor: '#0082D1',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: '8px',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: '8px'
  },
  hint: {
    fontSize: '12px',
    color: '#6B7280',
    textAlign: 'center',
    marginTop: '24px',
    marginBottom: 0
  }
};

