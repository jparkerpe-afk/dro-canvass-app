import { normalizeAddress, normalizeName, voterId } from './hash.js';
import { openDB, getAll, putAll, getMeta, setMeta } from './db.js';

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
      sign_request: existing ? existing.sign_request : false,
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

export async function setWalkerName(name) {
  const db = await openDB();
  await setMeta(db, 'walkerName', name);
}

export async function getWalkerName() {
  const db = await openDB();
  return getMeta(db, 'walkerName');
}
