import React, { useCallback, useEffect, useState } from 'react';
import { Bell, MapPin, LogIn, LogOut, ShieldAlert, CheckCircle2, ArrowLeft, WifiOff, CalendarClock, Check, X } from 'lucide-react';
import { apiClient } from '../api';
import { SectionHeader, Card, EmptyState, StatusBadge, IconButton, Button } from '../components';
import { colors, typography, spacing } from '../theme';

// Maps a notification's `type` to an icon + StatusBadge tone — mirrors the
// severities createManagerNotification() assigns server-side.
const TYPE_META = {
  left_dealer:         { icon: MapPin,        tone: 'warning' },
  still_outside:       { icon: MapPin,        tone: 'danger' },
  returned:            { icon: CheckCircle2,  tone: 'success' },
  login_exception:     { icon: LogIn,         tone: 'warning' },
  logout_exception:    { icon: LogOut,        tone: 'warning' },
  needs_verification:  { icon: ShieldAlert,   tone: 'warning' },
  sync_failure:        { icon: WifiOff,       tone: 'danger' },
  followup_request:    { icon: CalendarClock, tone: 'info' },
};

const FOLLOWUP_STATUS_LABEL = { approved: 'Approved', rejected: 'Rejected' };

function formatTime(value) {
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/**
 * Notification bell's destination page — lists manager_notifications, newest
 * first. Opening this page marks everything unread as read (mirrors how a
 * notification center conventionally behaves), which is what lets the bell's
 * badge clear.
 */
export default function NotificationsPage({ onUnreadCountChange, onBack }) {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Keyed by followup_request_id — tracks in-flight approve/reject calls
  // and any per-row error, so one request's failure doesn't disturb the
  // rest of the list.
  const [resolvingIds, setResolvingIds] = useState({});
  const [resolveErrors, setResolveErrors] = useState({});

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get('/notifications');
      setNotifications(res.data.notifications || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load notifications.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Approve/reject a follow-up request directly from its notification card.
  // Updates just that row's followup_status locally on success rather than
  // refetching the whole list, so the rest of the feed doesn't jump/reload.
  const resolveFollowupRequest = async (requestId, action) => {
    setResolvingIds((prev) => ({ ...prev, [requestId]: true }));
    setResolveErrors((prev) => ({ ...prev, [requestId]: '' }));
    try {
      await apiClient.patch(`/followup-requests/${requestId}/${action}`);
      setNotifications((prev) => prev.map((n) => (
        n.followup_request_id === requestId
          ? { ...n, followup_status: action === 'approve' ? 'approved' : 'rejected' }
          : n
      )));
    } catch (err) {
      setResolveErrors((prev) => ({
        ...prev,
        [requestId]: err.response?.data?.error || `Failed to ${action} this request.`,
      }));
    } finally {
      setResolvingIds((prev) => ({ ...prev, [requestId]: false }));
    }
  };

  // Mark everything read on open, then reflect the now-zero count back up to
  // the header's bell badge immediately rather than waiting on its own poll.
  useEffect(() => {
    apiClient.post('/notifications/read-all').then(() => {
      if (onUnreadCountChange) onUnreadCountChange(0);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={styles.page} className="ft-page">
      {onBack && (
        <IconButton icon={<ArrowLeft size={18} />} title="Back to Dashboard" onClick={onBack} style={styles.backBtn} />
      )}
      <SectionHeader title="Notifications" subtitle="Dealer visit alerts and login/logout exceptions across your team" />

      <Card noPadding style={{ overflow: 'hidden' }}>
        {error ? (
          <EmptyState title="Couldn't load notifications" subtitle={error} onRetry={fetchNotifications} />
        ) : loading ? (
          <div style={styles.loading}>Loading…</div>
        ) : notifications.length === 0 ? (
          <EmptyState icon={<Bell size={24} color={colors.textMuted} />} title="No notifications yet" subtitle="Dealer visit alerts and exceptions will show up here." />
        ) : (
          <div style={styles.list}>
            {notifications.map((n) => {
              const meta = TYPE_META[n.type] || { icon: Bell, tone: 'neutral' };
              const Icon = meta.icon;
              return (
                <div key={n.id} style={styles.row}>
                  <div style={{ ...styles.iconWrap, backgroundColor: n.read_at ? colors.neutralBg : colors.warningLight }}>
                    <Icon size={16} color={n.read_at ? colors.textMuted : colors.warningDark} />
                  </div>
                  <div style={styles.rowBody}>
                    <div style={styles.rowHeader}>
                      <span style={styles.rowTitle}>{n.title}</span>
                      {n.type === 'needs_verification' && <StatusBadge label="Needs Verification" tone="warning" />}
                    </div>
                    <div style={styles.rowText}>{n.body}</div>
                    <div style={styles.rowMeta}>
                      {n.employee_name && <span>{n.employee_name}</span>}
                      {n.dealer_name && <span>· {n.dealer_name}</span>}
                      <span>· {formatTime(n.created_at)}</span>
                    </div>

                    {n.followup_request_id && (
                      n.followup_status === 'pending' ? (
                        <div style={styles.followupActions}>
                          <Button
                            variant="success"
                            style={styles.followupBtn}
                            icon={<Check size={14} />}
                            loading={!!resolvingIds[n.followup_request_id]}
                            onClick={() => resolveFollowupRequest(n.followup_request_id, 'approve')}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="danger"
                            style={styles.followupBtn}
                            icon={<X size={14} />}
                            loading={!!resolvingIds[n.followup_request_id]}
                            onClick={() => resolveFollowupRequest(n.followup_request_id, 'reject')}
                          >
                            Reject
                          </Button>
                          {resolveErrors[n.followup_request_id] && (
                            <span style={styles.followupError}>{resolveErrors[n.followup_request_id]}</span>
                          )}
                        </div>
                      ) : (
                        <div style={{ marginTop: spacing.sm }}>
                          <StatusBadge
                            label={FOLLOWUP_STATUS_LABEL[n.followup_status] || n.followup_status}
                            tone={n.followup_status === 'approved' ? 'success' : 'danger'}
                          />
                        </div>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

const styles = {
  page: { padding: `${spacing.xxl}px`, maxWidth: 900, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  backBtn: { marginBottom: spacing.md },
  loading: { padding: '40px 24px', textAlign: 'center', color: colors.textMuted, fontSize: 13 },
  list: { display: 'flex', flexDirection: 'column' },
  row: { display: 'flex', gap: spacing.md, padding: '16px 20px', borderBottom: `1px solid ${colors.border}` },
  iconWrap: { width: 34, height: 34, borderRadius: 17, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0 },
  rowHeader: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowTitle: { ...typography.bodyMedium, color: colors.text },
  rowText: { ...typography.body, color: colors.textSecondary, marginTop: 4 },
  rowMeta: { display: 'flex', gap: 4, ...typography.caption, color: colors.textMuted, marginTop: 6 },
  followupActions: { display: 'flex', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  followupBtn: { height: 32, padding: '0 12px', fontSize: 12 },
  followupError: { ...typography.caption, color: colors.danger },
};
