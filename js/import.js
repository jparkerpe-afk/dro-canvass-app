import { normalizeAddress, normalizeName, voterId } from './hash.js';
import { openDB, getAll, putAll, getMeta, setMeta, clearStore } from './db.js';

export const EXPECTED_HEADERS = [
  'Voter Name', 'Street Address', 'City', 'State', 'Zip', 'Party', 'Age', 'Activity Level',
  'Geocodio Latitude', 'Geocodio Longitude', 'CAIV_East_Feet', 'CAIV_North_Feet', 'Geocodio Accuracy Type',
];

export class ImportError extends Error {}

export function validateHeader(fields) {
  const present = new Set((fields || []).map((f) => f.trim()));
  return EXPECTED_HEADERS.filter((h) => !present.has(h));
}

function avg(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export async function importCsvFile(file) {
  const text = await file.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });

  const missing = validateHeader(parsed.meta.fields);
  if (missing.length > 0) {
    throw new ImportError(
      `Missing required column(s): ${missing.join(', ')}. Fix the CSV header and re-import — nothing was loaded.`
    );
  }

  const db = await openDB();
  const [existingVoters, existingHouseholds] = await Promise.all([
    getAll(db, 'voters'),
    getAll(db, 'households'),
  ]);
  const existingVoterMap = new Map(existingVoters.map((v) => [v.id, v]));
  const existingHouseholdMap = new Map(existingHouseholds.map((h) => [h.id, h]));

  const nextVoters = new Map(existingVoterMap);
  const seenVoterIds = new Set();
  const householdBuckets = new Map(); // normAddress -> { address, lats[], lons[] }

  let totalDataRows = 0;
  let skippedNoCoords = 0;
  let newVoters = 0;
  let updatedVoters = 0;

  for (const row of parsed.data) {
    const hasAnyValue = Object.values(row).some((v) => (v || '').toString().trim() !== '');
    if (!hasAnyValue) continue; // trailing blank line from CSV export

    totalDataRows++;

    const rawAddress = (row['Street Address'] || '').trim();
    const rawName = (row['Voter Name'] || '').trim();
    const lat = parseFloat(row['Geocodio Latitude']);
    const lon = parseFloat(row['Geocodio Longitude']);

    if (!rawAddress || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      skippedNoCoords++;
      continue;
    }

    const normAddress = normalizeAddress(rawAddress);
    const normName = normalizeName(rawName);
    const id = voterId(normAddress, normName);
    seenVoterIds.add(id);

    const existing = existingVoterMap.get(id);
    nextVoters.set(id, {
      id,
      householdId: normAddress,
      name: rawName,
      address: rawAddress,
      city: (row['City'] || '').trim(),
      state: (row['State'] || '').trim(),
      zip: (row['Zip'] || '').trim(),
      party: (row['Party'] || '').trim(),
      age: (row['Age'] || '').trim(),
      activity_level: (row['Activity Level'] || '').trim(),
      lat,
      lon,
      accuracy_type: (row['Geocodio Accuracy Type'] || '').trim(),
      support_level: existing ? existing.support_level : 'unknown',
      stale: false,
    });
    if (existing) updatedVoters++; else newVoters++;

    if (!householdBuckets.has(normAddress)) {
      householdBuckets.set(normAddress, { address: rawAddress, lats: [], lons: [] });
    }
    const bucket = householdBuckets.get(normAddress);
    bucket.lats.push(lat);
    bucket.lons.push(lon);
  }

  // Departed voters (present before, absent from this CSV) are flagged, never deleted.
  let staleVoters = 0;
  for (const [id, voter] of nextVoters) {
    if (!seenVoterIds.has(id) && existingVoterMap.has(id)) {
      if (!voter.stale) staleVoters++;
      voter.stale = true;
    }
  }

  const householdIds = new Set();
  for (const voter of nextVoters.values()) householdIds.add(voter.householdId);

  const nextHouseholds = [];
  for (const householdId of householdIds) {
    const existing = existingHouseholdMap.get(householdId);
    const bucket = householdBuckets.get(householdId);
    nextHouseholds.push({
      id: householdId,
      address: existing ? existing.address : (bucket ? bucket.address : householdId),
      lat: bucket ? avg(bucket.lats) : (existing ? existing.lat : null),
      lon: bucket ? avg(bucket.lons) : (existing ? existing.lon : null),
      contact_status: existing ? existing.contact_status : 'not_visited',
      contacted_at: existing ? existing.contacted_at : null,
      contacted_by: existing ? existing.contacted_by : null,
      notes: existing ? existing.notes : '',
      // Survives re-import for the same reason notes do: it comes from the
      // annotations overlay, not the CSV, and a fresh roll would wipe it.
      county_address: existing ? existing.county_address : '',
      // Field pin corrections. The CSV's lat/lon overwrite `lat`/`lon` above,
      // so the walker's GPS fix is kept in its own fields or a re-import of the
      // roll would silently throw the correction away.
      pin_status: existing ? existing.pin_status : null,
      pin_fix_lat: existing ? existing.pin_fix_lat : null,
      pin_fix_lon: existing ? existing.pin_fix_lon : null,
      pin_fix_accuracy: existing ? existing.pin_fix_accuracy : null,
      pin_fix_at: existing ? existing.pin_fix_at : null,
      pin_fix_by: existing ? existing.pin_fix_by : null,
      // Yard sign: recorded in the field, so it must survive a roll refresh
      // exactly as notes and pin fixes do.
      sign: existing ? !!existing.sign : false,
      // Where the walker stood when they logged the outcome. Field-recorded, so
      // it survives a roll refresh like everything else they produce.
      stood_lat: existing ? (existing.stood_lat ?? null) : null,
      stood_lon: existing ? (existing.stood_lon ?? null) : null,
      stood_accuracy: existing ? (existing.stood_accuracy ?? null) : null,
      stood_at: existing ? (existing.stood_at ?? null) : null,
      volunteer_interest: existing ? existing.volunteer_interest : false,
    });
  }

  await putAll(db, 'voters', Array.from(nextVoters.values()));
  await putAll(db, 'households', nextHouseholds);

  const stats = {
    totalDataRows,
    loaded: totalDataRows - skippedNoCoords,
    skipped: skippedNoCoords,
    newVoters,
    updatedVoters,
    staleVoters,
    householdCount: nextHouseholds.length,
    voterCount: nextVoters.size,
  };

  await setMeta(db, 'lastImportStats', stats);
  await setMeta(db, 'lastImportAt', new Date().toISOString());

  return stats;
}

