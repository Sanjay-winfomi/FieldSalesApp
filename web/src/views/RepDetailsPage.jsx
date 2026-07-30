import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Clock, Route, Timer, MapPin, CheckCircle2, AlertTriangle } from 'lucide-react';
import { apiClient } from '../api';
import { Card, SectionHeader, LoadingCard, EmptyState, IconButton } from '../components';
import { colors, typography, spacing } from '../theme';

function formatTimeOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function formatCoord(value) {
  return value != null ? parseFloat(value).toFixed(5) : 'N/A';
}

// Live status if the periodic in-visit check has run, else the check-in
// moment's own inside/outside flag (visit may still be open with no ping yet).
function radiusCompliance(visit) {
  const inside = visit.last_location_status
    ? visit.last_location_status === 'inside'
    : visit.check_in_inside_radius;
  const distanceM = visit.last_location_distance_m ?? visit.check_in_distance_m;
  const reason = visit.check_out_justification_note || visit.justification_note;
  return { inside, distanceM, reason };
}

export default function RepDetailsPage({ token, repId, onBack }) {
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

  return (
    <div style={styles.page} className="ft-page">
      <div style={styles.headerRow}>
        <IconButton icon={<ArrowLeft size={16} />} onClick={onBack} title="Back to dashboard" size={40} />
        <SectionHeader title={data ? `${data.employee.name} — Today's timeline` : 'Representative timeline'} />
      </div>

      {loading && <LoadingCard message="Loading representative details..." />}

      {!loading && (error || !data) && (
        <Card><EmptyState title="Couldn't load details" subtitle={error || 'Representative not found.'} onRetry={fetchDetails} /></Card>
      )}

      {!loading && data && (
        <div className="ft-grid-12">
          <div style={{ gridColumn: 'span 5' }} className="ft-details-col">
            <Card>
              <h3 style={styles.cardTitle}>Attendance status</h3>
              {data.attendance ? (
                <div>
                  <div style={styles.metaRow}>
                    <div style={styles.metaCol}>
                      <span style={styles.metaLabel}>Check-in time</span>
                      <span style={styles.metaValue}>{formatTimeOnly(data.attendance.check_in_time)}</span>
                      <span style={styles.coordVal}>
                        GPS: {data.attendance.check_in_lat != null ? data.attendance.check_in_lat.toFixed(5) : 'N/A'}, {data.attendance.check_in_lng != null ? data.attendance.check_in_lng.toFixed(5) : 'N/A'}
                      </span>
                    </div>
                    <div style={styles.metaCol}>
                      <span style={styles.metaLabel}>Check-out time</span>
                      <span style={styles.metaValue}>{formatTimeOnly(data.attendance.check_out_time)}</span>
                      {data.attendance.check_out_time && (
                        <span style={styles.coordVal}>
                          GPS: {data.attendance.check_out_lat != null ? data.attendance.check_out_lat.toFixed(5) : 'N/A'}, {data.attendance.check_out_lng != null ? data.attendance.check_out_lng.toFixed(5) : 'N/A'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={styles.divider} />

                  <div style={styles.metaRow}>
                    <div style={styles.metaCol}>
                      <span style={styles.metaLabel}><Route size={11} style={{ marginRight: 4, verticalAlign: -1 }} />Travelled</span>
                      <span style={styles.metaValue}>{parseFloat(data.attendance.total_distance_km || 0).toFixed(2)} km</span>
                    </div>
                    <div style={styles.metaCol}>
                      <span style={styles.metaLabel}><Timer size={11} style={{ marginRight: 4, verticalAlign: -1 }} />Work duration</span>
                      <span style={styles.metaValue}>
                        {data.attendance.total_duration_minutes ? `${data.attendance.total_duration_minutes} mins` : 'Active'}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <EmptyState title="No attendance recorded" subtitle="This rep hasn't checked in today." />
              )}
            </Card>
          </div>

          <div style={{ gridColumn: 'span 7' }} className="ft-details-col">
            <Card>
              <h3 style={styles.cardTitle}>Visits timeline ({data.visits.length})</h3>
              {data.visits.length === 0 ? (
                <EmptyState icon={<MapPin size={22} color={colors.textMuted} />} title="No dealer visits yet" subtitle="Visits logged today will appear here." />
              ) : (
                <div style={styles.timelineList}>
                  {data.visits.map((visit, index) => (
                    <div key={visit.id} style={styles.timelineItem}>
                      <div style={styles.timelineIndicator}>
                        <div style={styles.timelineDot} />
                        {index !== data.visits.length - 1 && <div style={styles.timelineLine} />}
                      </div>
                      <div style={styles.timelineContent}>
                        <div style={styles.timelineHeader}>
                          <h4 style={styles.dealerName}>{visit.dealer_name}</h4>
                          <span style={styles.timelineTime}>
                            <Clock size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
                            {formatTimeOnly(visit.check_in_time)} – {formatTimeOnly(visit.check_out_time)}
                          </span>
                        </div>
                        <p style={styles.dealerAddress}>{visit.dealer_address}</p>
                        <div style={styles.visitStats}>
                          <span>{visit.visit_duration_minutes ? `${visit.visit_duration_minutes} min duration` : 'Active'}</span>
                          {visit.distance_from_previous_km > 0 && (
                            <span>· {parseFloat(visit.distance_from_previous_km).toFixed(2)} km from prev point</span>
                          )}
                        </div>

                        {visit.dealer_lat != null && (() => {
                          const { inside, distanceM, reason } = radiusCompliance(visit);
                          return (
                            <div style={inside ? styles.complianceCardOk : styles.complianceCardBad}>
                              <div style={styles.complianceHeader}>
                                {inside ? (
                                  <CheckCircle2 size={14} color={colors.successDark} style={{ marginRight: 6, flexShrink: 0 }} />
                                ) : (
                                  <AlertTriangle size={14} color={colors.dangerDark} style={{ marginRight: 6, flexShrink: 0 }} />
                                )}
                                <span style={{ color: inside ? colors.successDark : colors.dangerDark }}>
                                  {inside ? 'Inside dealer radius' : 'Outside dealer radius'}
                                </span>
                              </div>
                              <div style={styles.complianceRow}>
                                <span>Distance: {distanceM != null ? `${Math.round(distanceM)} m` : 'N/A'} / {visit.radius_meters} m allowed</span>
                              </div>
                              <div style={styles.complianceCoordsRow}>
                                <span>Dealer GPS: {formatCoord(visit.dealer_lat)}, {formatCoord(visit.dealer_lng)}</span>
                                <span>Rep GPS: {formatCoord(visit.check_in_lat)}, {formatCoord(visit.check_in_lng)}</span>
                              </div>
                              {!inside && reason && (
                                <div style={styles.complianceReason}>Reason: "{reason}"</div>
                              )}
                              {visit.outside_radius_count > 0 && (
                                <div style={styles.complianceMeta}>
                                  {visit.outside_radius_count} out-of-radius check{visit.outside_radius_count !== 1 ? 's' : ''} this visit
                                  {visit.last_location_check_at && ` · last checked ${formatTimeOnly(visit.last_location_check_at)}`}
                                </div>
                              )}
                              {visit.log_out_alert_sent && !visit.check_out_time && (
                                <div style={styles.complianceAlert}>
                                  <AlertTriangle size={12} style={{ marginRight: 5, flexShrink: 0 }} />
                                  Repeatedly outside radius — rep notified to check out
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: `${spacing.xxl}px`, maxWidth: 1920, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  headerRow: { display: 'flex', alignItems: 'center', gap: spacing.md, marginBottom: spacing.xl },
  cardTitle: { ...typography.cardTitle, color: colors.text, marginBottom: spacing.lg, paddingBottom: spacing.md, borderBottom: `1px solid ${colors.border}` },
  metaRow: { display: 'flex', gap: spacing.lg, marginBottom: spacing.lg },
  metaCol: { flex: 1, display: 'flex', flexDirection: 'column' },
  metaLabel: { ...typography.caption, color: colors.textSecondary, textTransform: 'uppercase', marginBottom: 4, letterSpacing: '0.03em' },
  metaValue: { ...typography.body, fontWeight: 600, color: colors.text, fontSize: 16 },
  coordVal: { fontSize: 11, color: colors.textMuted, fontFamily: 'monospace', marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.border, margin: `${spacing.lg}px 0` },
  timelineList: { display: 'flex', flexDirection: 'column' },
  timelineItem: { display: 'flex', gap: spacing.lg, position: 'relative' },
  timelineIndicator: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary, marginTop: 6 },
  timelineLine: { width: 2, flex: 1, backgroundColor: colors.border },
  timelineContent: { flex: 1, paddingBottom: spacing.xl },
  timelineHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, flexWrap: 'wrap', gap: 4 },
  dealerName: { fontSize: 15, fontWeight: 600, color: colors.text, margin: 0 },
  timelineTime: { fontSize: 12, color: colors.textSecondary },
  dealerAddress: { fontSize: 13, color: colors.textSecondary, margin: '4px 0 8px' },
  visitStats: { display: 'flex', gap: 8, fontSize: 12, color: colors.textMuted },
  complianceCardOk: {
    marginTop: spacing.sm, padding: '10px 12px', borderRadius: 10, fontSize: 12,
    backgroundColor: colors.successLight, border: '1px solid #BBF7D0',
  },
  complianceCardBad: {
    marginTop: spacing.sm, padding: '10px 12px', borderRadius: 10, fontSize: 12,
    backgroundColor: colors.dangerLight, border: '1px solid #FECACA',
  },
  complianceHeader: { display: 'flex', alignItems: 'center', fontWeight: 700, marginBottom: 6 },
  complianceRow: { color: colors.text, marginBottom: 4 },
  complianceCoordsRow: { display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'monospace', fontSize: 11, color: colors.textSecondary, marginBottom: 4 },
  complianceReason: { fontSize: 12, color: colors.textSecondary, fontStyle: 'italic', marginBottom: 4 },
  complianceMeta: { fontSize: 11, color: colors.textMuted },
  complianceAlert: { display: 'flex', alignItems: 'center', fontSize: 11.5, fontWeight: 700, color: colors.dangerDark, marginTop: 6 },
};
