import { openDB, get, getByIndex, update, getMeta } from './db.js';
import { tagLabel } from './annotations.js';

export const CONTACT_STATUSES = [
  { value: 'talked', label: 'Talked' },
  { value: 'not_home', label: 'Not home' },
  { value: 'refused', label: 'Refused' },
  { value: 'moved', label: 'Moved' },
  { value: 'wrong_address', label: 'Wrong address' },
  { value: 'not_visited', label: 'Clear' },
];

export const SUPPORT_LEVELS = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'strong_yes', label: 'Strong yes' },
  { value: 'lean_yes', label: 'Lean yes' },
  { value: 'undecided', label: 'Undecided' },
  { value: 'lean_no', label: 'Lean no' },
  { value: 'strong_no', label: 'Strong no' },
];

// Geocodio types we treat as rooftop-quality. Anything else gets a warning
// badge so the walker knows the pin may not be the house in front of them.
// The QGIS workflow emits its own descriptive labels rather than raw Geocodio
// codes — "Verified (rooftop)", "Approximate -- verify in person",
// "Verified (county address point)", "Verified (OSM building match)",
// "Verified (canvasser confirmed)". Matching against raw codes flagged every
// household as low confidence, which trains the walker to ignore the one
// warning that matters. Treat anything explicitly approximate or estimated as
// low confidence, and anything verified as good.
export function isLowConfidenceGeocode(accuracyType) {
  if (!accuracyType) return true; // no information is not confidence
  const a = accuracyType.trim().toLowerCase();
  if (/\b(approximate|estimated|interpolat|centroid|street[ _-]?center|place|city|state|county name|zip)\b/.test(a)) {
    return true;
  }
  if (/\bverified\b/.test(a)) return false;
  // Raw Geocodio codes, in case a future export uses them directly.
  return !['rooftop', 'point', 'nearest_rooftop_match', 'range_interpolation'].includes(a);
}

const sheetEl = document.getElementById('household-sheet');
const addressEl = document.getElementById('sheet-address');
const geoWarningEl = document.getElementById('sheet-geo-warning');
const countyAddressEl = document.getElementById('sheet-county-address');
const householdTagsEl = document.getElementById('sheet-household-tags');
const statusButtonsEl = document.getElementById('status-buttons');
const voterListEl = document.getElementById('voter-list');
const signEl = document.getElementById('sign');
const volunteerEl = document.getElementById('volunteer-interest');
const notesEl = document.getElementById('household-notes');
const savedEl = document.getElementById('sheet-saved');
const closeBtn = document.getElementById('sheet-close');
const pinStateEl = document.getElementById('pin-fix-state');
const pinConfirmBtn = document.getElementById('pin-confirm');
const pinHereBtn = document.getElementById('pin-standing-here');
const pinUndoBtn = document.getElementById('pin-fix-undo');

let currentHousehold = null;
let onChangeCallback = null;
let savedTimer = null;
let notesTimer = null;

// Latest accepted GPS fix, pushed in by app.js. Held here rather than read on
// demand because getCurrentPosition() on a doorstep can take several seconds,
// and the walker has already tapped — the watch is running anyway.
let currentFix = null;
export function setCurrentFix(fix) {
  currentFix = fix;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function flashSaved() {
  savedEl.textContent = 'Saved';
  savedEl.classList.add('visible');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove('visible'), 1200);
}

async function saveHousehold(patch) {
  if (!currentHousehold) return;
  const db = await openDB();
  const updated = await update(db, 'households', currentHousehold.id, patch);
  if (!updated) return;
  currentHousehold = updated;
  flashSaved();
  if (onChangeCallback) onChangeCallback();
}

async function saveVoter(voterId, patch) {
  const db = await openDB();
  await update(db, 'voters', voterId, patch);
  flashSaved();
}

