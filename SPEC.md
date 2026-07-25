# DRO Canvass App — Build Specification

**Project folder:** `C:\DRO\CanvassApp\`
**Owner:** Jed Parker (campaign manager, Cheryl Parker for Del Rey Oaks City Council)
**Purpose:** A phone-based door-to-door canvassing tool for a ~1,600-person city. Replaces a failing QField/QFieldCloud workflow.

---

## 1. What this app does

Two people walk the streets of Del Rey Oaks with phones. As they approach a house, the app shows them who lives there (from the voter roll) and lets them record the conversation. At the end of the day they export the results and pull them into QGIS on a desktop.

**The core loop:**
1. Open app → GPS locates the walker on a map of DRO
2. Nearby households appear as pins, colored by whether they've been contacted
3. Walker approaches a door → the nearest household is auto-highlighted
4. Tap the household → see the 2–4 registered voters at that address
5. Record the outcome (talked / not home / refused, support level per person, sign request, notes)
6. Data saves instantly to the phone
7. End of day → Export button → GeoJSON + CSV to phone downloads → email to self → open in QGIS

---

## 2. NON-NEGOTIABLE PRIVACY CONSTRAINT

**Read this before writing any code.**

The voter roll contains the names, home addresses, ages, and party affiliation of every registered voter in Del Rey Oaks. It is a real file with real people in it.

**Rules:**
- The voter CSV **must never be committed to any git repository**, public or private.
- The voter CSV **must never be bundled into the app build**, hardcoded, or placed in any deployed directory.
- The app ships **empty**. On first run the user picks the CSV from their own phone via a file input. It is parsed in-browser and stored in IndexedDB on that device only.
- **No backend. No server. No third-party API calls with voter data.** Not to an analytics service, not to an error tracker, not to a tile server, not anywhere.
- Add a `.gitignore` at the project root that excludes `*.csv`, `/data/`, and any export output directory, from the very first commit.

If the app is ever deployed to GitHub Pages, the deployed site is publicly readable **even if the repo is private**. This is why the data-loads-from-phone model is mandatory, not a preference.

**Basemap note:** the app needs map tiles. Use a public tile source (OpenStreetMap raster tiles or MapLibre demo tiles). Tile requests leak only the map viewport — the general area of Del Rey Oaks — which is fine. **Never** put voter data, addresses, or names into a tile request, URL parameter, or query string.

---

## 3. Tech stack

- **Static web app (PWA).** No framework required — vanilla JS is fine and preferred for maintainability by a non-web-developer. No build step if avoidable.
- **Map:** MapLibre GL JS (open source, no API key, no Mapbox account).
- **Basemap tiles:** OpenStreetMap raster tiles, or MapLibre's demo vector style. Must not require an account or key.
- **CSV parsing:** PapaParse.
- **Storage:** IndexedDB (use a thin wrapper — `idb` is fine, or hand-rolled). **Do not use localStorage** — the dataset is too large and localStorage is synchronous and size-capped.
- **PWA:** manifest + service worker so it installs to the home screen and the app shell works without signal. Cache the app shell and tiles; the voter data is already local in IndexedDB.
- **Target:** mobile browser, portrait, one-handed use. Phone screen is the only viewport that matters. Desktop is for testing only.

---

## 4. Input data

The user selects a CSV exported from their QGIS workflow. Expected header, exactly:

```
Voter Name,Street Address,City,State,Zip,Party,Age,Activity Level,Geocodio Latitude,Geocodio Longitude,CAIV_East_Feet,CAIV_North_Feet,Geocodio Accuracy Type
```

**Column handling:**

| Column | Use |
|---|---|
| `Voter Name` | Display. Read-only. |
| `Street Address` | **Household grouping key.** Display. Read-only. |
| `City`, `State`, `Zip` | Display only. Read-only. |
| `Party` | Display + filter. Read-only. |
| `Age` | Display. Read-only. |
| `Activity Level` | Display + filter (walk-list prioritization). Read-only. |
| `Geocodio Latitude` | Map position. WGS84. |
| `Geocodio Longitude` | Map position. WGS84. |
| `CAIV_East_Feet` | **Ignore.** State Plane, not usable by a web map. |
| `CAIV_North_Feet` | **Ignore.** Same. |
| `Geocodio Accuracy Type` | Keep in the record; surface as a small warning badge on low-confidence geocodes so the walker knows the pin may be off. |

**Import behavior:**
- Validate the header on import. If columns are missing, show a clear error naming the missing column — do not fail silently or half-import.
- Drop rows with a blank or unparseable lat/lon, and report the count to the user ("412 of 418 rows loaded; 6 skipped, no coordinates").
- Re-importing a newer CSV must **merge, not wipe**: match on `Street Address` + `Voter Name`. Preserve all existing canvass results. New voters get added, departed voters get flagged as stale rather than deleted (never silently destroy field work).

---

## 5. Data model

### Household (derived, not in the CSV)
Grouped by normalized `Street Address`. Normalize case and whitespace before grouping so "123 Main St" and "123 MAIN ST " group together.

```
household {
  id                 // normalized address string
  address            // display form
  lat, lon           // average of member coordinates
  voters[]           // array of voter records
  contact_status     // set at HOUSEHOLD level — see below
  contacted_at       // ISO timestamp, auto
  contacted_by       // walker name, auto from session
  notes              // free text, household level
  sign_request       // bool, household level
}
```

### Voter (one per CSV row)
```
voter {
  id                   // stable hash of address + name
  name, address, city, zip, party, age, activity_level
  lat, lon, accuracy_type
  support_level        // set PER PERSON — see below
}
```

### Field values

`contact_status` (household level, single select):
- `not_visited` (default)
- `talked`
- `not_home`
- `refused`
- `moved`
- `wrong_address`

`support_level` (per voter, single select):
- `unknown` (default)
- `strong_yes`
- `lean_yes`
- `undecided`
- `lean_no`
- `strong_no`

`sign_request` — bool, household level
`volunteer_interest` — bool, household level
`notes` — free text, household level

**Why the split:** the walker knocks on a *door*, so contact outcome is a property of the door. But two people in a house can have different opinions, so support level is per person. Do not collapse these.

---

## 6. Screens

### 6.1 First run / import
- Big, obvious "Load voter list" file picker.
- After import: summary of rows loaded and skipped.
- Prompt for **walker name** (free text, stored for the session, written into `contacted_by`). Two people are walking separately; this is how their work is told apart on merge.

### 6.2 Map (main screen)
- MapLibre map centered on Del Rey Oaks, GPS dot for the walker.
- Household pins colored by `contact_status`:
  - `not_visited` — neutral/gray
  - `talked` — green
  - `not_home` — amber
  - `refused` — red
  - `moved` / `wrong_address` — muted/hatched
- Pin shows a small count badge when a household has more than one voter.
- **Proximity highlight:** `navigator.geolocation.watchPosition()`. Continuously compute the **nearest** household and highlight it — always, with no distance threshold. Show a persistent bottom bar: address + live distance in meters + voter count + "Open" button.

  **Do not use a fixed radius trigger.** Phone GPS is accurate to roughly ±5–10 m, degrading near buildings and tree cover. A radius test at typical lot scale causes the highlight to flicker on and off while the walker is standing still. Nearest-neighbor with a visible distance readout degrades gracefully instead: GPS noise moves a number rather than toggling the UI.

  Apply only a sanity cap: if the nearest household is farther than ~100 m, show nothing (the walker is driving between streets, not approaching a door). Expose this cap as a tunable constant.

  Del Rey Oaks lots run roughly 15–18 m of street frontage, so nearest-neighbor will usually resolve to the correct house. It will occasionally pick the neighbor — this is unavoidable with consumer GPS and is a non-issue as long as the address is displayed prominently for the walker to confirm by eye.

  Also apply light smoothing to the position feed (e.g. ignore fixes with `accuracy` worse than ~50 m, and debounce the nearest-household recalculation to ~1 s) so the readout does not jitter.

  This is the feature that makes the app work while walking — get it right, and test it on foot.
- A filter control: by `Activity Level`, by `Party`, and by "hide already contacted."
- A live counter somewhere visible: contacted today / remaining.

### 6.3 Household sheet (tap a pin, or tap the proximity bar)
- Address as the header.
- `contact_status` as large tap targets — this is the most-used control in the app. Make the buttons big enough to hit while standing on a doorstep holding a clipboard.
- List of voters at that address, each with name, party, age, activity level, and their own `support_level` selector.
- Household-level toggles: sign request, volunteer interest.
- Notes text area.
- Everything **autosaves on change.** No save button. A walker will not remember to press save, and losing field data is unacceptable.
- Low-confidence geocode badge if `Geocodio Accuracy Type` indicates an approximate match.

### 6.4 Export
- Two buttons: **Export GeoJSON** (for QGIS) and **Export CSV** (for spreadsheets).
- Filename includes walker name and date: `dro_canvass_jed_2026-07-25.geojson`.
- GeoJSON: one feature per household, point geometry, all household fields plus a nested/flattened voter array with support levels.
- CSV: one row per **voter** (not household), with household fields repeated across that household's rows — this is what merges cleanly back into QGIS via a join.
- Export must include untouched households too, so the file is a complete picture, not just a diff. Add a `contact_status` of `not_visited` for those.
- Also offer **Export backup (JSON)** — a full raw dump of IndexedDB. This is the safety net; tell the user to do it at the end of every walk.

---

## 7. Build order

Build and verify in this sequence. Do not move on until each step works on an actual phone.

1. **Skeleton + privacy plumbing.** Project structure, `.gitignore` (CSV excluded from the first commit), PWA manifest, service worker, installs to home screen.
2. **CSV import → IndexedDB.** File picker, PapaParse, header validation, household grouping, skipped-row reporting. Verify with the real file locally.
3. **Map + pins.** MapLibre, OSM tiles, household pins from IndexedDB, status colors.
4. **GPS + proximity highlight.** `watchPosition`, nearest-household calculation, bottom bar. **Test this outdoors, on foot** — desktop simulation will not surface the real problems (GPS drift, battery, screen readability in sun).
5. **Household sheet + editing.** All fields, autosave.
6. **Export.** GeoJSON, CSV, backup JSON.
7. **Filters and counters.** Walk-list prioritization, progress display.

---

## 8. Explicit non-goals (do not build these)

- **No backend, no sync server, no user accounts.** Two walkers produce two files; they get merged manually in QGIS. This is correct for a city of 1,600. Do not add a server "for later."
- **No cloud storage of any kind.**
- **No analytics, telemetry, or error reporting services.**
- **No photo capture** in v1.
- **No routing or turn-by-turn.** The walkers know the town.
- **No desktop-optimized layout.** Phone only.

---

## 9. Testing notes

- The real test is a walk around a block with a phone, not a browser at a desk.
- Verify autosave survives: force-quitting the app, phone going to sleep mid-form, and airplane mode.
- Verify the app works with **no cell signal** after first load — this is the whole point of local storage. DRO has coverage gaps.
- Verify the export file actually opens in QGIS before relying on it in the field.
- Sun readability: high contrast, large text. A phone screen at noon is a real constraint.

---

## 10. Handoff checklist

Before this is considered done:
- [ ] `.gitignore` excludes all CSV and export output, present in the first commit
- [ ] No voter data anywhere in the repo, in any commit, at any point in history
- [ ] App loads and runs with no network after first install
- [ ] Full walk-through tested outdoors on a real phone
- [ ] Export verified to open correctly in QGIS
- [ ] Backup export tested and documented for the user
