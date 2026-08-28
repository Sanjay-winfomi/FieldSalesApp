import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, MarkerF, InfoWindowF, useJsApiLoader } from '@react-google-maps/api';
import { AlertTriangle, RefreshCw, Search, MapPin, User, X } from 'lucide-react';
import { apiClient } from '../api';
import { colors, typography, spacing, radius, shadows } from '../theme';

const MAP_CONTAINER_STYLE = { width: '100%', height: '100%', minHeight: 520 };

// Fallback center (India) used only until markers arrive and fitBounds takes over.
const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 };

// Classic corkboard-pushpin look — a glossy ball head on a metal needle,
// tip pointing at the exact coordinate — same shape for both, color-coded
// (red = rep, yellow = dealer) so they're unmistakable from a distance and
// don't rely on shape alone.
const DEALER_COLOR = { light: '#FFE066', dark: '#D69E00' }; // yellow
const REP_COLOR = { light: '#FF6B6B', dark: '#C11919' }; // red
// Flat solid shades of the same two colors, for UI accents (search
// suggestions, legend swatch) that aren't rendered as a gradient pin.
const DEALER_SOLID = '#D69E00';
const REP_SOLID = '#DC2626';

const PIN_WIDTH = 30;
const PIN_HEIGHT = 52;
const PIN_HEAD_CENTER_Y = 17;
const PIN_HEAD_RADIUS = 14;

function pushpinSvgDataUri({ light, dark }) {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_WIDTH}" height="${PIN_HEIGHT}" viewBox="0 0 ${PIN_WIDTH} ${PIN_HEIGHT}">
  <defs>
    <radialGradient id="head" cx="34%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="30%" stop-color="${light}"/>
      <stop offset="100%" stop-color="${dark}"/>
    </radialGradient>
    <linearGradient id="needle" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#f2f2f2"/>
      <stop offset="45%" stop-color="#a8a8a8"/>
      <stop offset="100%" stop-color="#5f5f5f"/>
    </linearGradient>
  </defs>
  <line x1="${PIN_WIDTH / 2}" y1="${PIN_HEAD_CENTER_Y + PIN_HEAD_RADIUS - 4}" x2="${PIN_WIDTH / 2}" y2="${PIN_HEIGHT - 2}"
        stroke="url(#needle)" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="${PIN_WIDTH / 2}" cy="${PIN_HEAD_CENTER_Y}" r="${PIN_HEAD_RADIUS}"
          fill="url(#head)" stroke="${dark}" stroke-width="1"/>
