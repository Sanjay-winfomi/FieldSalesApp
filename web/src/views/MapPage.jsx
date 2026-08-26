import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, MarkerF, InfoWindowF, useJsApiLoader } from '@react-google-maps/api';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { apiClient } from '../api';
import { colors, typography, spacing, radius, shadows } from '../theme';

const MAP_CONTAINER_STYLE = { width: '100%', height: '100%', minHeight: 520 };

// Fallback center (India) used only until markers arrive and fitBounds takes over.
const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 };

const DEALER_ICON = {
  path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z',
  fillColor: '#15803D',
  fillOpacity: 1,
  strokeColor: '#FFFFFF',
  strokeWeight: 1.5,
  scale: 1.4,
  anchor: { x: 12, y: 22 },
};

const REP_ICON = {
  path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z',
  fillColor: '#F59E0B',
  fillOpacity: 1,
  strokeColor: '#FFFFFF',
  strokeWeight: 1.5,
  scale: 1.4,
  anchor: { x: 12, y: 22 },
};

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

/**
 * Manager map view — every dealer plotted at its saved location, every rep
 * plotted at their last known location (latest visit today, falling back to
 * today's login point). Hovering a dealer pin shows who last visited it and
 * when; hovering a rep pin shows their last dealer visit and next assigned
 * dealer (if any). Reps with no location for today simply don't get a pin.
 */
