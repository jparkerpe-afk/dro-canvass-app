import { importCsvFile, ImportError, getWalkerName, setWalkerName } from './import.js';
import { openDB, getAll } from './db.js';
import { initMap, addHouseholdLayers, loadHouseholdFeatures } from './map.js';

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
}

function showMap() {
  setupView.style.display = 'none';
  mapView.style.display = 'flex';
  if (!map) {
    map = initMap('map-container');
    map.on('load', () => {
      addHouseholdLayers(map);
      refreshPins();
    });
  } else {
    map.resize();
    refreshPins();
  }
}

navMapBtn.addEventListener('click', showMap);
navSetupBtn.addEventListener('click', showSetup);

async function refreshPins() {
  if (!map || !map.getSource('households')) return;
  const db = await openDB();
  const data = await loadHouseholdFeatures(db);
  map.getSource('households').setData(data);
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
