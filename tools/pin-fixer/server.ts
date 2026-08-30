// Pin Fixer — local-only server for correcting misgeocoded voter pins.
//
// WHY THIS EXISTS
// Geocodio flagged 59 household addresses as "Approximate -- verify in person".
// Every one of those 59 is absent from the county's official address-point
// layer (DROAddresses.gpkg) — which is *why* Geocodio fell back to
// street-centerline interpolation and dropped them in roads and intersections.
// Because no authoritative record exists for them, no automated snap can place
// them: nearest-building matching confidently picks the wrong house whenever
// the original interpolation landed on the wrong street. They need human eyes.
//
// This tool makes that human step fast: one address at a time, on the same
// Google Hybrid imagery the QGIS project uses (house numbers painted on
// roofs), with nearby *known* county addresses labeled for orientation. Click
// the correct roof, it writes straight back to the GeoPackage.
//
// PRIVACY: runs on localhost only. Voter data never leaves this machine. The
// only outbound requests are map tiles, which leak the viewport (the same
// thing QGIS already does) and never carry an address or a name.
//
// Run:  deno run --allow-read --allow-write --allow-net --allow-ffi --allow-env server.ts
// Then: http://localhost:8777

import { Database } from "jsr:@db/sqlite@0.12";
import { fwd, inv, parsePt, buildPt } from "./proj.ts";

// The live master. Since the 2026 roll refresh this is the source of truth;
// the old DRO_Voter_PinFix copy is a July snapshot and writing to it now would
// strand the correction.
const VOTER_GPKG = "C:/DRO/Data/v3 Voter Data Edit.gpkg";
const ADDR_GPKG = "C:/DRO/Data/DROAddresses.gpkg";
const LAYER = "dro_voter_master_final_v3";
const PORT = 8777;
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Where the correction gets recorded. Reuses the Pin Status vocabulary already
// present in the layer rather than inventing new terms.
const PIN_STATUS_FIXED = "Wrong - relocated";
// A pin placed by eye from aerial imagery is NOT ground truth — it is a
// best guess that the walker still has to confirm at the door. The wording
// starts with "Approximate" on purpose: js/sheet.js isLowConfidenceGeocode()
// keys off that word to show the "pin may be off" badge in the canvass app,
// whereas anything containing "verified" is treated as trustworthy and would
// suppress the warning. Reserve "Verified (canvasser confirmed)" for pins
// actually confirmed on foot.
const CONFIDENCE_FIXED = "Approximate -- manually placed from imagery, walker to verify";

// The layer carries the standard GeoPackage R-tree triggers, which call
// ST_IsEmpty/ST_MinX/... on every geometry update. Those are SpatiaLite
// functions that plain SQLite does not have, so an UPDATE fails with
// "no such function: ST_IsEmpty". Dropping the triggers would let writes
// through but silently leave the spatial index stale — QGIS would then draw
// pins from a bounding box that no longer matches the geometry. Implementing
// the five functions instead keeps the index correct by the file's own rules.
function registerGpkgFunctions(db: Database) {
  const empty = (b: unknown) => {
    if (!(b instanceof Uint8Array) || b.length < 8) return 1;
    return (b[3] >> 4) & 1; // GeoPackageBinary header flags, bit 4 = empty
  };
  db.function("ST_IsEmpty", (b: unknown) => empty(b));
  db.function("ST_MinX", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).E));
  db.function("ST_MaxX", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).E));
  db.function("ST_MinY", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).N));
  db.function("ST_MaxY", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).N));
}

function openVoters(readonly = true) {
  const db = new Database(VOTER_GPKG, { readonly });
  if (!readonly) registerGpkgFunctions(db);
  return db;
}

// ---- Reference layer: county address points, for on-map orientation ----

type RefPt = { label: string; lat: number; lon: number };
let refPoints: RefPt[] = [];
try {
  const adb = new Database(ADDR_GPKG, { readonly: true });
  const rows = adb.prepare(
    `SELECT geom, NUMBER_ as num, STREET as st FROM DROAddresses`,
  ).all() as any[];
  for (const r of rows) {
    if (!r.geom) continue;
    const p = parsePt(r.geom);
    const ll = inv(p.E, p.N);
    refPoints.push({ label: `${r.num ?? ""} ${r.st ?? ""}`.trim(), lat: ll.lat, lon: ll.lon });
  }
  adb.close();
  console.log(`Loaded ${refPoints.length} county address reference points.`);
} catch (err) {
  console.warn(`Could not load ${ADDR_GPKG}: ${(err as Error).message}`);
}

