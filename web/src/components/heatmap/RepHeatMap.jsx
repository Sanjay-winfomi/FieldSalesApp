'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  GoogleMap, HeatmapLayer, Marker, InfoWindow, GoogleMarkerClusterer, useJsApiLoader,
} from '@react-google-maps/api';
import { MapPin, Loader2, AlertTriangle } from 'lucide-react';
import { apiClient } from '../../api';
import FilterSelect from '../filters/FilterSelect';
import { colors, typography, spacing, radius } from '../../theme';

// Stable reference required by useJsApiLoader — an inline array literal would
// be a new object every render and trip the hook's "don't change libraries"
// invariant. A distinct loader `id` (rather than reusing LocationPreviewMap's)
// keeps this feature's `visualization` library request independent of any
// other Google Maps consumer in the app.
const MAP_LIBRARIES = ['visualization'];
const LOADER_ID = 'fieldtrack-google-maps-heatmap';

const MAP_CONTAINER_STYLE = { width: '100%', height: '100%' };
const DEFAULT_CENTER = { lat: 11.0168, lng: 76.9558 }; // Coimbatore — sensible fallback before any data loads
const SINGLE_REP_ZOOM = 15;
const SELECTED_REP_ZOOM = 16;

const MARKER_ICON_DEFAULT = 'https://maps.google.com/mapfiles/ms/icons/green-dot.png';
const MARKER_ICON_LOGGED_OUT = 'https://maps.google.com/mapfiles/ms/icons/grey-dot.png';
const MARKER_ICON_SELECTED = 'https://maps.google.com/mapfiles/ms/icons/red-dot.png';

// Steps the map's zoom level one tick at a time toward the target instead of
// jumping straight there — Google Maps only animates panTo natively, zoom
// changes are instant by default, so this fakes the same smoothness for zoom.
function smoothZoomTo(map, targetZoom) {
  const current = map.getZoom();
  if (current === targetZoom) return;
  const next = current < targetZoom ? current + 1 : current - 1;
  const listener = window.google.maps.event.addListenerOnce(map, 'zoom_changed', () => {
    smoothZoomTo(map, targetZoom);
  });
  window.setTimeout(() => {
    window.google.maps.event.removeListener(listener);
    map.setZoom(next);
  }, 90);
}

function formatCoord(value) {
  return typeof value === 'number' ? value.toFixed(5) : 'N/A';
}

/**
 * Manager-only Representative Heat Map — lazily mounted (only once "View
 * Heat Map" is clicked, see DashboardPage), so Google Maps' JS bundle and
 * this component's own data fetch never happen on a normal dashboard visit.
 * Stays mounted after first reveal (parent just toggles this via CSS
 * visibility) so re-opening it never recreates the map instance or re-fires
 * the Maps script load.
 */
