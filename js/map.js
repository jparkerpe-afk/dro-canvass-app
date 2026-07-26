import { getAll } from './db.js';

// Fallback only, used when there is no data to fit to yet. The real opening
// view comes from fitToHouseholds() — a hardcoded centre silently strands the
// walker on an empty map if it drifts from where the roll actually is.
export const MAP_CENTER = [-121.8385, 36.5938];
export const DEFAULT_ZOOM = 15;

// Frames the whole roll on first load. Called once so it does not fight the
// walker's own panning and zooming afterwards.
export function fitToHouseholds(map, featureCollection) {
  const feats = (featureCollection.features || []).filter(
    (f) => f.geometry && Array.isArray(f.geometry.coordinates)
  );
  if (feats.length === 0) return false;

  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const f of feats) {
    const [lon, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLon)) return false;

  if (minLon === maxLon && minLat === maxLat) {
    map.jumpTo({ center: [minLon, minLat], zoom: 17 });
    return true;
  }

  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 28, animate: false });
  return true;
}

const STATUS_COLORS = {
  not_visited: '#9e9e9e',
  talked: '#2e7d32',
  not_home: '#f9a825',
  refused: '#c62828',
  moved: '#6d4c41',
  wrong_address: '#6d4c41',
};

export function initMap(containerId) {
  const map = new maplibregl.Map({
    container: containerId,
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: MAP_CENTER,
    zoom: DEFAULT_ZOOM,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  return map;
}

// Counts at or above this collapse to "N+". Real households top out well
// below this; the cap just bounds how many icons we pre-render.
const MAX_BADGE_COUNT = 9;

// The pin count badge is drawn to a canvas and registered as a map image
// rather than using a `text-field` symbol layer: text requires the style to
// declare a `glyphs` font endpoint, which would mean an external request on
// every map load and no badges at all when offline.
function makeCountIcon(label) {
  const size = 20;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 13px -apple-system, Roboto, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2);
  return ctx.getImageData(0, 0, size, size);
}

function registerCountBadgeIcons(map) {
  for (let n = 2; n < MAX_BADGE_COUNT; n++) {
    if (!map.hasImage(`count-${n}`)) map.addImage(`count-${n}`, makeCountIcon(String(n)));
  }
  const plusId = `count-${MAX_BADGE_COUNT}plus`;
  if (!map.hasImage(plusId)) map.addImage(plusId, makeCountIcon(`${MAX_BADGE_COUNT}+`));
}

export function addHouseholdLayers(map, onHouseholdClick) {
  map.addSource('households', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'household-pins',
    type: 'circle',
    source: 'households',
    paint: {
      'circle-radius': 9,
      'circle-color': [
        'match', ['get', 'contact_status'],
        'talked', STATUS_COLORS.talked,
        'not_home', STATUS_COLORS.not_home,
        'refused', STATUS_COLORS.refused,
        'moved', STATUS_COLORS.moved,
        'wrong_address', STATUS_COLORS.wrong_address,
        STATUS_COLORS.not_visited,
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });

  registerCountBadgeIcons(map);

  map.addLayer({
    id: 'household-badge',
    type: 'symbol',
    source: 'households',
    filter: ['>', ['get', 'voterCount'], 1],
    layout: {
      'icon-image': [
        'case',
        ['>=', ['get', 'voterCount'], MAX_BADGE_COUNT],
        `count-${MAX_BADGE_COUNT}plus`,
        ['concat', 'count-', ['to-string', ['get', 'voterCount']]],
      ],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  map.on('mouseenter', 'household-pins', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'household-pins', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'household-pins', (e) => {
    const props = e.features[0].properties;
    if (onHouseholdClick) onHouseholdClick(props.id);
  });
}

// ---- Walker's own GPS position ----

export function addWalkerLayer(map) {
  map.addSource('walker', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'walker-halo',
    type: 'circle',
    source: 'walker',
    paint: { 'circle-radius': 14, 'circle-color': '#2196f3', 'circle-opacity': 0.25 },
  });

  map.addLayer({
    id: 'walker-dot',
    type: 'circle',
    source: 'walker',
    paint: {
      'circle-radius': 6,
      'circle-color': '#2196f3',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });
}

export function updateWalkerPosition(map, lat, lon) {
  const source = map.getSource('walker');
  if (!source) return;
  source.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} }],
  });
}

// ---- Nearest-household proximity highlight ----

export function addHighlightLayer(map) {
  map.addSource('highlight', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'highlight-ring',
    type: 'circle',
    source: 'highlight',
    paint: {
      'circle-radius': 16,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 3,
      'circle-stroke-color': '#2196f3',
    },
  }, 'household-pins');
}

export function setHighlightedHousehold(map, household) {
  const source = map.getSource('highlight');
  if (!source) return;
  source.setData({
    type: 'FeatureCollection',
    features: household
      ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [household.lon, household.lat] }, properties: {} }]
      : [],
  });
}

export async function loadHouseholdFeatures(db) {
  const [households, voters] = await Promise.all([
    getAll(db, 'households'),
    getAll(db, 'voters'),
  ]);

  const activeVoterCount = new Map();
  for (const voter of voters) {
    if (voter.stale) continue;
    activeVoterCount.set(voter.householdId, (activeVoterCount.get(voter.householdId) || 0) + 1);
  }

  return {
    type: 'FeatureCollection',
    features: households
      .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon))
      .map((h) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
        properties: {
          id: h.id,
          address: h.address,
          contact_status: h.contact_status,
          voterCount: activeVoterCount.get(h.id) || 0,
        },
      })),
  };
}