// ---- The work list ----

type Household = {
  address: string;
  lat: number;
  lon: number;
  voters: string[];
  fids: number[];
  pinStatus: string | null;
  confidence: string | null;
  overlaps?: { addr: string; m: number }[];
};

const RECHECK = Deno.args.includes("--recheck");

// --review <backup.json>  : step through the households actually walked, in
// street order, and judge each pin. This is the mode that matters after a walk
// where the map felt wrong: the walker has just seen these houses, so their
// verdict is ground truth, and "the pin is right" is as valuable to record as
// "the pin is wrong" -- a confirmed pin is one the tools will never touch again.
const REVIEW_IDX = Deno.args.indexOf("--review");
const REVIEW_FILE = REVIEW_IDX >= 0 ? Deno.args[REVIEW_IDX + 1] : null;
// Optional street filter, e.g. --street "Portola"
const STREET_IDX = Deno.args.indexOf("--street");
const STREET = STREET_IDX >= 0 ? (Deno.args[STREET_IDX + 1] ?? "").toUpperCase() : null;

function reviewAddresses(): string[] {
  if (!REVIEW_FILE) return [];
  const b = JSON.parse(Deno.readTextFileSync(REVIEW_FILE));
  const walked = (b.households ?? [])
    .filter((h: any) => h.contact_status && h.contact_status !== "not_visited")
    .map((h: any) => String(h.address ?? h.id).trim())
    .filter((a: string) => !STREET || a.toUpperCase().includes(STREET));
  // Street order, so the review runs the way the walk did rather than jumping
  // around town.
  const key = (a: string) => {
    const m = a.match(/^(\d+)\s+(.*)$/);
    return m ? [m[2].toUpperCase(), Number(m[1])] as const : [a.toUpperCase(), 0] as const;
  };
  return [...new Set<string>(walked)].sort((x, y) => {
    const [sx, nx] = key(x), [sy, ny] = key(y);
    return sx === sy ? nx - ny : sx.localeCompare(sy);
  });
}
// --questionable : queue everything that is currently doubtful, worst first.
// Condos and the out-of-coverage addresses are deliberately excluded: clicking a
// roof cannot improve either (see build-review-report.ts for why), so putting
// them in a click queue would only waste the operator's attention.
const QUESTIONABLE = Deno.args.includes("--questionable");

function questionableAddresses(): string[] {
  const db = openVoters(true);
  const rows = db.prepare(`
    SELECT "Street Address" AS addr, geom, "Location Confidence" AS conf,
           "Pin Status" AS pin, "Correction" AS rev
    FROM "${LAYER}" GROUP BY addr
  `).all() as any[];
  db.close();
  const CONDO = /QUAIL RUN|PHEASANT RIDGE/i;
  const OUTSIDE = /CALLE DEL OAKS|MONTEREY SALINAS/i;
  const verified = (r: any) =>
    String(r.pin ?? "") === "Confirmed correct" || /canvasser confirmed/i.test(String(r.conf ?? ""));

  // Already looked at in a previous pass -- do not re-serve it. Pass
  // --include-reviewed to go over them again anyway.
  const reviewed = (r: any) => /pin reviewed/i.test(String(r.rev ?? ""));
  const AGAIN = Deno.args.includes("--include-reviewed");
  const live = rows.filter((r) => r.geom && !CONDO.test(r.addr) && !OUTSIDE.test(r.addr)
    && !verified(r) && (AGAIN || !reviewed(r)));
  // stacked: two households sharing one position
  const byPos = new Map<string, any[]>();
  for (const r of live) { const p = parsePt(r.geom); const k = `${p.E.toFixed(2)},${p.N.toFixed(2)}`;
    if (!byPos.has(k)) byPos.set(k, []); byPos.get(k)!.push(r); }
  const stacked = new Set<string>();
  for (const [, g] of byPos) {
    if (g.length < 2) continue;
    if (g.some((x) => /APT|UNIT/i.test(x.addr))) continue;  // flats in one building
    for (const x of g) stacked.add(String(x.addr).trim());
  }
  const approx = live
    .filter((r) => /approximate|estimated/i.test(String(r.conf ?? "")))
    .map((r) => String(r.addr).trim())
    .filter((a) => !stacked.has(a));

  const street = (a: string) => { const m = a.match(/^(\d+)\s+(.*)$/);
    return m ? [m[2].toUpperCase(), Number(m[1])] as const : [a.toUpperCase(), 0] as const; };
  const bySt = (x: string, y: string) => { const [sx,nx]=street(x), [sy,ny]=street(y);
    return sx === sy ? nx - ny : sx.localeCompare(sy); };
  // worst first: two households on one roof beats a lone uncertain pin
  const list = [...[...stacked].sort(bySt), ...approx.sort(bySt)];
  console.log(`Questionable mode: ${stacked.size} stacked + ${approx.length} unconfirmed = ${list.length}`);
  return list;
}