export default function RepHeatMap() {
  const { isLoaded, loadError } = useJsApiLoader({
    id: LOADER_ID,
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
    libraries: MAP_LIBRARIES,
  });

  const [reps, setReps] = useState([]);
  const [fetchState, setFetchState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [selectedRepId, setSelectedRepId] = useState('all');
  const [activeInfoRepId, setActiveInfoRepId] = useState(null);

  const mapRef = useRef(null);
  const hasFitBoundsOnceRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    apiClient.get('/dashboard/live-locations')
      .then((res) => {
        if (cancelled) return;
        setReps(res.data.reps || []);
        setFetchState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setFetchState('error');
      });
    return () => { cancelled = true; };
  }, []);

  const heatmapData = useMemo(() => {
    if (!isLoaded || reps.length === 0) return [];
    return reps.map((rep) => new window.google.maps.LatLng(rep.latitude, rep.longitude));
  }, [isLoaded, reps]);

  const fitToAllReps = useCallback((map) => {
    if (reps.length === 0) return;
    if (reps.length === 1) {
      map.setCenter({ lat: reps[0].latitude, lng: reps[0].longitude });
      map.setZoom(SINGLE_REP_ZOOM);
      return;
    }
    const bounds = new window.google.maps.LatLngBounds();
    reps.forEach((rep) => bounds.extend({ lat: rep.latitude, lng: rep.longitude }));
    map.fitBounds(bounds, 60);
  }, [reps]);

  const handleMapLoad = useCallback((map) => {
    mapRef.current = map;
    if (!hasFitBoundsOnceRef.current && reps.length > 0) {
      fitToAllReps(map);
      hasFitBoundsOnceRef.current = true;
    }
  }, [reps, fitToAllReps]);

  // Fit bounds once the reps arrive after the map already finished loading
  // (fetch and script-load race each other, so whichever finishes second
  // needs to trigger the initial framing).
  useEffect(() => {
    if (mapRef.current && !hasFitBoundsOnceRef.current && reps.length > 0) {
      fitToAllReps(mapRef.current);
      hasFitBoundsOnceRef.current = true;
    }
  }, [reps, fitToAllReps]);

  const handleSelectRep = (value) => {
    setSelectedRepId(value);
    const map = mapRef.current;
    if (!map) return;

    if (value === 'all') {
      setActiveInfoRepId(null);
      fitToAllReps(map);
      return;
    }

    const rep = reps.find((r) => String(r.id) === String(value));
    if (!rep) return;
    map.panTo({ lat: rep.latitude, lng: rep.longitude });
    smoothZoomTo(map, SELECTED_REP_ZOOM);
    setActiveInfoRepId(rep.id);
  };

  const activeInfoRep = reps.find((r) => r.id === activeInfoRepId) || null;

  return (
    <div style={styles.wrapper} className="ft-fade-in">
      <div style={styles.controlsRow}>
        <div style={styles.controlsLabel}>
          <MapPin size={14} color={colors.textSecondary} />
          Representative
        </div>
        <FilterSelect
          ariaLabel="Filter representative on heat map"
          value={String(selectedRepId)}
          onChange={handleSelectRep}
          options={[
            { value: 'all', label: 'All' },
            ...reps.map((rep) => ({ value: String(rep.id), label: rep.name })),
          ]}
          style={{ minWidth: 220 }}
        />
      </div>

      <div style={styles.mapShell} className="ft-heatmap-shell">
        {loadError && (
          <div style={styles.statusBox}>
            <AlertTriangle size={22} color={colors.dangerDark} />
            <span style={{ ...typography.body, color: colors.dangerDark, marginTop: 8 }}>
              Unable to load Google Maps.
            </span>
          </div>
        )}

        {!loadError && !isLoaded && (
          <div style={styles.statusBox}>
            <Loader2 size={22} className="ft-spin" color={colors.primary} />
            <span style={{ ...typography.body, color: colors.textSecondary, marginTop: 8 }}>
              Loading Google Maps...
            </span>
          </div>
        )}

        {!loadError && isLoaded && fetchState === 'loading' && (
          <div style={styles.statusBox}>
            <Loader2 size={22} className="ft-spin" color={colors.primary} />
            <span style={{ ...typography.body, color: colors.textSecondary, marginTop: 8 }}>
              Fetching representative locations...
            </span>
          </div>
        )}

        {!loadError && isLoaded && fetchState === 'error' && (
          <div style={styles.statusBox}>
            <AlertTriangle size={22} color={colors.dangerDark} />
            <span style={{ ...typography.body, color: colors.dangerDark, marginTop: 8 }}>
              Could not load representative locations.
            </span>
          </div>
        )}

        {!loadError && isLoaded && fetchState === 'ready' && reps.length === 0 && (
          <div style={styles.statusBox}>
            <MapPin size={22} color={colors.textMuted} />
            <span style={{ ...typography.body, color: colors.textSecondary, marginTop: 8 }}>
              No representative locations available.
            </span>
          </div>
        )}

        {!loadError && isLoaded && fetchState === 'ready' && reps.length > 0 && (
          <GoogleMap
            mapContainerStyle={MAP_CONTAINER_STYLE}
            center={DEFAULT_CENTER}
            zoom={12}
            onLoad={handleMapLoad}
            options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false, clickableIcons: false }}
          >
            <HeatmapLayer data={heatmapData} options={{ radius: 40, opacity: 0.6 }} />

            <GoogleMarkerClusterer options={{}}>
              {(clusterer) => (
                <>
                  {reps.map((rep) => {
                    const isSelected = rep.id === selectedRepId || String(rep.id) === String(selectedRepId);
                    const icon = isSelected
                      ? MARKER_ICON_SELECTED
                      : rep.status === 'Logged Out' ? MARKER_ICON_LOGGED_OUT : MARKER_ICON_DEFAULT;
                    return (
                      <Marker
                        key={rep.id}
                        position={{ lat: rep.latitude, lng: rep.longitude }}
                        clusterer={clusterer}
                        icon={icon}
                        zIndex={isSelected ? 999 : undefined}
                        onClick={() => setActiveInfoRepId(rep.id)}
                      />
                    );
                  })}
                </>
              )}
            </GoogleMarkerClusterer>

            {activeInfoRep && (
              <InfoWindow
                position={{ lat: activeInfoRep.latitude, lng: activeInfoRep.longitude }}
                onCloseClick={() => setActiveInfoRepId(null)}
              >
                <div style={styles.infoWindow}>
                  <div style={styles.infoTitle}>{activeInfoRep.name}</div>
                  <div style={styles.infoRow}><span style={styles.infoLabel}>Dealer</span>{activeInfoRep.dealer || '—'}</div>
                  <div style={styles.infoRow}><span style={styles.infoLabel}>Status</span>{activeInfoRep.status}</div>
                  <div style={styles.infoRow}><span style={styles.infoLabel}>Login time</span>{activeInfoRep.loginTime || '—'}</div>
                  <div style={styles.infoRow}><span style={styles.infoLabel}>Last updated</span>{activeInfoRep.lastUpdated || '—'}</div>
                  <div style={styles.infoRow}><span style={styles.infoLabel}>Latitude</span>{formatCoord(activeInfoRep.latitude)}</div>
                  <div style={styles.infoRow}><span style={styles.infoLabel}>Longitude</span>{formatCoord(activeInfoRep.longitude)}</div>
                </div>
              </InfoWindow>
            )}
          </GoogleMap>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrapper: { marginTop: spacing.xl },
  controlsRow: { display: 'flex', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md, flexWrap: 'wrap' },
  controlsLabel: { display: 'flex', alignItems: 'center', gap: 6, ...typography.bodyMedium, color: colors.textSecondary },
  mapShell: {
    width: '100%', height: 480, borderRadius: radius.card, border: `1px solid ${colors.border}`,
    overflow: 'hidden', backgroundColor: colors.card,
  },
  statusBox: {
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', padding: spacing.xl,
  },
  infoWindow: { minWidth: 200, fontFamily: 'inherit' },
  infoTitle: { fontSize: 14, fontWeight: 700, color: colors.text, marginBottom: 6 },
  infoRow: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, color: colors.textSecondary, padding: '2px 0' },
  infoLabel: { color: colors.textMuted, fontWeight: 600 },
};
