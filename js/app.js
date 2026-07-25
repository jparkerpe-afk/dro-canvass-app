import { importCsvFile, ImportError, getWalkerName, setWalkerName } from './import.js';

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

const csvInput = document.getElementById('csv-input');
const importStatus = document.getElementById('import-status');
const importSummary = document.getElementById('import-summary');
const walkerInput = document.getElementById('walker-name-input');
const walkerSaveBtn = document.getElementById('walker-name-save');
const walkerStatus = document.getElementById('walker-name-status');

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