const REVIEW_ADDRESSES = QUESTIONABLE ? questionableAddresses() : reviewAddresses();
const REVIEW = REVIEW_ADDRESSES.length > 0;
if (REVIEW && !QUESTIONABLE) {
  console.log(`Review mode: ${REVIEW_ADDRESSES.length} household(s) walked` +
    (STREET ? ` on ${STREET}` : "") + `, in street order.`);
}
// Two households on one roof, within this distance, are treated as suspect.
const OVERLAP_METERS = 5;

// Strips unit designators so "11 Loch Pl Apt B" and "11 Loch Pl" collapse to
// one building. Those genuinely share a roof and are never an error.
function baseAddress(a: string) {
  return a.trim().toUpperCase().replace(/\./g, "")
    .replace(/\s+(APT|UNIT|STE|SUITE|#|BLDG)\s*\S+$/, "")
    .replace(/\s+/g, " ").trim();
}

// Quail Run Ct and Pheasant Ridge Rd are a condo complex using X10/X11/X12
// unit numbering within shared buildings. Neighbouring units there really do
// sit a metre apart, so flagging them buries the handful of genuine errors
// under ~90 false positives. A condo address is still checked against a
// non-condo one — only condo-vs-condo pairs are ignored.
const CONDO_STREETS = /(PHEASANT RIDGE|QUAIL RUN)/;
const isCondo = (addr: string) => CONDO_STREETS.test(baseAddress(addr));

// address -> the other addresses sharing its spot, with separation in metres.
// Computed from the data rather than hardcoded, so it cannot go stale as pins
// move. Deliberately ignores Location Confidence: a "Verified (rooftop)"
// geocode can be confidently wrong (220/221 Pheasant Ridge Rd share a point
// and were never flagged), so trusting that field would hide the very errors
// this pass exists to catch.
function computeOverlaps(): Map<string, { addr: string; m: number }[]> {
  const db = openVoters(true);
  const rows = db.prepare(
    `SELECT "Street Address" AS addr, geom FROM "${LAYER}" GROUP BY "Street Address"`,
  ).all() as any[];
  db.close();

  const hs: { addr: string; E: number; N: number }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.geom) continue;
    const b = baseAddress(r.addr);
    if (seen.has(b)) continue; // same building, different unit
    seen.add(b);
    const p = parsePt(r.geom);
    hs.push({ addr: r.addr, E: p.E, N: p.N });
  }

  const limitFt = OVERLAP_METERS / 0.3048;
  const out = new Map<string, { addr: string; m: number }[]>();
  const push = (a: string, b: string, m: number) => {
    if (!out.has(a)) out.set(a, []);
    out.get(a)!.push({ addr: b, m });
  };
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      if (isCondo(hs[i].addr) && isCondo(hs[j].addr)) continue;
      const ft = Math.hypot(hs[i].E - hs[j].E, hs[i].N - hs[j].N);
      if (ft >= limitFt) continue;
      const m = +(ft * 0.3048).toFixed(1);
      push(hs[i].addr, hs[j].addr, m);
      push(hs[j].addr, hs[i].addr, m);
    }
  }
  return out;
}

const RECHECK_ADDRESSES = RECHECK ? [...computeOverlaps().keys()].sort() : [];
if (RECHECK) {
  console.log(
    `Recheck mode: ${RECHECK_ADDRESSES.length} addresses overlap another within ${OVERLAP_METERS}m ` +
    `(condo-vs-condo pairs excluded).`,
  );
  for (const a of RECHECK_ADDRESSES) console.log(`   ${a}`);
}

