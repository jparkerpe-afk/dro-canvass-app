import { importCsvFile, ImportError, getWalkerName, setWalkerName } from './import.js';
import { openDB, getAll } from './db.js';
import {
  initMap, addHouseholdLayers, loadHouseholdFeatures,
  addWalkerLayer, updateWalkerPosition,
  addHighlightLayer, setHighlightedHousehold,
} from './map.js';
import { startWatching, stopWatching, findNearestHousehold, describeGeoError } from './geo.js';
import { openSheet } from './sheet.js';
import { exportGeoJSON, exportCSV, exportBackup, exportSummary } from './export.js';

const swStatusEl = document.getElementById('sw-status');
const appVersionEl = document.getElementById('app-version');
const updateStatusEl = document.getElementById('update-status');
const checkUpdateBtn = document.getElementById('check-update');
const applyUpdateBtn = document.getElementById('apply-update');

const APP_VERSION = window.APP_VERSION || 'unknown';
appVersionEl.textContent = APP_VERSION;

let swRegistration = null;
let reloadingForUpdate = false;

function showUpdateReady() {
  updateStatusEl.textContent = 'A new version is ready to install.';
  applyUpdateBtn.classList.remove('hidden');
}

function watchInstalling(worker) {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    // A worker reaching "installed" while one already controls the page means
    // this is an update rather than a first install.
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      showUpdateReady();
    }
  });
}

// register() can resolve either before or after the new worker finishes
// installing, so neither reg.installing nor reg.waiting is reliably populated
// at any single moment. Poll briefly rather than miss the transition and leave
// a downloaded update with no way to apply it.
function awaitWaitingWorker(reg, attemptsLeft = 60) {
  if (reg.waiting) {
    showUpdateReady();
    return;
  }
  if (attemptsLeft <= 0) {
    updateStatusEl.textContent = 'Update downloaded but did not finish installing. Reload the page.';
    return;
  }
  setTimeout(() => awaitWaitingWorker(reg, attemptsLeft - 1), 250);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`./service-worker.js?v=${encodeURIComponent(APP_VERSION)}`)
    .then((reg) => {
      swRegistration = reg;
      swStatusEl.textContent = 'Offline ready';

      if (reg.waiting && navigator.serviceWorker.controller) showUpdateReady();
      else updateStatusEl.textContent = 'Up to date.';

      watchInstalling(reg.installing);
      reg.addEventListener('updatefound', () => watchInstalling(reg.installing));
    })
    .catch((err) => {
      swStatusEl.textContent = 'Offline caching unavailable';
      updateStatusEl.textContent = 'Could not check for updates.';
      console.error('Service worker registration failed', err);
    });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });
} else {
  swStatusEl.textContent = 'Service worker: not supported in this browser';
  updateStatusEl.textContent = 'Updates cannot be checked in this browser.';
}

// Reads the deployed version straight off the network. Asking the existing
// registration to update() is not enough: this page's worker URL was built
// from its own possibly-stale APP_VERSION, so a stale build would keep
// checking a stale URL and be told it is current forever.
async function fetchDeployedVersion() {
  const res = await fetch(`./js/version.js?freshcheck=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`version fetch failed: ${res.status}`);
  const match = (await res.text()).match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error('could not parse deployed version');
  return match[1];
}

checkUpdateBtn.addEventListener('click', async () => {
  updateStatusEl.textContent = 'Checking…';
  try {
    const deployed = await fetchDeployedVersion();
    if (deployed === APP_VERSION) {
      updateStatusEl.textContent = `Up to date — running ${APP_VERSION} (checked ${new Date().toLocaleTimeString()}).`;
      return;
    }
    updateStatusEl.textContent = `Version ${deployed} is available. Downloading…`;
    // Registering the deployed version's worker URL is what pulls the new
    // build down; it installs alongside and waits for the Update tap.
    const reg = await navigator.serviceWorker.register(
      `./service-worker.js?v=${encodeURIComponent(deployed)}`
    );
    swRegistration = reg;
    watchInstalling(reg.installing);
    reg.addEventListener('updatefound', () => watchInstalling(reg.installing));
    awaitWaitingWorker(reg);
  } catch (err) {
    updateStatusEl.textContent = 'Check failed — are you online?';
    console.error('Update check failed', err);
  }
});

applyUpdateBtn.addEventListener('click', () => {
  const waiting = swRegistration && swRegistration.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  updateStatusEl.textContent = 'Installing…';
  waiting.postMessage('SKIP_WAITING');
});

// ---- View toggle (setup screen vs. map screen) ----

const setupView = document.getElementById('setup-view');
const mapView = document.getElementById('map-view');
const navMapBtn = document.getElementById('nav-map');
const navSetupBtn = document.getElementById('nav-setup');

let map = null;

function setActiveNav(button) {
  navMapBtn.classList.toggle('active', button === navMapBtn);
  navSetupBtn.classList.toggle('active', button === navSetupBtn);
}

function showSetup() {
  setupView.style.display = 'block';
  mapView.style.display = 'none';
  setActiveNav(navSetupBtn);
  stopGps();
}

function showMap() {
  setupView.style.display = 'none';
  mapView.style.display = 'flex';
  setActiveNav(navMapBtn);
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

// ---- Export ----

const exportStatus = document.getElementById('export-status');

async function runExport(label, fn) {
  exportStatus.textContent = `Preparing ${label}…`;
  try {
    await fn();
    const s = await exportSummary();
    const visited = s.households - (s.counts.not_visited || 0);
    exportStatus.textContent =
      `${label} downloaded — ${s.households} households (${visited} contacted), ${s.voters} voters. Check your Downloads folder.`;
  } catch (err) {
    exportStatus.textContent = `${label} failed. See console for details.`;
    console.error(`${label} export failed`, err);
  }
}

document.getElementById('export-backup')
  .addEventListener('click', () => runExport('Backup', exportBackup));
document.getElementById('export-geojson')
  .addEventListener('click', () => runExport('GeoJSON', exportGeoJSON));
document.getElementById('export-csv')
  .addEventListener('click', () => runExport('CSV', exportCSV));