// ---- Restore from a backup JSON ----
//
// HANDOFF.md has always called the backup "the only thing that can fully restore
// a day's work", but until now nothing could read one back: a phone that died
// took its canvass with it. This closes that. It is also how a walker's work
// gets onto a desktop for review, since each browser keeps its own database and
// the CSV only carries the roll, not what happened at the doors.

export function readBackupFile(file) {
  return file.text().then((text) => {
    let b;
    try { b = JSON.parse(text); }
    catch { throw new ImportError('That is not a readable JSON file.'); }
    if (b.format !== 'dro-canvass-backup') {
      throw new ImportError(
        `That is not a canvass backup (format "${b.format || 'missing'}"). ` +
        'Backups are the files named dro_canvass_<walker>_<date>_backup.json.'
      );
    }
    if (!Array.isArray(b.households) || !Array.isArray(b.voters)) {
      throw new ImportError('That backup is missing its households or voters.');
    }
    const contacted = b.households.filter(
      (h) => h.contact_status && h.contact_status !== 'not_visited').length;
    const rated = b.voters.filter(
      (v) => v.support_level && v.support_level !== 'unknown').length;
    const walker = (b.meta || []).find((m) => m.key === 'walkerName');
    return {
      backup: b,
      summary: {
        households: b.households.length,
        voters: b.voters.length,
        contacted,
        rated,
        notes: b.households.filter((h) => (h.notes || '').trim()).length,
        signs: b.households.filter((h) => h.sign).length,
        exportedAt: b.exported_at || null,
        appVersion: b.app_version || null,
        walker: walker ? walker.value : null,
      },
    };
  });
}

// Wholesale replace. A backup is a complete dump, so merging it into whatever is
// already here would silently blend two walkers' days into one indistinguishable
// state. Replacing is the honest operation, and the caller confirms first.
export async function restoreBackup(backup) {
  const db = await openDB();
  await clearStore(db, 'voters');
  await clearStore(db, 'households');
  await putAll(db, 'households', backup.households);
  await putAll(db, 'voters', backup.voters);
  for (const m of backup.meta || []) {
    if (m && m.key) await setMeta(db, m.key, m.value);
  }
  return { households: backup.households.length, voters: backup.voters.length };
}

export async function setWalkerName(name) {
  const db = await openDB();
  await setMeta(db, 'walkerName', name);
}

export async function getWalkerName() {
  const db = await openDB();
  return getMeta(db, 'walkerName');
}
