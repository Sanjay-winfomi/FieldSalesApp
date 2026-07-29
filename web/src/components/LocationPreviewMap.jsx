import { useEffect, useRef, useState } from 'react';
import { GoogleMap, Marker, Circle, useJsApiLoader } from '@react-google-maps/api';

const MAP_CONTAINER_STYLE = { width: '100%', height: '260px', borderRadius: '10px' };

// Recenter the map view when the location jumps somewhere new (a fresh
// address search), but NOT on every small nudge from dragging the pin —
// otherwise the view would yank itself back under the manager's cursor
// mid-drag, which is exactly the opposite of what fine-tuning needs.
const RECENTER_THRESHOLD_DEGREES = 0.01; // roughly ~1km

/**
 * Shows a dealer's location with its check-in tolerance radius drawn around
 * it, so a manager can visually confirm the geofence actually covers the
 * premises before saving. The pin is draggable and the map is click-to-place,
 * so an address search only needs to get you in the right neighbourhood —
 * the exact spot gets fine-tuned by hand afterward.
 */
export default function LocationPreviewMap({ latitude, longitude, radiusMeters, onLocationChange }) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'fieldtrack-google-maps',
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
  });

  const center = { lat: latitude, lng: longitude };
  // Standard map tiles only label buildings that carry a name in Google's
  // data — most don't, and no amount of zooming reveals a name that isn't
  // there. Satellite imagery sidesteps that entirely: the building is
  // recognizable by its actual roof/shape/surroundings instead of a label.
  const [satellite, setSatellite] = useState(false);
  const mapRef = useRef(null);
  const lastCenterRef = useRef(center);

  useEffect(() => {
    if (!mapRef.current) return;
    const { lat: lastLat, lng: lastLng } = lastCenterRef.current;
    const jumped = Math.abs(latitude - lastLat) > RECENTER_THRESHOLD_DEGREES || Math.abs(longitude - lastLng) > RECENTER_THRESHOLD_DEGREES;
    if (jumped) {
      mapRef.current.panTo(center);
      mapRef.current.setZoom(18);
      lastCenterRef.current = center;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latitude, longitude]);

  if (loadError) {
    return (
      <div style={{ ...MAP_CONTAINER_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #FECACA', color: '#B91C1C', fontSize: 13, textAlign: 'center', padding: 16 }}>
        Map failed to load — check NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.
      </div>
    );
  }
  if (!isLoaded) {
    return (
      <div style={{ ...MAP_CONTAINER_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #D0D0D0', color: '#666', fontSize: 13 }}>
        Loading map...
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setSatellite((s) => !s)}
        style={{
          position: 'absolute', top: 8, right: 8, zIndex: 1,
          padding: '6px 10px', borderRadius: '6px', border: '0.5px solid #D0D0D0',
          backgroundColor: '#FFFFFF', color: '#434343', fontSize: '12px', fontWeight: 500, cursor: 'pointer',
        }}
      >
        {satellite ? 'Map view' : 'Satellite view'}
      </button>
      <GoogleMap
        mapContainerStyle={MAP_CONTAINER_STYLE}
        center={center}
        zoom={18}
        mapTypeId={satellite ? 'satellite' : 'roadmap'}
        onLoad={(map) => { mapRef.current = map; }}
        onClick={onLocationChange ? (e) => onLocationChange(e.latLng.lat(), e.latLng.lng()) : undefined}
        options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false }}
      >
        <Marker
          position={center}
          draggable={Boolean(onLocationChange)}
          onDragEnd={onLocationChange ? (e) => onLocationChange(e.latLng.lat(), e.latLng.lng()) : undefined}
        />
        <Circle
          center={center}
          radius={radiusMeters}
          options={{ strokeColor: '#1B7F5A', fillColor: '#1B7F5A', fillOpacity: 0.12, strokeWeight: 1 }}
        />
      </GoogleMap>
    </div>
  );
}
