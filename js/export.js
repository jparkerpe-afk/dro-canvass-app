import { openDB, getAll, getMeta } from './db.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

export function dateStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function slugify(name) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'unknown';
}

export function baseFilename(walkerName) {
  return `dro_canvass_${slugify(walkerName)}_${dateStamp()}`;
}

function triggerDownload(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoked late: some mobile browsers read the blob asynchronously after the
  // click, and revoking immediately produces a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function loadAll() {
  const db = await openDB();
  const [households, voters, walkerName] = await Promise.all([
    getAll(db, 'households'),
    getAll(db, 'voters'),
    getMeta(db, 'walkerName'),
  ]);

  const byHousehold = new Map();
  for (const voter of voters) {
    if (!byHousehold.has(voter.householdId)) byHousehold.set(voter.householdId, []);
    byHousehold.get(voter.householdId).push(voter);
  }
  for (const list of byHousehold.values()) {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  return { households, voters, byHousehold, walkerName };
}

// ---- GeoJSON: one feature per household, for QGIS ----

export async function exportGeoJSON() {
  const { households, byHousehold, walkerName } = await loadAll();

  const features = households
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon))
    .map((h) => {
      const members = byHousehold.get(h.id) || [];
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
        properties: {
          household_id: h.id,
          address: h.address,
          contact_status: h.contact_status || 'not_visited',
          contacted_at: h.contacted_at || '',
          contacted_by: h.contacted_by || '',
          sign_request: !!h.sign_request,
          volunteer_interest: !!h.volunteer_interest,
          notes: h.notes || '',
          household_tags: (h.tags || []).join('; '),
          accuracy_type: h.accuracy_type || (members[0] && members[0].accuracy_type) || '',
          voter_count: members.filter((v) => !v.stale).length,
          // Flattened alongside the nested array so the attribute survives a
          // shapefile round-trip, which cannot hold nested structures.
          voters_summary: members
            .map((v) => `${v.name} (${v.support_level || 'unknown'})`)
            .join('; '),
          voters: members.map((v) => ({
            voter_id: v.id,
            name: v.name,
            party: v.party || '',
            age: v.age || '',
            activity_level: v.activity_level || '',
            support_level: v.support_level || 'unknown',
            accuracy_type: v.accuracy_type || '',
            stale: !!v.stale,
            source: v.source || 'county',
            tags: (v.tags || []).join('; '),
          })),
        },
      };
    });

  const text = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
  triggerDownload(`${baseFilename(walkerName)}.geojson`, text, 'application/geo+json');
  return { households: features.length };
}

// ---- CSV: one row per voter, household fields repeated ----

const CSV_COLUMNS = [
  'household_id', 'address', 'latitude', 'longitude',
  'contact_status', 'contacted_at', 'contacted_by',
  'sign_request', 'volunteer_interest', 'notes', 'household_tags',
  'voter_name', 'party', 'age', 'activity_level', 'support_level',
  'accuracy_type', 'stale', 'source', 'voter_tags',
];

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

export async function exportCSV() {
  const { households, byHousehold, walkerName } = await loadAll();

  const lines = [csvRow(CSV_COLUMNS)];
  let rowCount = 0;

  for (const h of households) {
    const householdCells = [
      h.id, h.address, h.lat, h.lon,
      h.contact_status || 'not_visited', h.contacted_at || '', h.contacted_by || '',
      h.sign_request ? 'true' : 'false',
      h.volunteer_interest ? 'true' : 'false',
      h.notes || '',
      (h.tags || []).join('; '),
    ];

    const members = byHousehold.get(h.id) || [];
    if (members.length === 0) {
      // Keep the household in the file even with no voter rows, so the export
      // stays a complete picture rather than dropping addresses.
      lines.push(csvRow([...householdCells, '', '', '', '', '', '', '', '', '']));
      rowCount++;
      continue;
    }

    for (const v of members) {
      lines.push(csvRow([
        ...householdCells,
        v.name, v.party || '', v.age || '', v.activity_level || '',
        v.support_level || 'unknown', v.accuracy_type || '', v.stale ? 'true' : 'false',
        v.source || 'county', (v.tags || []).join('; '),
      ]));
      rowCount++;
    }
  }

  triggerDownload(`${baseFilename(walkerName)}.csv`, lines.join('\r\n'), 'text/csv');
  return { rows: rowCount };
}

// ---- Backup: raw dump, the safety net ----

export async function exportBackup() {
  const db = await openDB();
  const [households, voters, meta] = await Promise.all([
    getAll(db, 'households'),
    getAll(db, 'voters'),
    getAll(db, 'meta'),
  ]);
  const walkerName = (meta.find((m) => m.key === 'walkerName') || {}).value;

  const text = JSON.stringify({
    format: 'dro-canvass-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    app_version: (typeof self !== 'undefined' && self.APP_VERSION) || 'unknown',
    households,
    voters,
    meta,
  }, null, 2);

  triggerDownload(`${baseFilename(walkerName)}_backup.json`, text, 'application/json');
  return { households: households.length, voters: voters.length };
}

export async function exportSummary() {
  const { households, voters } = await loadAll();
  const counts = {};
  for (const h of households) {
    const status = h.contact_status || 'not_visited';
    counts[status] = (counts[status] || 0) + 1;
  }
  return { households: households.length, voters: voters.length, counts };
}
