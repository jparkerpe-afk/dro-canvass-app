# Handoff: phone ↔ computer

The loop is: **change code on the computer → deploy → phone picks it up →
walk and collect → bring data home → repeat.**

Three things can silently go wrong, and each has a check below:

1. The phone runs old cached code without telling you.
2. A day's field work never leaves the phone.
3. You edit on the computer while something different is live.

Live site: **https://jparkerpe-afk.github.io/dro-canvass-app/**

---

## A. Computer → phone (deploying a change)

**1. Bump the version.** Edit `js/version.js`:

```js
self.APP_VERSION = '2026.07.26-01';   // YYYY.MM.DD-NN
```

This is the whole update mechanism. The service worker's cache name and its
own URL both derive from this string, so **if you don't bump it, phones will
keep serving the old app.** Bump it every single deploy, even for a one-line
change.

**2. Commit and push.**

```bash
git add -A && git commit -m "..." && git push
```

**3. Wait ~1 minute** for GitHub Pages to build, then verify:

```bash
bash tools/check-deploy.sh
```

It prints `ALL CLEAR` only when the working tree is clean, your commit is
pushed, the live site serves the same version string as your folder, and no
CSV has ever entered git history. Anything else prints `WRONG` with the
reason.

---

## B. On the phone (confirming you have the latest)

Open the app → **Import** tab → scroll to **Version**.

- The version shown is what you are *actually running*, not what is deployed.
- Tap **Check for update**. This deliberately bypasses the offline cache and
  reads the deployed version off the network, so a stale build can still
  discover it is stale.
- If a newer version exists it downloads in the background and a
  **Update now** button appears. Tap it; the app reloads on the new version.
- Compare the number on screen against `js/version.js` on the computer. If
  they match, you are current. That is the whole check.

Your canvass data is **not** touched by an update — it lives in the phone's
database, separate from the app code.

### One-time note for the first versioned deploy

Phones that already installed an older build have no Version panel yet, so
they cannot tap Check for update. For that one transition: fully close the
app (swipe it away from the app switcher, don't just background it) and
reopen. If it still looks old, in Chrome go to Settings → Site settings →
Data stored → the site → Delete data, then reload. You will need to re-import
the CSV after clearing data.

---

## C. Phone → computer (bringing the day's work home)

At the end of **every** walk, before you do anything else:

Open the app → **Import** tab → **End of walk**:

1. **Export backup (JSON)** — do this first, every time. It is a complete raw
   dump and the only thing that can fully restore a day's work.
2. **Export GeoJSON** — for QGIS.
3. **Export CSV** — one row per voter, household fields repeated, joins
   cleanly back into QGIS.

Files land in the phone's Downloads folder, named
`dro_canvass_<walker>_<date>.*` — the walker name comes from what you set in
the Walker name box, which is also written into every household you contact,
so two people's work can be told apart on merge.

Get them to the computer however you like (email to yourself, USB, cloud
drive). **Do not commit them to this repo** — `.gitignore` already blocks
`*.csv` and `/data/`, and that is deliberate.

Exports include untouched households too (as `not_visited`), so each file is
a complete picture of the city, not just a diff.

---

## D. Two walkers

Each phone is independent — there is no server and no sync. Two walkers
produce two sets of files, merged manually in QGIS. That is by design for a
city of 1,600. Each walker should set a distinct **Walker name** before
starting so `contacted_by` tells the work apart.

---

## E. The privacy rule that does not bend

The voter CSV never goes in git, never gets committed, never gets deployed.
It is loaded from the phone's own storage at runtime and lives only in that
phone's database.

The deployed site is publicly readable — that is expected and safe, because
the app ships empty. `tools/check-deploy.sh` re-checks both halves of this
(nothing in history, nothing reachable at `/data/`) every time you run it.
