import { getAll } from './db.js';

// Del Rey Oaks, CA city hall — reasonable default center for a ~0.5 sq mi city.
export const MAP_CENTER = [-121.8107, 36.5968];
export const DEFAULT_ZOOM = 15.5;

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

export function addHouseholdLayers(map) {
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

  map.addLayer({
    id: 'household-badge',
    type: 'symbol',
    source: 'households',
    filter: ['>', ['get', 'voterCount'], 1],
    layout: {
      'text-field': ['to-string', ['get', 'voterCount']],
      'text-size': 11,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-width': 0,
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
    showHouseholdPopup(map, props, e.lngLat);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function showHouseholdPopup(map, household, lngLat) {
  const at = lngLat || [household.lon, household.lat];
  new maplibregl.Popup({ closeButton: true })
    .setLngLat(at)
    .setHTML(
      `<strong>${escapeHtml(household.address)}</strong><br>` +
      `Status: ${escapeHtml(household.contact_status)}<br>` +
      `Voters: ${household.voterCount}`
    )
    .addTo(map);
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
