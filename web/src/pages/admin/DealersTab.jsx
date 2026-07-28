import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Store, MapPin, Pencil, Trash2 } from 'lucide-react';
import { apiClient } from '../../api';
import LocationPreviewMap from '../../components/LocationPreviewMap';
import {
  SectionHeader, MetricCard, SearchBar, DataTable, Button, Modal, TextField, EmptyState, ConfirmationModal,
} from '../../components';
import { colors, spacing, shadows } from '../../theme';

export default function DealersTab() {
  const [dealers, setDealers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: '', address: '', latitude: '', longitude: '', contact_person: '', contact_phone: '', radius_meters: '200' });
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeStatus, setGeocodeStatus] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [radiusMeters, setRadiusMeters] = useState(100);
  const [pinAddress, setPinAddress] = useState('');
  const [resolvingPin, setResolvingPin] = useState(false);
  const [nearbyPlaces, setNearbyPlaces] = useState([]);
  const [loadingNearby, setLoadingNearby] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  // Live "type-ahead" address suggestions (Google-Maps-search-box style),
  // separate from the manual "Look up coordinates" button/candidates flow
  // below — this fires as the manager types, that fires on an explicit click.
  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const addressDebounceRef = useRef(null);
  // One token per address search, shared across every autocomplete keystroke
  // and the final place-details call — this is what makes Google bill the
  // whole search as one cheaper "session" instead of separate calls.
  const sessionTokenRef = useRef(null);
  const newSessionToken = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

  const fetchDealers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/dealers');
      setDealers(res.data.dealers);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load dealers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDealers(); }, [fetchDealers]);

  useEffect(() => {
    apiClient.get('/config').then((res) => setRadiusMeters(res.data.checkinRadiusMeters)).catch(() => {});
  }, []);

  const filteredDealers = useMemo(() => {
    if (!searchQuery.trim()) return dealers;
    const q = searchQuery.toLowerCase();
    return dealers.filter((d) => d.name.toLowerCase().includes(q) || (d.address || '').toLowerCase().includes(q));
  }, [dealers, searchQuery]);

  const resetForm = () => {
    setForm({ name: '', address: '', latitude: '', longitude: '', contact_person: '', contact_phone: '', radius_meters: '200' });
    setEditingId(null);
    setShowForm(false);
    setFormError('');
    setGeocodeStatus('');
    setCandidates([]);
    setPinAddress('');
    setNearbyPlaces([]);
    setAddressSuggestions([]);
    clearTimeout(addressDebounceRef.current);
    sessionTokenRef.current = null;
  };

  // Fires on every keystroke in the Address field — debounced so a burst of
  // typing sends one request, not one per character, and skips the call
  // entirely below 3 characters (too short for Google to return anything
  // useful, per the backend's own guard).
  const handleAddressChange = (value) => {
    setForm((f) => ({ ...f, address: value }));
    clearTimeout(addressDebounceRef.current);

    if (value.trim().length < 3) {
      setAddressSuggestions([]);
      return;
    }
    if (!sessionTokenRef.current) sessionTokenRef.current = newSessionToken();

    addressDebounceRef.current = setTimeout(async () => {
      setSuggestionsLoading(true);
      try {
        const res = await apiClient.get('/geocode/autocomplete', {
          params: { input: value, sessiontoken: sessionTokenRef.current },
        });
        setAddressSuggestions(res.data.predictions || []);
      } catch {
        setAddressSuggestions([]);
      } finally {
        setSuggestionsLoading(false);
      }
    }, 300);
  };

  const handleSelectSuggestion = async (prediction) => {
    setAddressSuggestions([]);
    setGeocodeStatus('');
    try {
      const res = await apiClient.get('/geocode/place-details', {
        params: { place_id: prediction.place_id, sessiontoken: sessionTokenRef.current },
      });
      const { latitude, longitude, display_name } = res.data;
      setForm((f) => ({ ...f, address: display_name, latitude: String(latitude), longitude: String(longitude) }));
      setPinAddress(display_name);
      fetchNearby(latitude, longitude);
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to load details for that address.');
    } finally {
      // A session ends once a place is chosen — the next address search (if
      // any) should start (and bill) as a fresh session, not continue this one.
      sessionTokenRef.current = null;
    }
  };

  // Standard map tiles only show a name for places that happen to be
  // labelled — most ordinary buildings aren't, so this looks up real nearby
  // named places (shops, cafes, landmarks) via Google Places instead, letting
  // the manager click a recognizable one to snap the pin exactly onto it.
  const fetchNearby = async (lat, lng) => {
    setLoadingNearby(true);
    try {
      const res = await apiClient.get('/geocode/nearby', { params: { lat, lng } });
      setNearbyPlaces(res.data.places || []);
    } catch {
      setNearbyPlaces([]);
    } finally {
      setLoadingNearby(false);
    }
  };

  // Fires on every drag/click on the map preview — keeps the shown address
  // in sync with wherever the pin *actually* is now, instead of leaving the
  // stale text from the original address search behind after fine-tuning.
  const handlePinMoved = async (lat, lng) => {
    setForm((f) => ({ ...f, latitude: String(lat), longitude: String(lng) }));
    setResolvingPin(true);
    try {
      const res = await apiClient.get('/geocode/reverse', { params: { lat, lng } });
      setPinAddress(res.data.address);
      // Keep the Address input itself in sync with the pin — otherwise it's
      // left showing whatever was originally typed/searched, which drifts
      // from reality the moment the pin gets dragged or clicked elsewhere.
      setForm((f) => ({ ...f, address: res.data.address }));
    } catch {
      setPinAddress('');
    } finally {
      setResolvingPin(false);
    }
    fetchNearby(lat, lng);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    // parseFloat("abc") is NaN, and JSON.stringify(NaN) silently serializes as
    // null — a typo in these fields would otherwise be swallowed with no
    // warning instead of blocking the save.
    const latitude = form.latitude ? parseFloat(form.latitude) : null;
    const longitude = form.longitude ? parseFloat(form.longitude) : null;
    if (form.latitude && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
      setFormError('Latitude must be a number between -90 and 90.');
      return;
    }
    if (form.longitude && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
      setFormError('Longitude must be a number between -180 and 180.');
      return;
    }
    const dealerRadiusMeters = form.radius_meters ? parseInt(form.radius_meters, 10) : null;
    if (form.radius_meters && (!Number.isFinite(dealerRadiusMeters) || dealerRadiusMeters <= 0)) {
      setFormError('Radius must be a positive whole number of metres.');
      return;
    }

    const payload = { ...form, latitude, longitude, radius_meters: dealerRadiusMeters };
    setSubmitting(true);
    try {
      if (editingId) {
        await apiClient.put(`/dealers/${editingId}`, payload);
      } else {
        await apiClient.post('/dealers', payload);
      }
      resetForm();
      fetchDealers();
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to save dealer.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLookupCoordinates = async () => {
    if (!form.address.trim()) {
      setGeocodeStatus('Enter an address first.');
      return;
    }
    setGeocoding(true);
    setGeocodeStatus('');
    setCandidates([]);
    try {
      const res = await apiClient.get('/geocode/search', { params: { q: form.address } });
      if (res.data.found && res.data.candidates.length === 1) {
        const only = res.data.candidates[0];
        setForm((f) => ({ ...f, latitude: String(only.latitude), longitude: String(only.longitude), address: only.display_name }));
        setPinAddress(only.display_name);
        setGeocodeStatus('Found a match — drag the pin below to fine-tune if needed.');
        fetchNearby(only.latitude, only.longitude);
      } else if (res.data.found) {
        // More than one match (e.g. same name in different cities) — let the
        // manager pick rather than silently filling in a potentially wrong one.
        setCandidates(res.data.candidates);
        setGeocodeStatus(`${res.data.candidates.length} matches found — pick the correct one below.`);
      } else {
        setGeocodeStatus('No match found for that address — enter coordinates manually.');
      }
    } catch (err) {
      setGeocodeStatus(err.response?.data?.error || 'Lookup failed — enter coordinates manually.');
    } finally {
      setGeocoding(false);
    }
  };

  const handleSelectCandidate = (candidate) => {
    setForm((f) => ({ ...f, latitude: String(candidate.latitude), longitude: String(candidate.longitude), address: candidate.display_name }));
    setPinAddress(candidate.display_name);
    setGeocodeStatus('Selected — drag the pin below to fine-tune if needed.');
    setCandidates([]);
    fetchNearby(candidate.latitude, candidate.longitude);
  };

  const handleSelectNearby = (place) => {
    handlePinMoved(place.latitude, place.longitude);
  };

  const confirmDelete = async () => {
    setDeleteSubmitting(true);
    try {
      await apiClient.delete(`/dealers/${deleteTarget.id}`);
      setDeleteTarget(null);
      fetchDealers();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete dealer.');
      setDeleteTarget(null);
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const startEdit = (dealer) => {
    setForm({
      name: dealer.name,
      address: dealer.address || '',
      latitude: dealer.latitude ?? '',
      longitude: dealer.longitude ?? '',
      contact_person: dealer.contact_person || '',
      contact_phone: dealer.contact_phone || '',
      radius_meters: dealer.radius_meters != null ? String(dealer.radius_meters) : '200',
    });
    setEditingId(dealer.id);
    setFormError('');
    setShowForm(true);
    setPinAddress('');
    if (dealer.latitude != null && dealer.longitude != null) {
      handlePinMoved(dealer.latitude, dealer.longitude);
    }
  };

  const columns = [
    { key: 'name', label: 'Dealer', sortable: true, render: (d) => <span style={{ fontWeight: 600, color: colors.text }}>{d.name}</span> },
    { key: 'address', label: 'Address', sortable: true, render: (d) => d.address || '—' },
    {
      key: 'coordinates', label: 'Coordinates', sortable: false,
      render: (d) => d.latitude != null ? `${d.latitude.toFixed(4)}, ${d.longitude.toFixed(4)}` : '—',
    },
    {
      key: 'contact', label: 'Contact', sortable: false,
      render: (d) => d.contact_person ? `${d.contact_person} (${d.contact_phone || '—'})` : '—',
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (d) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="ft-icon-btn" style={{ width: 32, height: 32 }} title="Edit" aria-label={`Edit ${d.name}`} onClick={() => startEdit(d)}>
            <Pencil size={14} />
          </button>
          <button className="ft-icon-btn" style={{ width: 32, height: 32 }} title="Delete" aria-label={`Delete ${d.name}`} onClick={() => setDeleteTarget(d)}>
            <Trash2 size={14} color={colors.danger} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <SectionHeader
        title="Dealers"
        subtitle="Manage dealer locations and check-in geofences"
        action={<Button icon={<Store size={15} />} onClick={() => { resetForm(); setShowForm(true); }} fullWidthMobile>Add dealer</Button>}
      />

      <div style={styles.metricsGrid}>
        <MetricCard icon={<Store />} value={dealers.length} label="Total dealers" tone="primary" />
      </div>

      {error && <div style={styles.errorBanner} role="alert">{error}</div>}

      <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search by name or address" style={{ marginBottom: spacing.lg, maxWidth: 360 }} />

      <div className="ft-card" style={{ overflow: 'hidden' }}>
        {!loading && dealers.length === 0 && !error ? (
          <EmptyState title="No dealers yet" subtitle="Dealers you add will appear here." />
        ) : (
          <DataTable columns={columns} rows={filteredDealers} loading={loading} emptyTitle="No dealers match your search" />
        )}
      </div>

      <Modal
        open={showForm}
        title={editingId ? 'Edit dealer' : 'Add dealer'}
        subtitle={editingId ? `Dealer #${editingId}` : 'Look up an address or drop a pin manually'}
        onClose={resetForm}
        width={560}
      >
        <form onSubmit={handleSubmit}>
          {/* Full width, not one of the narrow formGrid columns below — a real
              address wraps to 3+ cramped lines in a ~160px column, which reads
              as an unreadable jumble once suggestions are involved. */}
          <div style={{ position: 'relative', marginBottom: spacing.md }} onBlur={() => setTimeout(() => setAddressSuggestions([]), 150)}>
            <TextField
              label="Address"
              value={form.address}
              onChange={handleAddressChange}
              autoComplete="off"
            />
            {(addressSuggestions.length > 0 || suggestionsLoading) && (
              <div style={styles.suggestionsDropdown}>
                {suggestionsLoading && addressSuggestions.length === 0 ? (
                  <div style={styles.suggestionLoading}>Searching...</div>
                ) : (
                  addressSuggestions.map((s) => (
                    <button
                      type="button"
                      key={s.place_id}
                      style={styles.suggestionItem}
                      onMouseDown={(e) => { e.preventDefault(); handleSelectSuggestion(s); }}
                    >
                      {s.description}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div style={styles.formGrid}>
            <TextField label="Dealer name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
            <TextField label="Latitude" value={form.latitude} onChange={(v) => setForm({ ...form, latitude: v })} />
            <TextField label="Longitude" value={form.longitude} onChange={(v) => setForm({ ...form, longitude: v })} />
            <TextField label="Radius (metres)" type="number" value={form.radius_meters} onChange={(v) => setForm({ ...form, radius_meters: v })} />
            <TextField label="Contact person" value={form.contact_person} onChange={(v) => setForm({ ...form, contact_person: v })} />
            <TextField label="Contact phone" value={form.contact_phone} onChange={(v) => setForm({ ...form, contact_phone: v })} />
          </div>

          <Button
            type="button"
            variant="secondary"
            icon={<MapPin size={14} />}
            onClick={handleLookupCoordinates}
            loading={geocoding}
            style={{ width: '100%', marginBottom: spacing.sm }}
          >
            Look up coordinates from address (Google Maps)
          </Button>
          {geocodeStatus && <p style={styles.geocodeStatus}>{geocodeStatus}</p>}

          {candidates.length > 0 && (
            <div style={styles.candidateList}>
              {candidates.map((c, i) => (
                <button type="button" key={i} style={styles.candidateItem} onClick={() => handleSelectCandidate(c)}>
                  {c.display_name}
                </button>
              ))}
            </div>
          )}

          {form.latitude && form.longitude && !Number.isNaN(parseFloat(form.latitude)) && !Number.isNaN(parseFloat(form.longitude)) && (
            <div style={{ marginBottom: spacing.md }}>
              <LocationPreviewMap
                latitude={parseFloat(form.latitude)}
                longitude={parseFloat(form.longitude)}
                radiusMeters={form.radius_meters ? parseInt(form.radius_meters, 10) : radiusMeters}
                onLocationChange={handlePinMoved}
              />
              <p style={styles.pinAddressText}>
                📍 {resolvingPin ? 'Resolving address...' : (pinAddress || 'Move the pin to see its address here')}
              </p>
              <p style={styles.mapPreviewCaption}>
                Drag the pin or click anywhere on the map to fine-tune the exact spot — the address search only gets you to the
                neighbourhood. Switch to satellite view to recognize the building by sight, or zoom in with +/- or your scroll
                wheel. Check-in radius: {form.radius_meters || radiusMeters}m (shown in green) — reps checking in/out from
                outside this circle must enter a justification.
              </p>

              {loadingNearby && <p style={styles.geocodeStatus}>Looking for nearby named places...</p>}
              {!loadingNearby && nearbyPlaces.length > 0 && (
                <div>
                  <p style={styles.geocodeStatus}>Nearby named places — click one to snap the pin onto it:</p>
                  <div style={styles.candidateList}>
                    {nearbyPlaces.map((p, i) => (
                      <button type="button" key={i} style={styles.candidateItem} onClick={() => handleSelectNearby(p)}>
                        {p.name} <span style={{ color: colors.textMuted }}>({p.type})</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {formError && <p style={styles.formError}>{formError}</p>}

          <div style={styles.formActions}>
            <Button type="button" variant="secondary" onClick={resetForm}>Cancel</Button>
            <Button type="submit" loading={submitting}>{editingId ? 'Save changes' : 'Create dealer'}</Button>
          </div>
        </form>
      </Modal>

      <ConfirmationModal
        open={!!deleteTarget}
        title="Delete dealer?"
        message={`This permanently removes ${deleteTarget?.name}. Dealers with recorded visits can't be deleted — edit the record instead if it's no longer active.`}
        confirmLabel="Delete"
        danger
        loading={deleteSubmitting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

const styles = {
  metricsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: spacing.lg, marginBottom: spacing.xl },
  errorBanner: { backgroundColor: colors.dangerLight, color: colors.dangerDark, border: '1px solid #FECACA', borderRadius: 10, padding: '12px 16px', marginBottom: spacing.lg, fontSize: 14 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: spacing.md, marginBottom: spacing.lg },
  geocodeStatus: { fontSize: 12, color: colors.textSecondary, margin: '0 0 12px' },
  candidateList: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: spacing.md },
  candidateItem: { textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, backgroundColor: colors.card, color: colors.text, fontSize: 13, cursor: 'pointer', width: '100%' },
  suggestionsDropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 20,
    backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: 10,
    boxShadow: shadows.dropdown, maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column',
  },
  suggestionItem: {
    display: 'block', textAlign: 'left', padding: '12px 14px', border: 'none', borderBottom: `1px solid ${colors.border}`,
    backgroundColor: 'transparent', color: colors.text, fontSize: 13, lineHeight: 1.5, cursor: 'pointer', width: '100%',
  },
  suggestionLoading: { padding: '10px 12px', fontSize: 13, color: colors.textMuted },
  pinAddressText: { fontSize: 13, fontWeight: 600, color: colors.text, margin: '8px 0 0' },
  mapPreviewCaption: { fontSize: 12, color: colors.textSecondary, margin: '4px 0 0' },
  formError: { fontSize: 13, color: colors.danger, margin: `${spacing.md}px 0` },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: spacing.md },
};