function renderStatusButtons(activeStatus) {
  statusButtonsEl.innerHTML = '';
  for (const status of CONTACT_STATUSES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-btn' + (activeStatus === status.value ? ' active' : '');
    btn.dataset.status = status.value;
    btn.textContent = status.label;
    btn.addEventListener('click', async () => {
      const walkerName = await getWalkerNameSafe();
      const isClear = status.value === 'not_visited';
      await saveHousehold({
        contact_status: status.value,
        contacted_at: isClear ? null : new Date().toISOString(),
        contacted_by: isClear ? null : (walkerName || null),
      });
      renderStatusButtons(status.value);
    });
    statusButtonsEl.appendChild(btn);
  }
}

// Phone GPS is roughly +-5-10m, less precise than a careful click on aerial
// imagery. It cannot, however, pick the WRONG HOUSE, which is the error that
// actually matters here — so a fix taken at the door beats a confident geocode.
function renderPinFix(household) {
  const status = household.pin_status || '';
  const at = household.pin_fix_at ? new Date(household.pin_fix_at).toLocaleDateString() : '';
  const by = household.pin_fix_by ? ` by ${household.pin_fix_by}` : '';

  if (status === 'relocated') {
    const acc = Number.isFinite(household.pin_fix_accuracy)
      ? ` (±${Math.round(household.pin_fix_accuracy)} m)` : '';
    pinStateEl.textContent = `Pin corrected in the field${by}${at ? ` on ${at}` : ''}${acc}.`;
  } else if (status === 'confirmed') {
    pinStateEl.textContent = `Pin confirmed at the door${by}${at ? ` on ${at}` : ''}.`;
  } else {
    pinStateEl.textContent = 'This pin came from the voter roll.';
  }

  pinConfirmBtn.classList.toggle('active', status === 'confirmed');
  pinHereBtn.classList.toggle('active', status === 'relocated');
  pinUndoBtn.classList.toggle('hidden', !status);
}

async function savePinFix(patch) {
  await saveHousehold(patch);
  renderPinFix(currentHousehold);
}

pinConfirmBtn.addEventListener('click', async () => {
  const walkerName = await getWalkerNameSafe();
  await savePinFix({
    pin_status: 'confirmed',
    pin_fix_lat: null, pin_fix_lon: null, pin_fix_accuracy: null,
    pin_fix_at: new Date().toISOString(),
    pin_fix_by: walkerName || null,
  });
});

pinHereBtn.addEventListener('click', async () => {
  if (!currentFix) {
    // Never silently record the roll's own position as a correction — that
    // would launder a bad pin into "canvasser confirmed" in the master.
    pinStateEl.textContent = 'No GPS fix yet — wait for location, then tap again.';
    return;
  }
  const walkerName = await getWalkerNameSafe();
  await savePinFix({
    pin_status: 'relocated',
    pin_fix_lat: currentFix.lat,
    pin_fix_lon: currentFix.lon,
    pin_fix_accuracy: currentFix.accuracy,
    pin_fix_at: new Date().toISOString(),
    pin_fix_by: walkerName || null,
  });
});

pinUndoBtn.addEventListener('click', async () => {
  await savePinFix({
    pin_status: null, pin_fix_lat: null, pin_fix_lon: null,
    pin_fix_accuracy: null, pin_fix_at: null, pin_fix_by: null,
  });
});

async function getWalkerNameSafe() {
  try {
    const db = await openDB();
    return await getMeta(db, 'walkerName');
  } catch {
    return null;
  }
}

