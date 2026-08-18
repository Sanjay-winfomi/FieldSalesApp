import React, { useCallback, useEffect, useState } from 'react';
import { Bell, MapPin, LogIn, LogOut, ShieldAlert, CheckCircle2, ArrowLeft, WifiOff, CalendarClock, CalendarX, Check, X, Clock, UserX, Trash2 } from 'lucide-react';
import { apiClient } from '../api';
import { SectionHeader, Card, EmptyState, StatusBadge, IconButton, Button, ConfirmationModal } from '../components';
import { colors, typography, spacing } from '../theme';

// Maps a notification's `type` to an icon + StatusBadge tone — mirrors the
// severities createManagerNotification() assigns server-side.
const TYPE_META = {
  left_dealer:          { icon: MapPin,        tone: 'warning' },
  still_outside:        { icon: MapPin,        tone: 'danger' },
  returned:             { icon: CheckCircle2,  tone: 'success' },
  login_exception:      { icon: LogIn,         tone: 'warning' },
  logout_exception:     { icon: LogOut,        tone: 'warning' },
  needs_verification:   { icon: ShieldAlert,   tone: 'warning' },
  sync_failure:         { icon: WifiOff,       tone: 'danger' },
  followup_request:     { icon: CalendarClock, tone: 'info' },
  unvisited_assignments: { icon: CalendarX,    tone: 'warning' },
  day_auto_cutoff:      { icon: Clock,         tone: 'warning' },
  visit_auto_cutoff:    { icon: Clock,         tone: 'warning' },
  day_absent:           { icon: UserX,         tone: 'danger' },
};

// These require an explicit "Reviewed" click — see the backend's read-all
// endpoint, which deliberately excludes them from the passive mark-
// everything-read-on-page-open behavior every other notification type
// gets, since a missed logout/login is serious enough to want a manager to
// actually look at it first.
const REQUIRES_EXPLICIT_REVIEW = ['day_auto_cutoff', 'visit_auto_cutoff', 'day_absent'];

// Mirrors the backend's own DELETE /:id eligibility rule exactly (which
// enforces it server-side regardless of this) — only shows the Clear button
// where there's actually something "done" to check: a REQUIRES_EXPLICIT_
// REVIEW type once its Reviewed click is recorded, or a follow-up request
// once it's been approved/rejected, not still pending. Every other
// notification type has no resolved concept at all, so it never gets one.
function isDeletable(n) {
  if (REQUIRES_EXPLICIT_REVIEW.includes(n.type)) return !!n.read_at;
  if (n.type === 'followup_request') return n.followup_status === 'approved' || n.followup_status === 'rejected';
  return false;
}

const FOLLOWUP_STATUS_LABEL = { approved: 'Approved', rejected: 'Rejected' };

// Maps the backend's machine-readable follow-up-request error codes to
// manager-facing copy — mirrors mobile's FollowupRequestModal, which does
// the same translation for the codes a rep can hit when submitting one.
const FOLLOWUP_ERROR_MESSAGES = {
  approved_date_in_past: 'That date has already passed — pick today or a future date and try again.',
  request_already_resolved: 'This request was already resolved (possibly by another manager) — refresh to see its status.',
};