function loadHouseholds(): { todo: Household[]; done: Household[] } {
  const db = openVoters(true);
  // In recheck mode the Pin Status filter is deliberately bypassed: these
  // addresses have already been "fixed" once, so the normal query would put
  // every one of them in `done` and leave nothing to review.
  const rows = REVIEW
    ? db.prepare(`
        SELECT fid, geom, "Street Address" AS addr, "Voter Name" AS name,
               "Location Confidence" AS conf, "Pin Status" AS pin
        FROM "${LAYER}"
        WHERE "Street Address" IN (${REVIEW_ADDRESSES.map((_, i) => `:a${i}`).join(",")})
      `).all(Object.fromEntries(REVIEW_ADDRESSES.map((a, i) => [`a${i}`, a]))) as any[]
    : RECHECK
    ? db.prepare(`
        SELECT fid, geom, "Street Address" AS addr, "Voter Name" AS name,
               "Location Confidence" AS conf, "Pin Status" AS pin
        FROM "${LAYER}"
        WHERE "Street Address" IN (${RECHECK_ADDRESSES.map((_, i) => `:a${i}`).join(",")})
        ORDER BY addr
      `).all(Object.fromEntries(RECHECK_ADDRESSES.map((a, i) => [`a${i}`, a]))) as any[]
    : db.prepare(`
        SELECT fid, geom, "Street Address" AS addr, "Voter Name" AS name,
               "Location Confidence" AS conf, "Pin Status" AS pin
        FROM "${LAYER}"
        WHERE "Location Confidence" LIKE 'Approximate%'
        ORDER BY addr
      `).all() as any[];
  db.close();

  const byAddr = new Map<string, Household>();
  for (const r of rows) {
    if (!r.geom) continue;
    const p = parsePt(r.geom);
    const ll = inv(p.E, p.N);
    let h = byAddr.get(r.addr);
    if (!h) {
      h = {
        address: r.addr, lat: ll.lat, lon: ll.lon,
        voters: [], fids: [], pinStatus: r.pin, confidence: r.conf,
      };
      byAddr.set(r.addr, h);
    }
    h.voters.push(r.name);
    h.fids.push(r.fid);
    // A household already relocated shows its moved position.
    if (r.pin === PIN_STATUS_FIXED) h.pinStatus = PIN_STATUS_FIXED;
  }

  const all = [...byAddr.values()];
  if (REVIEW) {
    // Keep the walk's street order, and treat anything already confirmed at a
    // door as finished so a second pass does not re-ask settled questions.
    const order = new Map(REVIEW_ADDRESSES.map((a, i) => [a, i]));
    all.sort((x, y) => (order.get(x.address) ?? 0) - (order.get(y.address) ?? 0));
    const settled = (h: Household) =>
      h.pinStatus === "Confirmed correct" || /canvasser confirmed/i.test(h.confidence ?? "");
    return { todo: all.filter((h) => !settled(h)), done: all.filter(settled) };
  }
  if (RECHECK) {
    const partners = computeOverlaps();
    for (const h of all) h.overlaps = partners.get(h.address) ?? [];
    // Everything here has already been placed once, so nothing is "done" —
    // the operator confirms or re-places each in turn.
    return { todo: all, done: [] };
  }
  return {
    todo: all.filter((h) => h.pinStatus !== PIN_STATUS_FIXED),
    done: all.filter((h) => h.pinStatus === PIN_STATUS_FIXED),
  };
}

// Every other household, shown as context so the operator can read the
// numbering pattern along the street. Hand-placed pins are included and marked
// distinctly: when two of them were put on the same roof, seeing the *other*
// one is the whole point of a recheck, and a label that only covered
// county-verified addresses would hide exactly the pin in question.
function loadAllHouseholds(): (RefPt & { manual: boolean })[] {
  const db = openVoters(true);
  const rows = db.prepare(`
    SELECT "Street Address" AS addr, geom, "Location Confidence" AS conf
    FROM "${LAYER}"
    GROUP BY "Street Address"
  `).all() as any[];
  db.close();
  const out: (RefPt & { manual: boolean })[] = [];
  for (const r of rows) {
    if (!r.geom) continue;
    const p = parsePt(r.geom);
    const ll = inv(p.E, p.N);
    out.push({
      label: r.addr, lat: ll.lat, lon: ll.lon,
      manual: String(r.conf ?? "").startsWith("Approximate"),
    });
  }
  return out;
}

// ---- Writing a correction ----

