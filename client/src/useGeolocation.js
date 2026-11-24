import { useEffect, useState } from 'react';

/** Watches the device position. Returns { coords, error, loading }. */
export default function useGeolocation(enabled = true) {
  const [state, setState] = useState({ coords: null, error: null, loading: enabled });

  useEffect(() => {
    if (!enabled) return;
    if (!navigator.geolocation) {
      setState({ coords: null, error: 'Geolocation is not supported on this device', loading: false });
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => setState({
        coords: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) },
        error: null,
        loading: false,
      }),
      (err) => setState((s) => ({ ...s, error: err.code === 1 ? 'Location permission denied' : 'Unable to get your location', loading: false })),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  return state;
}
