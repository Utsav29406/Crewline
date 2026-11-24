import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Circle, CircleMarker, Marker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { fmtDistance } from '../format.js';

// Leaflet's default marker images don't survive bundling; use a CSS pin instead.
const pinIcon = L.divIcon({ className: 'map-pin', html: '<span></span>', iconSize: [26, 26], iconAnchor: [13, 13] });

// Beyond this, the accuracy circle would swamp the map; show it, but don't zoom out to fit it.
const MAX_FIT_ACCURACY_M = 2000;

function ClickHandler({ onPick }) {
  useMapEvents({ click: (e) => onPick?.({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

/**
 * Fits the view when the set of zones changes or the first position fix arrives —
 * not on every GPS update, which made the map jump around.
 */
function AutoFit({ fences, position, draft, people }) {
  const map = useMap();
  const key = `${fences.map((f) => f.id).join(',')}|${position ? 'pos' : ''}|${draft ? 'draft' : ''}|${people.map((p) => p.id).join(',')}`;
  const latest = useRef({ fences, position, draft, people });
  latest.current = { fences, position, draft, people };
  useEffect(() => {
    const { fences, position, draft, people } = latest.current;
    const circles = [
      ...(draft ? [{ lat: draft.lat, lng: draft.lng, r: draft.radius_m }] : fences.map((f) => ({ lat: f.lat, lng: f.lng, r: f.radius_m }))),
      ...(position ? [{ lat: position.lat, lng: position.lng, r: Math.min(position.accuracy || 50, MAX_FIT_ACCURACY_M) }] : []),
      ...people.map((p) => ({ lat: p.lat, lng: p.lng, r: 40 })),
    ];
    if (!circles.length) return;
    const bounds = circles.reduce((b, c) => b.extend(L.latLng(c.lat, c.lng).toBounds(c.r * 2)), L.latLngBounds([]));
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 18 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

/** Moves the view when the parent asks (search result, "use my location"…). */
function Focus({ focus }) {
  const map = useMap();
  useEffect(() => {
    if (!focus) return;
    if (focus.radius) map.fitBounds(L.latLng(focus.lat, focus.lng).toBounds(focus.radius * 2.6), { maxZoom: 18 });
    else map.setView([focus.lat, focus.lng], focus.zoom || 17);
  }, [focus, map]);
  return null;
}

/**
 * Map of geofence circles, optional user position, optional click/drag-to-pick,
 * and optional `people` markers ({ id, lat, lng, color, label }) for the live map.
 */
export default function FenceMap({ fences = [], position, draft, people = [], onPick, focus, height }) {
  return (
    <div className="map" style={height ? { height } : undefined}>
      <MapContainer center={[20.5937, 78.9629]} zoom={4} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
        <AutoFit fences={fences} position={position} draft={draft} people={people} />
        <Focus focus={focus} />
        {onPick && <ClickHandler onPick={onPick} />}
        {fences.map((f) => (
          <Circle key={f.id} center={[f.lat, f.lng]} radius={f.radius_m}
            pathOptions={{ color: f.active ? '#6366f1' : '#8a91a8', fillOpacity: 0.12, weight: 2, dashArray: f.active ? null : '6 6' }}>
            <Tooltip>{f.name} · {fmtDistance(f.radius_m)}</Tooltip>
          </Circle>
        ))}
        {draft && (
          <>
            <Circle center={[draft.lat, draft.lng]} radius={draft.radius_m} pathOptions={{ color: '#a855f7', fillOpacity: 0.18, weight: 2 }} />
            <Marker position={[draft.lat, draft.lng]} icon={pinIcon} draggable={Boolean(onPick)}
              eventHandlers={{ dragend: (e) => { const p = e.target.getLatLng(); onPick?.({ lat: p.lat, lng: p.lng }); } }}>
              <Tooltip direction="top" offset={[0, -12]}>Drag to fine-tune the centre</Tooltip>
            </Marker>
          </>
        )}
        {people.map((p) => (
          <CircleMarker key={p.id} center={[p.lat, p.lng]} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: p.color, fillOpacity: 1 }}>
            <Tooltip direction="top" offset={[0, -8]}>{p.label}</Tooltip>
          </CircleMarker>
        ))}
        {position && (
          <>
            <Circle center={[position.lat, position.lng]} radius={position.accuracy || 0}
              pathOptions={{ color: '#2a78d6', fillOpacity: 0.08, weight: 1, dashArray: position.accuracy > 150 ? '4 6' : null }} />
            <CircleMarker center={[position.lat, position.lng]} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#2a78d6', fillOpacity: 1 }}>
              <Tooltip>You are here (±{fmtDistance(position.accuracy)})</Tooltip>
            </CircleMarker>
          </>
        )}
      </MapContainer>
    </div>
  );
}
