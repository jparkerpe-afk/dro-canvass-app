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
const householdTagsEl = document.getElementById('sheet-household-tags');
const statusButtonsEl = document.getElementById('status-buttons');
const voterListEl = document.getElementById('voter-list');
const signRequestEl = document.getElementById('sign-request');
const volunteerEl = document.getElementById('volunteer-interest');
const notesEl = document.getElementById('household-notes');
const savedEl = document.getElementById('sheet-saved');
const closeBtn = document.getElementById('sheet-close');

let currentHousehold = null;
let onChangeCallback = null;
let savedTimer = null;
let notesTimer = null;

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

  const hTags = household.tags || [];
  householdTagsEl.innerHTML = hTags
    .map((t) => `<span class="tag-badge ${escapeHtml(t)}">${escapeHtml(tagLabel(t))}</span>`)
    .join(' ');
  householdTagsEl.classList.toggle('hidden', hTags.length === 0);

  renderStatusButtons(household.contact_status);
  renderVoters(voters);

  signRequestEl.checked = !!household.sign_request;
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

signRequestEl.addEventListener('change', () => {
  saveHousehold({ sign_request: signRequestEl.checked });
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
