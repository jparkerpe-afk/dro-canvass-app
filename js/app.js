import { importCsvFile, ImportError, getWalkerName, setWalkerName } from './import.js';
import { openDB, getAll } from './db.js';
import {
  initMap, addHouseholdLayers, loadHouseholdFeatures,
  addWalkerLayer, updateWalkerPosition,
  addHighlightLayer, setHighlightedHousehold,
} from './map.js';
import { startWatching, stopWatching, findNearestHousehold, describeGeoError } from './geo.js';
import { openSheet } from './sheet.js';

const swStatusEl = document.getElementById('sw-status');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js')
    .then(() => {
      swStatusEl.textContent = 'Service worker: registered';
    })
    .catch((err) => {
      swStatusEl.textContent = 'Service worker: failed to register';
      console.error('Service worker registration failed', err);
    });
} else {
  swStatusEl.textContent = 'Service worker: not supported in this browser';
}

// ---- View toggle (setup screen vs. map screen) ----

const setupView = document.getElementById('setup-view');
const mapView = document.getElementById('map-view');
const navMapBtn = document.getElementById('nav-map');
const navSetupBtn = document.getElementById('nav-setup');

let map = null;

function showSetup() {
  setupView.style.display = 'block';
  mapView.style.display = 'none';
  stopGps();
}

function showMap() {
  setupView.style.display = 'none';
  mapView.style.display = 'flex';
  if (!map) {
    map = initMap('map-container');
    map.on('load', () => {
      addHouseholdLayers(map, openHouseholdSheet);
      addHighlightLayer(map);
      addWalkerLayer(map);
      refreshPins();
      startGps();
    });
  } else {
    map.resize();
    refreshPins();
    startGps();
  }
}

navMapBtn.addEventListener('click', showMap);
navSetupBtn.addEventListener('click', showSetup);

let cachedHouseholds = [];

async function refreshPins() {
  if (!map || !map.getSource('households')) return;
  const db = await openDB();
  const data = await loadHouseholdFeatures(db);
  cachedHouseholds = data.features.map((f) => ({
    id: f.properties.id,
    address: f.properties.address,
    contact_status: f.properties.contact_status,
    voterCount: f.properties.voterCount,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
  map.getSource('households').setData(data);
}

// ---- GPS + proximity highlight ----

const gpsStatusEl = document.getElementById('gps-status');
const proximityBar = document.getElementById('proximity-bar');
const proximityAddress = document.getElementById('proximity-address');
const proximityDistance = document.getElementById('proximity-distance');
const proximityVoters = document.getElementById('proximity-voters');
const proximityOpenBtn = document.getElementById('proximity-open');

let watchId = null;
let nearestHousehold = null;

function startGps() {
  if (watchId != null) return;
  watchId = startWatching({ onFix: handleGpsFix, onError: handleGpsError });
}

function stopGps() {
  if (watchId != null) {
    stopWatching(watchId);
    watchId = null;
  }
  hideProximityBar();
}

function handleGpsFix({ lat, lon }) {
  gpsStatusEl.classList.add('hidden');
  updateWalkerPosition(map, lat, lon);

  const result = findNearestHousehold(lat, lon, cachedHouseholds);
  if (!result) {
    hideProximityBar();
    setHighlightedHousehold(map, null);
    return;
  }
  showProximityBar(result.household, result.distanceMeters);
  setHighlightedHousehold(map, result.household);
}

function handleGpsError(err) {
  gpsStatusEl.textContent = describeGeoError(err);
  gpsStatusEl.classList.remove('hidden');
}

function showProximityBar(household, distanceMeters) {
  nearestHousehold = household;
  proximityAddress.textContent = household.address;
  proximityDistance.textContent = `${Math.round(distanceMeters)} m`;
  proximityVoters.textContent = `${household.voterCount} voter${household.voterCount === 1 ? '' : 's'}`;
  proximityBar.classList.remove('hidden');
}

function hideProximityBar() {
  nearestHousehold = null;
  proximityBar.classList.add('hidden');
}

proximityOpenBtn.addEventListener('click', () => {
  if (!nearestHousehold) return;
  openHouseholdSheet(nearestHousehold.id);
});

// Pin colors and the proximity bar's voter count both derive from stored
// records, so re-read after any edit rather than patching the map in place.
function openHouseholdSheet(householdId) {
  openSheet(householdId, refreshPins);
}

openDB().then(async (db) => {
  const households = await getAll(db, 'households');
  if (households.length > 0) {
    showMap();
  } else {
    showSetup();
  }
});

// ---- CSV import ----

const csvInput = document.getElementById('csv-input');
const importStatus = document.getElementById('import-status');
const importSummary = document.getElementById('import-summary');

csvInput.addEventListener('change', async () => {
  const file = csvInput.files[0];
  if (!file) return;

  importStatus.textContent = `Importing ${file.name}…`;
  importSummary.textContent = '';

  try {
    const stats = await importCsvFile(file);
    importStatus.textContent = `${stats.loaded} of ${stats.totalDataRows} rows loaded; ${stats.skipped} skipped, no coordinates.`;
    importSummary.innerHTML = `
      <ul>
        <li>${stats.newVoters} new voter(s)</li>
        <li>${stats.updatedVoters} existing voter(s) updated</li>
        <li>${stats.staleVoters} voter(s) flagged stale (no longer in this file)</li>
        <li>${stats.householdCount} household(s), ${stats.voterCount} voter(s) total in storage</li>
      </ul>
    `;
    refreshPins();
  } catch (err) {
    if (err instanceof ImportError) {
      importStatus.textContent = err.message;
    } else {
      importStatus.textContent = 'Import failed unexpectedly. See console for details.';
      console.error('Import failed', err);
    }
    importSummary.textContent = '';
  } finally {
    csvInput.value = '';
  }
});

// ---- Walker name ----

const walkerInput = document.getElementById('walker-name-input');
const walkerSaveBtn = document.getElementById('walker-name-save');
const walkerStatus = document.getElementById('walker-name-status');

getWalkerName().then((name) => {
  if (name) {
    walkerInput.value = name;
    walkerStatus.textContent = `Saved: ${name}`;
  }
});

walkerSaveBtn.addEventListener('click', async () => {
  const name = walkerInput.value.trim();
  if (!name) {
    walkerStatus.textContent = 'Enter a name first.';
    return;
  }
  await setWalkerName(name);
  walkerStatus.textContent = `Saved: ${name}`;
});
