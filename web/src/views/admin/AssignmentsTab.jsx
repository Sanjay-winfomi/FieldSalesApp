import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ChevronUp, ChevronDown, X, Plus, MapPin, Route } from 'lucide-react';
import { apiClient } from '../../api';
import { SectionHeader, SearchBar, EmptyState, Button, RepSelect, ConfirmationModal } from '../../components';
import { colors, spacing, typography } from '../../theme';
import { haversineKm } from '../../utils/geo';

const STATUS_LABELS = {
  pending: 'Pending',
  navigating: 'Navigating',
  arrived: 'Arrived',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function SortableRow({ item, index, total, distanceFromPrevKm, drivingDistance, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.dealer_id });

  return (
    <div
      ref={setNodeRef}
      data-testid={`assignment-row-${item.dealer_id}`}
      style={{
        ...styles.row,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <button
        type="button"
        className="ft-icon-btn"
        style={styles.dragHandle}
        aria-label={`Drag ${item.dealer_name} to reorder`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={15} color={colors.textMuted} />
      </button>

      <span style={styles.orderBadge}>{index + 1}</span>

      <div style={styles.rowText}>
        <div style={{ fontWeight: 600, color: colors.text, fontSize: 14 }}>{item.dealer_name}</div>
        {!!item.dealer_address && <div style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{item.dealer_address}</div>}
        {drivingDistance?.km != null ? (
          <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
            ↳ {drivingDistance.km.toFixed(1)} km from previous stop (driving, via Google Maps)
          </div>
        ) : drivingDistance?.loading ? (
          <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
            ↳ Getting driving distance…
          </div>
        ) : distanceFromPrevKm != null && (
          <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
            ↳ {distanceFromPrevKm.toFixed(1)} km from previous stop (straight-line{drivingDistance?.error ? ' — driving distance unavailable' : ''})
          </div>
        )}
      </div>

      {item.status && item.status !== 'pending' && (
        <span style={{ ...styles.statusPill, ...(STATUS_STYLES[item.status] || STATUS_STYLES.pending) }}>
          {STATUS_LABELS[item.status] || item.status}
        </span>
      )}

      <div style={styles.rowActions}>
        <button type="button" className="ft-icon-btn" style={styles.moveBtn} aria-label={`Move ${item.dealer_name} up`} disabled={index === 0} onClick={() => onMoveUp(index)}>
          <ChevronUp size={14} />
        </button>
        <button type="button" className="ft-icon-btn" style={styles.moveBtn} aria-label={`Move ${item.dealer_name} down`} disabled={index === total - 1} onClick={() => onMoveDown(index)}>
          <ChevronDown size={14} />
        </button>
        <button type="button" className="ft-icon-btn" style={styles.moveBtn} aria-label={`Remove ${item.dealer_name}`} onClick={() => onRemove(item.dealer_id)}>
          <X size={14} color={colors.danger} />
        </button>
      </div>
    </div>
  );
}

const STATUS_STYLES = {
  pending: { backgroundColor: colors.background, color: colors.textSecondary },
  navigating: { backgroundColor: colors.primaryLight, color: colors.primary },
  arrived: { backgroundColor: colors.warningLight, color: colors.warningDark },
  completed: { backgroundColor: colors.successLight, color: colors.successDark },
  cancelled: { backgroundColor: colors.dangerLight, color: colors.dangerDark },
};

/**
 * Manager-side Dealer Assignment editor — pick a rep + date, build an
 * ordered dealer visit plan, save. The order shown here (drag handle, or
 * the up/down buttons) is exactly what gets sent as dealer_ids to
 * PUT /api/assignments — nothing on the backend ever reorders it.
 */
export default function AssignmentsTab() {
  const [employees, setEmployees] = useState([]);
  const [allDealers, setAllDealers] = useState([]);
  const [selectedRepId, setSelectedRepId] = useState(null);
  const [date, setDate] = useState(todayDateString());
  const [assignedList, setAssignedList] = useState([]);
  const [savedDealerIds, setSavedDealerIds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [dealerSearch, setDealerSearch] = useState('');
  // { signature, byDealerId } — byDealerId keys by dealer_id (the row AFTER
  // the leg, i.e. the one showing "↳ from previous stop") to { km, loading,
  // error }. signature is the dealer_id order it was computed for
  // (`assignedList.map(a => a.dealer_id).join(',')`) — rendering only ever
  // trusts byDealerId when it matches the CURRENT order, so a stale driving
  // distance from before a reorder/add/remove is automatically ignored
  // rather than needing to be explicitly cleared on every mutator.
  const [drivingDistances, setDrivingDistances] = useState({ signature: '', byDealerId: {} });
  // Set to { type: 'rep'|'date', value } when the rep/date selector is
  // changed while there are unsaved edits — loadAssignment's effect would
  // otherwise silently overwrite assignedList with the newly-selected
  // rep/date's rows the instant selectedRepId/date changes, discarding
  // whatever reordering/add/remove hadn't been saved yet.
  const [discardConfirm, setDiscardConfirm] = useState(null);
  // dealer_id of the row pending removal (NOT its array index — an index
  // would silently point at the wrong row if assignedList reordered or
  // changed while the confirm dialog was open) — confirmed before actually
  // dropping it, consistent with how every other destructive-feeling action
  // in this app is confirmed (nothing persists until Save either way, but a
  // one-click, no-confirm removal was still the odd one out here).
  const [removeConfirmDealerId, setRemoveConfirmDealerId] = useState(null);
  // Guards against a slower request for a previously-selected rep/date
  // resolving after a newer one was already kicked off (e.g. clicking
  // through reps quickly) and clobbering the view with stale data.
  const loadRequestIdRef = useRef(0);

  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(''), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  useEffect(() => {
    apiClient.get('/employees?role=rep').then((res) => setEmployees(res.data.employees)).catch(() => {});
    apiClient.get('/dealers').then((res) => setAllDealers(res.data.dealers)).catch(() => {});
  }, []);

  const loadAssignment = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!selectedRepId) {
      setAssignedList([]);
      setSavedDealerIds([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get('/assignments', { params: { employee_id: selectedRepId, date } });
      // A newer load (rep/date changed again while this was in flight) has
      // already started — don't let this stale response overwrite it.
      if (requestId !== loadRequestIdRef.current) return;
      const rows = res.data.assignments || [];
      setAssignedList(rows.map((r) => ({
        id: r.id,
        dealer_id: r.dealer_id,
        dealer_name: r.dealer_name,
        dealer_address: r.dealer_address,
        dealer_lat: r.dealer_lat,
        dealer_lng: r.dealer_lng,
        status: r.status,
      })));
      setSavedDealerIds(rows.map((r) => r.dealer_id));
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      setError(err.response?.data?.error || 'Failed to load visit plan.');
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false);
    }
  }, [selectedRepId, date]);

  useEffect(() => { loadAssignment(); }, [loadAssignment]);

  const isDirty = useMemo(() => {
    const current = assignedList.map((a) => a.dealer_id);
    return current.length !== savedDealerIds.length || current.some((id, i) => id !== savedDealerIds[i]);
  }, [assignedList, savedDealerIds]);

  // Straight-line (haversine) distance from each dealer to the one before
  // it in the plan — a quick "how spread out is this route" estimate for
  // the manager while building the plan. Not the real driving distance
  // (that's the Google Routes API's job, computed per-navigation on the
  // rep's device) — null for a dealer missing coordinates, or the first
  // stop (nothing before it to measure from).
  const distancesFromPrevKm = useMemo(() => {
    return assignedList.map((item, i) => {
      if (i === 0) return null;
      const prev = assignedList[i - 1];
      if (item.dealer_lat == null || item.dealer_lng == null || prev.dealer_lat == null || prev.dealer_lng == null) {
        return null;
      }
      return haversineKm(prev.dealer_lat, prev.dealer_lng, item.dealer_lat, item.dealer_lng);
    });
  }, [assignedList]);

  const totalDistanceKm = useMemo(
    () => distancesFromPrevKm.reduce((sum, km) => sum + (km ?? 0), 0),
    [distancesFromPrevKm]
  );

  const currentOrderSignature = useMemo(() => assignedList.map((a) => a.dealer_id).join(','), [assignedList]);
  const currentDrivingDistances = drivingDistances.signature === currentOrderSignature ? drivingDistances.byDealerId : {};

  // Real Google Maps driving distance for each consecutive leg in the
  // just-saved order — fetched one leg at a time (not in parallel) so this
  // doesn't fire a burst of simultaneous Routes API calls for a long plan;
  // each leg's row shows its own "Getting driving distance…" state
  // independently while it's still in flight.
  const fetchDrivingDistances = useCallback(async (rows) => {
    const signature = rows.map((r) => r.dealer_id).join(',');
    setDrivingDistances({ signature, byDealerId: {} });

    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      if (prev.dealer_lat == null || prev.dealer_lng == null || curr.dealer_lat == null || curr.dealer_lng == null) {
        continue;
      }
      setDrivingDistances((state) => (
        state.signature !== signature ? state : { ...state, byDealerId: { ...state.byDealerId, [curr.dealer_id]: { loading: true } } }
      ));
      try {
        const res = await apiClient.post('/navigation/distance-preview', {
          origin_lat: prev.dealer_lat, origin_lng: prev.dealer_lng,
          dest_lat: curr.dealer_lat, dest_lng: curr.dealer_lng,
        });
        setDrivingDistances((state) => (
          state.signature !== signature ? state : {
            ...state,
            byDealerId: { ...state.byDealerId, [curr.dealer_id]: { km: res.data.distanceMeters / 1000 } },
          }
        ));
      } catch {
        setDrivingDistances((state) => (
          state.signature !== signature ? state : { ...state, byDealerId: { ...state.byDealerId, [curr.dealer_id]: { error: true } } }
        ));
      }
    }
  }, []);

  const availableDealers = useMemo(() => {
    const assignedIds = new Set(assignedList.map((a) => a.dealer_id));
    const q = dealerSearch.trim().toLowerCase();
    return allDealers.filter((d) => {
      if (assignedIds.has(d.id)) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || (d.address || '').toLowerCase().includes(q);
    });
  }, [allDealers, assignedList, dealerSearch]);

  const handleAddDealer = (dealer) => {
    setAssignedList((prev) => [...prev, {
      id: null, dealer_id: dealer.id, dealer_name: dealer.name, dealer_address: dealer.address,
      dealer_lat: dealer.latitude, dealer_lng: dealer.longitude, status: 'pending',
    }]);
  };

  const requestRemove = (dealerId) => setRemoveConfirmDealerId(dealerId);

  const confirmRemove = () => {
    if (removeConfirmDealerId == null) return;
    setAssignedList((prev) => prev.filter((a) => a.dealer_id !== removeConfirmDealerId));
    setRemoveConfirmDealerId(null);
  };

  const removeConfirmDealer = useMemo(
    () => assignedList.find((a) => a.dealer_id === removeConfirmDealerId) || null,
    [assignedList, removeConfirmDealerId]
  );

  const requestRepChange = (id) => {
    if (isDirty) { setDiscardConfirm({ type: 'rep', value: id }); return; }
    setSelectedRepId(id);
  };

  const requestDateChange = (newDate) => {
    if (isDirty) { setDiscardConfirm({ type: 'date', value: newDate }); return; }
    setDate(newDate);
  };

  const confirmDiscard = () => {
    if (discardConfirm.type === 'rep') setSelectedRepId(discardConfirm.value);
    else setDate(discardConfirm.value);
    setDiscardConfirm(null);
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    setAssignedList((prev) => arrayMove(prev, index, index - 1));
  };

  const handleMoveDown = (index) => {
    setAssignedList((prev) => (index >= prev.length - 1 ? prev : arrayMove(prev, index, index + 1)));
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setAssignedList((prev) => {
      const oldIndex = prev.findIndex((a) => a.dealer_id === active.id);
      const newIndex = prev.findIndex((a) => a.dealer_id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const handleSave = async () => {
    // `loading` guards against saving while a rep/date switch's fetch is
    // still in flight — assignedList would still be the previous
    // rep/date's rows at that point, and PUT-ing them against the
    // newly-selected employee_id/date would silently misattribute them.
    if (!selectedRepId || loading) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiClient.put('/assignments', {
        employee_id: selectedRepId,
        assignment_date: date,
        dealer_ids: assignedList.map((a) => a.dealer_id),
      });
      const rows = res.data.assignments || [];
      const mappedRows = rows.map((r) => ({
        id: r.id,
        dealer_id: r.dealer_id,
        dealer_name: r.dealer_name,
        dealer_address: r.dealer_address,
        dealer_lat: r.dealer_lat,
        dealer_lng: r.dealer_lng,
        status: r.status,
      }));
      setAssignedList(mappedRows);
      setSavedDealerIds(rows.map((r) => r.dealer_id));
      setSuccessMessage('Visit plan saved.');
      // Best-effort, not awaited — Save's own success/loading state doesn't
      // depend on Google Maps actually responding; rows just show their
      // straight-line estimate until each leg's real distance arrives.
      fetchDrivingDistances(mappedRows);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save visit plan.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Dealer Visit Plan"
        subtitle="Plan a representative's ordered dealer visit sequence for a day — the order set here is never auto-reordered."
        action={
          <Button icon={<Route size={15} />} onClick={handleSave} loading={saving} disabled={!selectedRepId || !isDirty || loading} fullWidthMobile>
            {isDirty ? 'Save changes' : 'Saved'}
          </Button>
        }
      />

      {error && <div style={styles.errorBanner} role="alert">{error}</div>}
      {successMessage && <div style={styles.successBanner} role="status">{successMessage}</div>}

      <div style={styles.filterRow}>
        <RepSelect employees={employees} selectedId={selectedRepId} onChange={requestRepChange} style={{ minWidth: 260 }} />
        <input
          type="date"
          className="ft-input"
          value={date}
          onChange={(e) => requestDateChange(e.target.value)}
          style={{ maxWidth: 200 }}
          aria-label="Visit plan date"
        />
      </div>

      {!selectedRepId ? (
        <EmptyState title="Select a representative" subtitle="Choose a rep and date above to view or build their dealer visit plan." />
      ) : (
        <div style={styles.splitGrid}>
          <div className="ft-card" style={styles.panel}>
            <h3 style={styles.panelTitle}>
              Assigned order ({assignedList.length})
              {totalDistanceKm > 0 && (
                <span style={{ fontSize: 12, fontWeight: 500, color: colors.textMuted, marginLeft: 8 }}>
                  · ~{totalDistanceKm.toFixed(1)} km total (straight-line)
                </span>
              )}
            </h3>
            {loading ? (
              <p style={{ fontSize: 13, color: colors.textMuted }}>Loading...</p>
            ) : assignedList.length === 0 ? (
              <EmptyState
                icon={<MapPin size={32} color={colors.textMuted} />}
                title="No dealers assigned yet"
                subtitle="Add dealers from the list on the right, in the order you want the rep to visit them."
              />
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={assignedList.map((a) => a.dealer_id)} strategy={verticalListSortingStrategy}>
                  <div>
                    {assignedList.map((item, index) => (
                      <SortableRow
                        key={item.dealer_id}
                        item={item}
                        index={index}
                        total={assignedList.length}
                        distanceFromPrevKm={distancesFromPrevKm[index]}
                        drivingDistance={currentDrivingDistances[item.dealer_id]}
                        onMoveUp={handleMoveUp}
                        onMoveDown={handleMoveDown}
                        onRemove={requestRemove}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          <div className="ft-card" style={styles.panel}>
            <h3 style={styles.panelTitle}>Add dealers</h3>
            <SearchBar value={dealerSearch} onChange={setDealerSearch} placeholder="Search by name or address" style={{ marginBottom: spacing.md }} />
            {availableDealers.length === 0 ? (
              <p style={{ fontSize: 13, color: colors.textMuted }}>
                {dealerSearch ? 'No dealers match your search.' : 'All dealers are already assigned.'}
              </p>
            ) : (
              <div style={styles.availableList}>
                {availableDealers.map((d) => (
                  <div key={d.id} style={styles.availableRow}>
                    <div style={styles.rowText}>
                      <div style={{ fontWeight: 600, color: colors.text, fontSize: 14 }}>{d.name}</div>
                      {!!d.address && <div style={{ fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>{d.address}</div>}
                    </div>
                    <button type="button" className="ft-icon-btn" aria-label={`Add ${d.name}`} onClick={() => handleAddDealer(d)}>
                      <Plus size={15} color={colors.primary} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmationModal
        open={!!discardConfirm}
        title="Discard unsaved changes?"
        message="This visit plan has unsaved reordering/add/remove edits. Switching now will discard them."
        confirmLabel="Discard changes"
        danger
        onConfirm={confirmDiscard}
        onCancel={() => setDiscardConfirm(null)}
      />

      <ConfirmationModal
        open={removeConfirmDealerId != null}
        title="Remove this dealer from the plan?"
        message={removeConfirmDealer ? `${removeConfirmDealer.dealer_name} will be removed from this rep's visit plan. This isn't saved until you click "Save changes".` : ''}
        confirmLabel="Remove"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setRemoveConfirmDealerId(null)}
      />
    </div>
  );
}

const styles = {
  errorBanner: { backgroundColor: colors.dangerLight, color: colors.dangerDark, border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', marginBottom: spacing.lg, fontSize: 14 },
  successBanner: { backgroundColor: colors.successLight, color: colors.successDark, border: '1px solid #A7F3D0', borderRadius: 10, padding: '12px 16px', marginBottom: spacing.lg, fontSize: 14 },
  filterRow: { display: 'flex', gap: spacing.md, marginBottom: spacing.xl, flexWrap: 'wrap' },
  splitGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: spacing.lg, alignItems: 'start' },
  panel: { padding: spacing.lg },
  panelTitle: { ...typography.cardTitle, fontSize: 15, color: colors.text, margin: `0 0 ${spacing.md}px` },
  row: {
    display: 'flex', alignItems: 'center', gap: spacing.sm, padding: '10px 8px',
    borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.card,
  },
  dragHandle: { width: 28, height: 28, cursor: 'grab', flexShrink: 0 },
  orderBadge: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.primaryLight, color: colors.primary,
    fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  rowText: { flex: 1, minWidth: 0 },
  statusPill: { fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 999, flexShrink: 0 },
  rowActions: { display: 'flex', gap: 4, flexShrink: 0 },
  moveBtn: { width: 28, height: 28 },
  availableList: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 480, overflowY: 'auto' },
  availableRow: {
    display: 'flex', alignItems: 'center', gap: spacing.sm, padding: '10px 12px',
    borderRadius: 10, border: `1px solid ${colors.border}`,
  },
};