function followupErrorMessage(err, action) {
  const code = err.response?.data?.error;
  return FOLLOWUP_ERROR_MESSAGES[code] || code || `Failed to ${action} this request.`;
}

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  // Keyed by `${followup_request_id}:${action}` (NOT just followup_request_id
  // — Approve and Reject each need their own in-flight flag, otherwise
  // clicking one shows the other as loading/disabled too even though only
  // one request is actually in flight) — plus any per-row error, so one
  // request's failure doesn't disturb the rest of the list.
  const [resolvingIds, setResolvingIds] = useState({});
  const [resolveErrors, setResolveErrors] = useState({});
  // Keyed by followup_request_id — the date a manager has edited the
  // approval to, if they've touched the input. Falls back to whatever the
  // rep originally requested (followup_requested_date) until then.
  const [approvalDates, setApprovalDates] = useState({});
  // Keyed by notification id — in-flight state for the "Reviewed" button
  // on a day/visit auto-cutoff notification.
  const [reviewingIds, setReviewingIds] = useState({});
  // The notification pending a Clear confirmation, plus in-flight state for
  // the confirm button itself.
  const [clearTarget, setClearTarget] = useState(null);
  const [clearing, setClearing] = useState(false);

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
  // `approvedDate` is REQUIRED for 'approve' (see the Approve button's
  // disabled check below) and always sent explicitly — never omitted — so
  // the backend's past-date guard runs every time, instead of a
  // manager-blanked date silently falling back to the rep's original
  // (possibly stale) requested_date with no guard applied at all.
  const resolveFollowupRequest = async (requestId, action, approvedDate) => {
    const resolveKey = `${requestId}:${action}`;
    setResolvingIds((prev) => ({ ...prev, [resolveKey]: true }));
    setResolveErrors((prev) => ({ ...prev, [requestId]: '' }));
    try {
      if (action === 'approve') {
        await apiClient.patch(`/followup-requests/${requestId}/${action}`, { approved_date: approvedDate });
      } else {
        await apiClient.patch(`/followup-requests/${requestId}/${action}`);
      }
      setNotifications((prev) => prev.map((n) => (
        n.followup_request_id === requestId
          ? {
            ...n,
            followup_status: action === 'approve' ? 'approved' : 'rejected',
            followup_approved_date: action === 'approve' ? approvedDate : n.followup_approved_date,
          }
          : n
      )));
    } catch (err) {
      setResolveErrors((prev) => ({
        ...prev,
        [requestId]: followupErrorMessage(err, action),
      }));
    } finally {
      setResolvingIds((prev) => ({ ...prev, [resolveKey]: false }));
    }
  };

  // Explicit "Reviewed" click for a day/visit auto-cutoff notification —
  // these are deliberately excluded from the passive read-all-on-open below,
  // so this is the only way one of these ever gets marked read.
  const markReviewed = async (id) => {
    setReviewingIds((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await apiClient.patch(`/notifications/${id}/read`);
      setNotifications((prev) => prev.map((n) => (
        n.id === id ? { ...n, read_at: res.data.notification.read_at } : n
      )));
      if (onUnreadCountChange) {
        const unread = await apiClient.get('/notifications/unread-count');
        onUnreadCountChange(unread.data.count);
      }
    } catch {
      // Best-effort — the button just stays clickable to retry.
    } finally {
      setReviewingIds((prev) => ({ ...prev, [id]: false }));
    }
  };

  // Permanently removes a notification — only ever called on one that
  // isDeletable() already confirmed is reviewed/resolved, and the backend
  // re-checks the same rule itself regardless.
  const confirmClear = async () => {
    if (!clearTarget) return;
    setClearing(true);
    try {
      await apiClient.delete(`/notifications/${clearTarget.id}`);
      setNotifications((prev) => prev.filter((n) => n.id !== clearTarget.id));
      setClearTarget(null);
    } catch {
      // Leave the confirmation dialog open — the user can retry the click.
    } finally {
      setClearing(false);
    }
  };

  // Mark everything else read on open (day_auto_cutoff/visit_auto_cutoff are
  // excluded server-side — see notifications.routes.js), then reflect the
  // real remaining unread count back up to the header's bell badge
  // immediately rather than waiting on its own poll. Not hardcoded to 0:
  // an unreviewed auto-cutoff notification is exactly the case where the
  // badge must NOT clear just because the page was opened.
  useEffect(() => {
    apiClient.post('/notifications/read-all').then(async () => {
      if (onUnreadCountChange) {
        const unread = await apiClient.get('/notifications/unread-count');
        onUnreadCountChange(unread.data.count);
      }
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
          <div style={styles.list} className="ft-stagger">
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
                      n.followup_status === 'pending' ? (() => {
                        const effectiveDate = approvalDates[n.followup_request_id] ?? n.followup_requested_date ?? '';
                        return (
                        <div style={styles.followupActions}>
                          <label style={styles.followupDateLabel}>
                            Visit date
                            <input
                              type="date"
                              className="ft-input"
                              style={styles.followupDateInput}
                              min={todayDateString()}
                              value={effectiveDate}
                              onChange={(e) => setApprovalDates((prev) => ({ ...prev, [n.followup_request_id]: e.target.value }))}
                              aria-label="Approval date"
                            />
                          </label>
                          <Button
                            variant="success"
                            style={styles.followupBtn}
                            icon={<Check size={14} />}
                            loading={!!resolvingIds[`${n.followup_request_id}:approve`]}
                            disabled={!effectiveDate}
                            onClick={() => resolveFollowupRequest(n.followup_request_id, 'approve', effectiveDate)}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="danger"
                            style={styles.followupBtn}
                            icon={<X size={14} />}
                            loading={!!resolvingIds[`${n.followup_request_id}:reject`]}
                            onClick={() => resolveFollowupRequest(n.followup_request_id, 'reject')}
                          >
                            Reject
                          </Button>
                          {resolveErrors[n.followup_request_id] && (
                            <span style={styles.followupError}>{resolveErrors[n.followup_request_id]}</span>
                          )}
                        </div>
                        );
                      })() : (
                        <div style={{ marginTop: spacing.sm, display: 'flex', alignItems: 'center', gap: spacing.sm }}>
                          <StatusBadge
                            label={FOLLOWUP_STATUS_LABEL[n.followup_status] || n.followup_status}
                            tone={n.followup_status === 'approved' ? 'success' : 'danger'}
                          />
                          {n.followup_status === 'approved' && n.followup_approved_date && (
                            <span style={styles.followupApprovedDate}>for {n.followup_approved_date}</span>
                          )}
                          <IconButton
                            icon={<Trash2 size={13} />}
                            title="Clear notification"
                            onClick={() => setClearTarget(n)}
                            style={styles.clearBtn}
                          />
                        </div>
                      )
                    )}

                    {REQUIRES_EXPLICIT_REVIEW.includes(n.type) && (
                      n.read_at ? (
                        <div style={{ marginTop: spacing.sm, display: 'flex', alignItems: 'center', gap: spacing.sm }}>
                          <StatusBadge label="Reviewed" tone="success" />
                          <IconButton
                            icon={<Trash2 size={13} />}
                            title="Clear notification"
                            onClick={() => setClearTarget(n)}
                            style={styles.clearBtn}
                          />
                        </div>
                      ) : (
                        <div style={{ marginTop: spacing.sm }}>
                          <Button
                            variant="success"
                            style={styles.followupBtn}
                            icon={<Check size={14} />}
                            loading={!!reviewingIds[n.id]}
                            onClick={() => markReviewed(n.id)}
                          >
                            Reviewed
                          </Button>
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

      <ConfirmationModal
        open={!!clearTarget}
        title="Clear this notification?"
        message="This permanently removes it from the list. This cannot be undone."
        confirmLabel="Clear"
        danger
        loading={clearing}
        onConfirm={confirmClear}
        onCancel={() => setClearTarget(null)}
      />
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
  followupDateLabel: { display: 'flex', flexDirection: 'column', gap: 2, ...typography.caption, color: colors.textSecondary, fontWeight: 600 },
  followupDateInput: { height: 32, padding: '0 8px', fontSize: 12, width: 140, maxWidth: '100%' },
  followupApprovedDate: { ...typography.caption, color: colors.textMuted },
  clearBtn: { width: 28, height: 28 },
};