</svg>`.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const DEALER_PIN_URL = pushpinSvgDataUri(DEALER_COLOR);
const REP_PIN_URL = pushpinSvgDataUri(REP_COLOR);

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

  // google.maps.Size/Point only exist once the Maps script has loaded, so
  // these icon objects (needed to anchor the pin's needle tip, not its
  // top-left corner, to the actual coordinate) are built here rather than
  // as module-level constants.
  const dealerIcon = useMemo(() => {
    if (!isLoaded || !window.google) return undefined;
    return {
      url: DEALER_PIN_URL,
      scaledSize: new window.google.maps.Size(PIN_WIDTH, PIN_HEIGHT),
      anchor: new window.google.maps.Point(PIN_WIDTH / 2, PIN_HEIGHT - 2),
    };
  }, [isLoaded]);
  const repIcon = useMemo(() => {
    if (!isLoaded || !window.google) return undefined;
    return {
      url: REP_PIN_URL,
      scaledSize: new window.google.maps.Size(PIN_WIDTH, PIN_HEIGHT),
      anchor: new window.google.maps.Point(PIN_WIDTH / 2, PIN_HEIGHT - 2),
    };
  }, [isLoaded]);

  const [dealers, setDealers] = useState([]);
  const [reps, setReps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(null); // { type: 'dealer' | 'rep', item }
  const [search, setSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const mapRef = useRef(null);
  const boundsFitRef = useRef(false);
  const searchBoxRef = useRef(null);

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

  // Close the suggestions dropdown on an outside click.
  useEffect(() => {
    const onClickOutside = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) setShowSuggestions(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const dealerMatches = dealers
      .filter((d) => d.name?.toLowerCase().includes(q))
      .map((d) => ({ type: 'dealer', item: d }));
    const repMatches = reps
      .filter((r) => r.name?.toLowerCase().includes(q))
      .map((r) => ({ type: 'rep', item: r }));
    return [...dealerMatches, ...repMatches].slice(0, 20);
  }, [search, dealers, reps]);

  const jumpToMarker = (type, item) => {
    setActive({ type, item });
    setSearch(item.name);
    setShowSuggestions(false);
    if (mapRef.current) {
      mapRef.current.panTo({ lat: item.latitude, lng: item.longitude });
      mapRef.current.setZoom(16);
    }
  };

  return (
    <div style={styles.page} className="ft-page">
      <div style={styles.headerRow}>
        <div>
          <h1 style={styles.title}>Dealer &amp; Rep Map</h1>
          <p style={styles.subtitle}>{dealers.length} dealers &middot; {reps.length} reps with a known location</p>
        </div>
        <div style={styles.searchBox} ref={searchBoxRef}>
          <Search size={16} color={colors.textMuted} style={styles.searchIcon} />
          <input
            type="text"
            className="ft-input"
            style={styles.searchInput}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={(e) => { if (e.key === 'Enter' && matches.length > 0) jumpToMarker(matches[0].type, matches[0].item); }}
            placeholder="Search dealer or rep name..."
            aria-label="Search dealer or rep"
          />
          {!!search && (
            <button
              type="button"
              onClick={() => { setSearch(''); setShowSuggestions(false); }}
              aria-label="Clear search"
              style={styles.searchClearBtn}
            >
              <X size={16} />
            </button>
          )}

          {showSuggestions && search.trim() && (
            <div style={styles.suggestions}>
              {matches.length === 0 ? (
                <div style={styles.suggestionEmpty}>No dealer or rep matches "{search}"</div>
              ) : (
                matches.map(({ type, item }) => (
                  <button
                    key={`${type}-${item.id}`}
                    type="button"
                    style={styles.suggestionItem}
                    onClick={() => jumpToMarker(type, item)}
                  >
                    {type === 'dealer' ? <MapPin size={14} color={DEALER_SOLID} /> : <User size={14} color={REP_SOLID} />}
                    <span style={styles.suggestionName}>{item.name}</span>
                    <span style={styles.suggestionMeta}>{type === 'dealer' ? item.address : item.region}</span>
                  </button>
                ))
              )}
            </div>
          )}
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

      <div style={styles.mapRow}>
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
                icon={dealerIcon}
                zIndex={1}
                onMouseOver={() => setActive({ type: 'dealer', item: dealer })}
                onMouseOut={() => setActive((h) => (h?.type === 'dealer' && h.item.id === dealer.id ? null : h))}
                onClick={() => setActive({ type: 'dealer', item: dealer })}
              >
                {active?.type === 'dealer' && active.item.id === dealer.id && (
                  <InfoWindowF
                    position={{ lat: dealer.latitude, lng: dealer.longitude }}
                    onCloseClick={() => setActive(null)}
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
                icon={repIcon}
                zIndex={2}
                onMouseOver={() => setActive({ type: 'rep', item: rep })}
                onMouseOut={() => setActive((h) => (h?.type === 'rep' && h.item.id === rep.id ? null : h))}
                onClick={() => setActive({ type: 'rep', item: rep })}
              >
                {active?.type === 'rep' && active.item.id === rep.id && (
                  <InfoWindowF
                    position={{ lat: rep.latitude, lng: rep.longitude }}
                    onCloseClick={() => setActive(null)}
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

        <div style={styles.legendBox}>
          <div style={styles.legendTitle}>Legend</div>
          <div style={styles.legendItem}>
            <img src={REP_PIN_URL} alt="" width={18} height={31} style={styles.legendSwatch} />
            <span>Rep</span>
          </div>
          <div style={styles.legendItem}>
            <img src={DEALER_PIN_URL} alt="" width={18} height={31} style={styles.legendSwatch} />
            <span>Dealer</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: spacing.lg, padding: spacing.xxl },
  headerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.md },
  title: { ...typography.dashboardTitle, color: colors.text, margin: 0 },
  subtitle: { ...typography.body, color: colors.textSecondary, margin: '4px 0 0' },
  searchBox: { position: 'relative', flex: '1 1 320px', maxWidth: 420, marginLeft: 'auto' },
  searchIcon: { position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' },
  searchInput: { paddingLeft: 38, paddingRight: 34, width: '100%' },
  searchClearBtn: {
    position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', display: 'flex', color: colors.textMuted, padding: 4, cursor: 'pointer',
  },
  suggestions: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, maxHeight: 320, overflowY: 'auto',
    backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: radius.md,
    boxShadow: shadows.dropdown, zIndex: 50,
  },
  suggestionEmpty: { padding: '14px 16px', fontSize: 13, color: colors.textMuted },
  suggestionItem: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px', border: 'none',
    borderBottom: `1px solid ${colors.border}`, backgroundColor: 'transparent', textAlign: 'left', cursor: 'pointer',
  },
  suggestionName: { fontSize: 13, fontWeight: 600, color: colors.text, flexShrink: 0 },
  suggestionMeta: {
    fontSize: 12, color: colors.textMuted, marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', maxWidth: '55%',
  },
  refreshBtn: {
    display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: radius.md,
    border: `1px solid ${colors.border}`, backgroundColor: colors.card, color: colors.text,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  errorBanner: {
    display: 'flex', alignItems: 'center', padding: '12px 16px', borderRadius: radius.md,
    backgroundColor: colors.dangerLight, color: colors.dangerDark, fontSize: 13, fontWeight: 500,
  },
  mapRow: { display: 'flex', gap: spacing.lg, alignItems: 'stretch', flexWrap: 'wrap' },
  mapCard: {
    flex: '1 1 auto', minWidth: 0, borderRadius: radius.card, border: `1px solid ${colors.border}`,
    boxShadow: shadows.card, overflow: 'hidden', backgroundColor: colors.card, minHeight: 520,
  },
  mapPlaceholder: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', height: 520,
    color: colors.textMuted, fontSize: 14,
  },
  legendBox: {
    flex: '0 0 168px', alignSelf: 'flex-start', display: 'flex', flexDirection: 'column', gap: 10,
    padding: '14px 16px', borderRadius: radius.card, border: `1px solid ${colors.border}`,
    boxShadow: shadows.card, backgroundColor: colors.card,
  },
  legendTitle: {
    fontSize: 11, fontWeight: 700, color: colors.textMuted, textTransform: 'uppercase',
    letterSpacing: 0.4, marginBottom: 2,
  },
  legendItem: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: colors.text, fontWeight: 600 },
  legendSwatch: { flexShrink: 0, display: 'block' },
  infoBox: { minWidth: 180, maxWidth: 240, fontFamily: 'inherit' },
  infoTitle: { fontSize: 14, fontWeight: 700, color: '#1F2937' },
  infoMuted: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  infoSection: { marginTop: 8, paddingTop: 8, borderTop: '1px solid #E5E7EB' },
  infoLabel: { fontSize: 11, fontWeight: 600, color: '#5C6B63', textTransform: 'uppercase', letterSpacing: 0.3 },
  infoValue: { fontSize: 13, fontWeight: 600, color: '#1F2937', marginTop: 2 },
};