function applyFix(address: string, lat: number, lon: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("lat/lon must be finite numbers");
  }
  // Sanity fence around Del Rey Oaks. A click that lands outside this box is a
  // bug (or a stray tap), not a real correction — refuse rather than corrupt.
  if (lat < 36.55 || lat > 36.63 || lon < -121.90 || lon > -121.79) {
    throw new Error(`refusing out-of-area coordinate ${lat},${lon}`);
  }

  const { E, N } = fwd(lat, lon);
  const db = openVoters(false);
  try {
    const stmt = db.prepare(`
      UPDATE "${LAYER}"
         SET geom = :geom,
             "Easting" = :e,
             "Northing" = :n,
             "Geocodio Latitude" = :lat,
             "Geocodio Longitude" = :lon,
             "Pin Status" = :pin,
             "Location Confidence" = :conf,
             "Correction" = :rev
       WHERE "Street Address" = :addr
    `);
    const changes = stmt.run({
      geom: buildPt(E, N),
      e: E, n: N, lat, lon,
      pin: PIN_STATUS_FIXED, conf: CONFIDENCE_FIXED,
      // Stamp that a human has now LOOKED at this one. The confidence stays
      // "Approximate" -- a roof clicked from imagery is not a door confirmation
      // and the walker must still get the badge -- but without this the
      // questionable queue re-serves every pin it was just given, and the pass
      // never ends. Carried through pipeline runs, so the review is not lost.
      rev: `pin reviewed ${new Date().toISOString().slice(0, 10)}`,
      addr: address,
    });
    return { changes, E, N };
  } finally {
    db.close();
  }
}

// "The pin is right" -- recorded by someone who has just stood in front of the
// house. This is the strongest statement in the whole dataset: it outranks the
// county layer and the parcels, and every tool here refuses to move a pin
// carrying it.
function confirmPin(address: string) {
  const db = openVoters(false);
  try {
    const changes = db.prepare(`
      UPDATE "${LAYER}"
      SET "Pin Status" = 'Confirmed correct',
          "Location Confidence" = 'Verified (canvasser confirmed)'
      WHERE "Street Address" = :addr
    `).run({ addr: address });
    return { changes };
  } finally {
    db.close();
  }
}

function revertFix(address: string) {
  const db = openVoters(false);
  try {
    // Restores the flag only. Geometry stays where it was put — the operator
    // is expected to re-place it; silently teleporting the pin back to a known
    // wrong spot would lose the work without saying so.
    const changes = db.prepare(`
      UPDATE "${LAYER}"
         SET "Pin Status" = NULL,
             "Location Confidence" = 'Approximate -- verify in person'
       WHERE "Street Address" = :addr
    `).run({ addr: address });
    return { changes };
  } finally {
    db.close();
  }
}

// ---- HTTP ----

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function serveFile(path: string, contentType: string) {
  try {
    const data = await Deno.readFile(path);
    return new Response(data, { headers: { "content-type": contentType } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return await serveFile(`${HERE}/index.html`, "text/html; charset=utf-8");
  }
  if (url.pathname === "/maplibre-gl.js") {
    return await serveFile("C:/DRO/CanvassApp/js/vendor/maplibre-gl.js", "text/javascript");
  }
  if (url.pathname === "/maplibre-gl.css") {
    return await serveFile("C:/DRO/CanvassApp/css/vendor/maplibre-gl.css", "text/css");
  }

  if (url.pathname === "/api/state") {
    const { todo, done } = loadHouseholds();
    // Recomputed per request so a pin moved a moment ago shows in its new spot.
    return json({ todo, done, refPoints, verifiedPoints: loadAllHouseholds(),
                  recheck: RECHECK, review: REVIEW });
  }

  if (url.pathname === "/api/fix" && req.method === "POST") {
    try {
      const { address, lat, lon } = await req.json();
      const r = applyFix(address, lat, lon);
      console.log(`FIXED ${address} -> ${lat.toFixed(6)},${lon.toFixed(6)} (${r.changes} rows)`);
      return json({ ok: true, ...r });
    } catch (err) {
      console.error("fix failed:", (err as Error).message);
      return json({ ok: false, error: (err as Error).message }, 400);
    }
  }

  if (url.pathname === "/api/confirm" && req.method === "POST") {
    try {
      const { address } = await req.json();
      const r = confirmPin(address);
      console.log(`CONFIRMED ${address} (${r.changes} rows)`);
      return json({ ok: true, ...r });
    } catch (err) {
      console.error("confirm failed:", (err as Error).message);
      return json({ ok: false, error: (err as Error).message }, 400);
    }
  }

  if (url.pathname === "/api/revert" && req.method === "POST") {
    try {
      const { address } = await req.json();
      const r = revertFix(address);
      console.log(`REVERTED flag on ${address} (${r.changes} rows)`);
      return json({ ok: true, ...r });
    } catch (err) {
      return json({ ok: false, error: (err as Error).message }, 400);
    }
  }

  return new Response("not found", { status: 404 });
});

console.log(`\n  Pin Fixer running:  http://localhost:${PORT}`);
console.log(`  Writing to: ${VOTER_GPKG}`);
console.log(`  (keep QGIS closed while this is running)\n`);