function renderVoters(voters) {
  voterListEl.innerHTML = '';

  if (voters.length === 0) {
    voterListEl.innerHTML = '<p class="hint">No voters recorded at this address.</p>';
    return;
  }

  for (const voter of voters) {
    const row = document.createElement('div');
    const inactive = voter.stale || (voter.tags || []).includes('moved-away');
    row.className = 'voter-row' + (inactive ? ' stale' : '');

    const details = [voter.party, voter.age ? `age ${voter.age}` : null,
      voter.activity_level ? `activity ${voter.activity_level}` : null]
      .filter(Boolean).join(' · ');

    const badges = [
      voter.stale ? '<span class="tag-badge muted">not in latest list</span>' : '',
      ...(voter.tags || []).map((t) => `<span class="tag-badge ${escapeHtml(t)}">${escapeHtml(tagLabel(t))}</span>`),
    ].join(' ');

    row.innerHTML = `
      <div class="voter-name">${escapeHtml(voter.name)}</div>
      ${badges.trim() ? `<div class="tag-row">${badges}</div>` : ''}
      <div class="voter-meta hint">${escapeHtml(details)}</div>
    `;

    const select = document.createElement('select');
    select.className = 'support-select';
    select.setAttribute('aria-label', `Support level for ${voter.name}`);
    for (const level of SUPPORT_LEVELS) {
      const opt = document.createElement('option');
      opt.value = level.value;
      opt.textContent = level.label;
      if ((voter.support_level || 'unknown') === level.value) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      saveVoter(voter.id, { support_level: select.value });
    });

    row.appendChild(select);
    voterListEl.appendChild(row);
  }
}

export async function openSheet(householdId, onChange) {
  onChangeCallback = onChange || null;

  const db = await openDB();
  const household = await get(db, 'households', householdId);
  if (!household) return;
  currentHousehold = household;

  const voters = await getByIndex(db, 'voters', 'householdId', householdId);
  voters.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  addressEl.textContent = household.address;

  const lowConfidence = isLowConfidenceGeocode(
    household.accuracy_type || (voters[0] && voters[0].accuracy_type)
  );
  geoWarningEl.classList.toggle('hidden', !lowConfidence);

  // For ~34 households the roll names a street the county has no record of,
  // while the pin sits on a house the county numbers identically on a
  // neighbouring street. The roll stays verbatim above; this tells the walker
  // what the street sign and the mailbox will actually say.
  const countyAddress = (household.county_address || '').trim();
  countyAddressEl.textContent = countyAddress
    ? `County records this address as ${countyAddress}`
    : '';
  countyAddressEl.classList.toggle('hidden', !countyAddress);

  const hTags = household.tags || [];
  householdTagsEl.innerHTML = hTags
    .map((t) => `<span class="tag-badge ${escapeHtml(t)}">${escapeHtml(tagLabel(t))}</span>`)
    .join(' ');
  householdTagsEl.classList.toggle('hidden', hTags.length === 0);

  renderStatusButtons(household.contact_status);
  renderPinFix(household);
  renderVoters(voters);

  signEl.checked = !!household.sign;
  volunteerEl.checked = !!household.volunteer_interest;
  notesEl.value = household.notes || '';

  savedEl.classList.remove('visible');
  sheetEl.classList.remove('hidden');
}

export function closeSheet() {
  sheetEl.classList.add('hidden');
  currentHousehold = null;
  clearTimeout(notesTimer);
}

export function isSheetOpen() {
  return !sheetEl.classList.contains('hidden');
}

closeBtn.addEventListener('click', closeSheet);

sheetEl.addEventListener('click', (e) => {
  if (e.target === sheetEl) closeSheet();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isSheetOpen()) closeSheet();
});

signEl.addEventListener('change', () => {
  saveHousehold({ sign: signEl.checked });
});

volunteerEl.addEventListener('change', () => {
  saveHousehold({ volunteer_interest: volunteerEl.checked });
});

// Debounced so we're not writing on every keystroke, but short enough that a
// walker who gets interrupted mid-note doesn't lose it.
notesEl.addEventListener('input', () => {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => saveHousehold({ notes: notesEl.value }), 400);
});

// Belt and braces: flush pending note text if the app is backgrounded or the
// phone sleeps before the debounce fires.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && currentHousehold) {
    clearTimeout(notesTimer);
    saveHousehold({ notes: notesEl.value });
  }
});
