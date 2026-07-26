import { openDB, getAll, put, update } from './db.js';
import { normalizeAddress, normalizeName, voterId } from './hash.js';

export class AnnotationError extends Error {}

// Known tags get a friendly label and their own badge styling. Unknown tags
// still apply and render — the list is for presentation, not validation.
export const TAG_LABELS = {
  signer: 'Nomination signer',
  endorser: 'Endorsement',
  'moved-away': 'No longer resides here',
  'field-added': 'Added in the field',
};

export function tagLabel(tag) {
  return TAG_LABELS[tag] || tag;
}

// The roll writes street suffixes one way ("4 Baxter Pl") but paperwork often
// writes another ("4 Baxter Place"). Fold both to the same key so an annotation
// file does not have to match the roll's abbreviation style exactly.
const SUFFIX = {
  PLACE: 'PL', PL: 'PL', ROAD: 'RD', RD: 'RD', AVENUE: 'AVE', AVE: 'AVE',
  DRIVE: 'DR', DR: 'DR', COURT: 'CT', CT: 'CT', CIRCLE: 'CIR', CIR: 'CIR',
  STREET: 'ST', ST: 'ST', HIGHWAY: 'HWY', HWY: 'HWY', WAY: 'WAY', LANE: 'LN', LN: 'LN',
};

export function addressMatchKey(address) {
  const base = normalizeAddress(address).replace(/\./g, '');
  const parts = base.split(' ');
  const last = parts[parts.length - 1];
  if (SUFFIX[last]) parts[parts.length - 1] = SUFFIX[last];
  return parts.join(' ');
}

function mergeTags(existing, incoming) {
  const set = new Set(existing || []);
  for (const t of incoming || []) set.add(String(t).trim().toLowerCase());
  return [...set].filter(Boolean).sort();
}

function appendNote(existing, addition) {
  if (!addition) return existing || '';
  const current = (existing || '').trim();
  if (!current) return addition;
  // Never overwrite what a walker typed; skip if already present.
  if (current.includes(addition)) return current;
  return `${current}\n${addition}`;
}

export async function applyAnnotationFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    throw new AnnotationError('That file is not valid JSON. Nothing was changed.');
  }

  if (parsed.format !== 'dro-canvass-annotations') {
    throw new AnnotationError(
      'That JSON is not an annotations file (missing format "dro-canvass-annotations"). Nothing was changed.'
    );
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new AnnotationError('The annotations file has no entries. Nothing was changed.');
  }

  const db = await openDB();
  const [households, voters] = await Promise.all([getAll(db, 'households'), getAll(db, 'voters')]);

  const householdByKey = new Map();
  for (const h of households) householdByKey.set(addressMatchKey(h.address || h.id), h);

  const votersByHousehold = new Map();
  for (const v of voters) {
    if (!votersByHousehold.has(v.householdId)) votersByHousehold.set(v.householdId, []);
    votersByHousehold.get(v.householdId).push(v);
  }

  const stats = {
    householdsTouched: 0, notesAdded: 0, householdTags: 0,
    votersTagged: 0, votersAdded: 0, pinsCorrected: 0,
    unmatchedAddresses: [], unmatchedVoters: [],
  };

  for (const entry of parsed.entries) {
    const key = addressMatchKey(entry.address || '');
    const household = householdByKey.get(key);
    if (!household) {
      stats.unmatchedAddresses.push(entry.address || '(blank)');
      continue;
    }

    const patch = {};
    if (entry.household_tags) {
      const merged = mergeTags(household.tags, entry.household_tags);
      if (merged.length !== (household.tags || []).length) stats.householdTags++;
      patch.tags = merged;
    }
    if (entry.note_append) {
      const next = appendNote(household.notes, entry.note_append);
      if (next !== (household.notes || '')) stats.notesAdded++;
      patch.notes = next;
    }
    if (Number.isFinite(entry.lat) && Number.isFinite(entry.lon)) {
      patch.lat = entry.lat;
      patch.lon = entry.lon;
      if (entry.accuracy_type) patch.accuracy_type = entry.accuracy_type;
      stats.pinsCorrected++;
    }

    if (Object.keys(patch).length) {
      await update(db, 'households', household.id, patch);
      stats.householdsTouched++;
    }

    // Per-voter tags, matched on name within this household.
    const members = votersByHousehold.get(household.id) || [];
    for (const vt of entry.voter_tags || []) {
      const target = members.find((m) => normalizeName(m.name) === normalizeName(vt.name));
      if (!target) {
        stats.unmatchedVoters.push(`${vt.name} @ ${entry.address}`);
        continue;
      }
      await update(db, 'voters', target.id, { tags: mergeTags(target.tags, vt.tags) });
      stats.votersTagged++;
    }

    // Field-added residents. Marked source:'field' so exports never confuse a
    // canvasser's addition with a county-supplied registration.
    for (const add of entry.voters_add || []) {
      const normAddr = household.id;
      const normName = normalizeName(add.name);
      const id = voterId(normAddr, normName);
      const already = members.find((m) => m.id === id);
      if (already) {
        await update(db, 'voters', id, { tags: mergeTags(already.tags, add.tags) });
        stats.votersTagged++;
        continue;
      }
      await put(db, 'voters', {
        id,
        householdId: normAddr,
        name: add.name,
        address: household.address,
        city: add.city || '',
        state: add.state || '',
        zip: add.zip || '',
        party: add.party || '',
        age: add.age || '',
        activity_level: add.activity_level || '',
        lat: household.lat,
        lon: household.lon,
        accuracy_type: household.accuracy_type || '',
        support_level: add.support_level || 'unknown',
        stale: false,
        source: 'field',
        tags: mergeTags(['field-added'], add.tags),
      });
      stats.votersAdded++;
    }
  }

  return stats;
}