export default function MapPage() {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'fieldtrack-google-maps',
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
  });

  const [dealers, setDealers] = useState([]);
  const [reps, setReps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hovered, setHovered] = useState(null); // { type: 'dealer' | 'rep', item }

  const mapRef = useRef(null);
  const boundsFitRef = useRef(false);

  const fetchMapData = () => {
    setLoading(true);
    setError('');
    apiClient.get('/dashboard/map')
      .then((res) => {
        setDealers(res.data.dealers || []);
        setReps(res.data.reps || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load map data.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchMapData();
  }, []);

  // Fit the map to every marker once, the first time markers arrive — refetches
  // (via the refresh button) don't re-fit, so the manager's chosen pan/zoom
  // doesn't get yanked out from under them every 30s-equivalent reload.
  useEffect(() => {
    if (boundsFitRef.current) return;
    if (!mapRef.current || !window.google) return;
    const points = [
      ...dealers.map((d) => ({ lat: d.latitude, lng: d.longitude })),
      ...reps.map((r) => ({ lat: r.latitude, lng: r.longitude })),
    ];
    if (points.length === 0) return;
    const bounds = new window.google.maps.LatLngBounds();
    points.forEach((p) => bounds.extend(p));
    mapRef.current.fitBounds(bounds, 60);
    boundsFitRef.current = true;
  }, [dealers, reps]);

  const center = useMemo(() => {
    const first = dealers[0] || reps[0];
    return first ? { lat: first.latitude, lng: first.longitude } : DEFAULT_CENTER;
  }, [dealers, reps]);

  return (
    <div style={styles.page} className="ft-page">
      <div style={styles.headerRow}>
        <div>
          <h1 style={styles.title}>Dealer &amp; Rep Map</h1>
          <p style={styles.subtitle}>{dealers.length} dealers &middot; {reps.length} reps with a known location</p>
        </div>
        <button type="button" style={styles.refreshBtn} onClick={fetchMapData} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'ft-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div style={styles.errorBanner}>
          <AlertTriangle size={16} style={{ marginRight: 8, flexShrink: 0 }} />
          {error}
        </div>
      )}

      <div style={styles.mapCard}>
        {loadError ? (
          <div style={styles.mapPlaceholder}>Map failed to load — check NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.</div>
        ) : !isLoaded ? (
          <div style={styles.mapPlaceholder}>Loading map...</div>
        ) : (
          <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            center={center}
            zoom={11}
            onLoad={(map) => { mapRef.current = map; }}
            options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: true }}
          >
            {dealers.map((dealer) => (
              <MarkerF
                key={`dealer-${dealer.id}`}
                position={{ lat: dealer.latitude, lng: dealer.longitude }}
                icon={DEALER_ICON}
                onMouseOver={() => setHovered({ type: 'dealer', item: dealer })}
                onMouseOut={() => setHovered((h) => (h?.type === 'dealer' && h.item.id === dealer.id ? null : h))}
              >
                {hovered?.type === 'dealer' && hovered.item.id === dealer.id && (
                  <InfoWindowF
                    position={{ lat: dealer.latitude, lng: dealer.longitude }}
                    onCloseClick={() => setHovered(null)}
                  >
                    <div style={styles.infoBox}>
                      <div style={styles.infoTitle}>{dealer.name}</div>
                      {dealer.address && <div style={styles.infoMuted}>{dealer.address}</div>}
                      {dealer.last_visit ? (
                        <div style={styles.infoSection}>
                          <div style={styles.infoLabel}>Last visited by</div>
                          <div style={styles.infoValue}>{dealer.last_visit.rep_name}</div>
                          <div style={styles.infoMuted}>{formatDateTime(dealer.last_visit.login_time)}</div>
                        </div>
                      ) : (
                        <div style={styles.infoSection}>
                          <div style={styles.infoMuted}>No visits recorded yet</div>
                        </div>
                      )}
                    </div>
                  </InfoWindowF>
                )}
              </MarkerF>
            ))}

            {reps.map((rep) => (
              <MarkerF
                key={`rep-${rep.id}`}
                position={{ lat: rep.latitude, lng: rep.longitude }}
                icon={REP_ICON}
                onMouseOver={() => setHovered({ type: 'rep', item: rep })}
                onMouseOut={() => setHovered((h) => (h?.type === 'rep' && h.item.id === rep.id ? null : h))}
              >
                {hovered?.type === 'rep' && hovered.item.id === rep.id && (
                  <InfoWindowF
                    position={{ lat: rep.latitude, lng: rep.longitude }}
                    onCloseClick={() => setHovered(null)}
                  >
                    <div style={styles.infoBox}>
                      <div style={styles.infoTitle}>{rep.name}</div>
                      {rep.region && <div style={styles.infoMuted}>{rep.region}</div>}

                      <div style={styles.infoSection}>
                        <div style={styles.infoLabel}>Last dealer visit</div>
                        {rep.last_dealer ? (
                          <>
                            <div style={styles.infoValue}>{rep.last_dealer.name}</div>
                            <div style={styles.infoMuted}>{formatDateTime(rep.last_dealer.visit_time)}</div>
                          </>
                        ) : (
                          <div style={styles.infoMuted}>No visits yet today</div>
                        )}
                      </div>

                      <div style={styles.infoSection}>
                        <div style={styles.infoLabel}>Next assigned dealer</div>
                        {rep.next_assignment ? (
                          <div style={styles.infoValue}>{rep.next_assignment.dealer_name}</div>
                        ) : (
                          <div style={styles.infoMuted}>None assigned</div>
                        )}
                      </div>
                    </div>
                  </InfoWindowF>
                )}
              </MarkerF>
            ))}
          </GoogleMap>
        )}
      </div>

      <div style={styles.legendRow}>
        <div style={styles.legendItem}><span style={{ ...styles.legendDot, backgroundColor: '#15803D' }} /> Dealer</div>
        <div style={styles.legendItem}><span style={{ ...styles.legendDot, backgroundColor: '#F59E0B' }} /> Rep</div>
      </div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: spacing.lg, padding: spacing.xxl },
  headerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.md },
  title: { ...typography.dashboardTitle, color: colors.text, margin: 0 },
  subtitle: { ...typography.body, color: colors.textSecondary, margin: '4px 0 0' },
  refreshBtn: {
    display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: radius.md,
    border: `1px solid ${colors.border}`, backgroundColor: colors.card, color: colors.text,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  errorBanner: {
    display: 'flex', alignItems: 'center', padding: '12px 16px', borderRadius: radius.md,
    backgroundColor: colors.dangerLight, color: colors.dangerDark, fontSize: 13, fontWeight: 500,
  },
  mapCard: {
    borderRadius: radius.card, border: `1px solid ${colors.border}`, boxShadow: shadows.card,
    overflow: 'hidden', backgroundColor: colors.card, minHeight: 520,
  },
  mapPlaceholder: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', height: 520,
    color: colors.textMuted, fontSize: 14,
  },
  legendRow: { display: 'flex', gap: spacing.lg },
  legendItem: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: colors.textSecondary, fontWeight: 500 },
  legendDot: { width: 10, height: 10, borderRadius: 5, display: 'inline-block' },
  infoBox: { minWidth: 180, maxWidth: 240, fontFamily: 'inherit' },
  infoTitle: { fontSize: 14, fontWeight: 700, color: '#1F2937' },
  infoMuted: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  infoSection: { marginTop: 8, paddingTop: 8, borderTop: '1px solid #E5E7EB' },
  infoLabel: { fontSize: 11, fontWeight: 600, color: '#5C6B63', textTransform: 'uppercase', letterSpacing: 0.3 },
  infoValue: { fontSize: 13, fontWeight: 600, color: '#1F2937', marginTop: 2 },
};
