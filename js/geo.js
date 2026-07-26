// Tunable per SPEC.md 6.2: beyond this, the walker is driving between
// streets, not approaching a door — show nothing rather than a stale pick.
export const PROXIMITY_MAX_METERS = 100;

// Ignore fixes noisier than this so a bad reading doesn't yank the highlight.
export const MIN_ACCURACY_METERS = 50;

// Don't recalculate the nearest household more than once per this interval,
// so GPS noise moves the distance number instead of flickering the pick.
export const RECALC_THROTTLE_MS = 1000;

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function findNearestHousehold(lat, lon, households) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const h of households) {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
    const d = haversineMeters(lat, lon, h.lat, h.lon);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = h;
    }
  }
  if (!nearest || nearestDist > PROXIMITY_MAX_METERS) return null;
  return { household: nearest, distanceMeters: nearestDist };
}

export function describeGeoError(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location permission denied — enable it in your browser/app settings to see nearby households.';
    case err.POSITION_UNAVAILABLE:
      return 'Location unavailable right now.';
    case err.TIMEOUT:
      return 'Location fix timed out — still trying.';
    default:
      return 'Location error.';
  }
}

export function startWatching({ onFix, onError }) {
  if (!('geolocation' in navigator)) {
    onError(new Error('Geolocation is not supported in this browser.'));
    return null;
  }

  let lastAcceptedAt = 0;

  return navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      if (accuracy > MIN_ACCURACY_METERS) return;

      const now = Date.now();
      if (now - lastAcceptedAt < RECALC_THROTTLE_MS) return;
      lastAcceptedAt = now;

      onFix({ lat: latitude, lon: longitude, accuracy });
    },
    onError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

export function stopWatching(watchId) {
  if (watchId != null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(watchId);
  }
}
