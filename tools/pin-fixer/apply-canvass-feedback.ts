// The inbound path: CanvassApp field work -> the master GeoPackage.
//
// QField used to be how a canvasser's notes and pin corrections got back into
// the master. QField is retired (2026-08), so this replaces that loop.
//
// Input is the walker's **backup JSON** (the "Export backup (JSON)" button, the
// one HANDOFF.md says to press first every time). The CSV and GeoJSON exports
// carry the same fields, but the backup is the complete raw dump and is the
// file the walker is already trained to produce.
//
// It writes ONLY into the four things pipeline.py's carry-forward protects:
//     Notes            <- the walker's household note text
//     Pin Status       <- "Confirmed correct" / "Wrong - relocated"
//     geometry + Easting/Northing/Geocodio Latitude/Longitude  <- the GPS fix
//     Canvass Status   <- only for outcomes that mean "this record is wrong"
//
// Anything written here therefore survives the next pipeline run. Contact
// outcomes that are merely progress (talked, not home, refused) are NOT written:
// they are campaign state, they live in the app and its exports, and writing
// them into Canvass Status would delete those households from the next
// export_canvassapp.ps1 run, which soft-deletes any non-blank value.
//
//   deno run --allow-read --allow-write --allow-ffi --allow-env --allow-net \
//     tools/pin-fixer/apply-canvass-feedback.ts <backup.json> [--apply]
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt, buildPt, fwd } from "./proj.ts";

const MASTER = "C:/DRO/Data/v3 Voter Data Edit.gpkg";
const L = "dro_voter_master_final_v3";

// Phone GPS beyond this is too vague to overwrite a geocode with. geo.js already
// discards fixes worse than 50m before they ever reach the button; this is the
// second gate, in case an older export carries one.
const MAX_ACCURACY_M = 30;

// Only outcomes that assert the RECORD is wrong belong in Canvass Status, whose
// vocabulary is defined in geo_io.py. Progress states deliberately map to null.
const CANVASS_STATUS: Record<string, string | null> = {
  moved: "Remove - Moved",
  wrong_address: "Wrong Address",
  talked: null, not_home: null, refused: null, not_visited: null,
};

const args = Deno.args.filter((a) => a !== "--apply");
const APPLY = Deno.args.includes("--apply");
if (!args[0]) {
  console.error("usage: apply-canvass-feedback.ts <backup.json> [--apply]");
  Deno.exit(2);
}

const backup = JSON.parse(Deno.readTextFileSync(args[0]));
if (backup.format !== "dro-canvass-backup") {
  console.error(`not a CanvassApp backup file (format="${backup.format}"). Nothing was changed.`);
  Deno.exit(2);
}
const households = backup.households ?? [];
console.log(`backup: ${households.length} households, ${(backup.voters ?? []).length} voters`);
console.log(`exported ${backup.exported_at ?? "(unknown)"} by app ${backup.app_version ?? "?"}\n`);

function registerGpkgFunctions(db: Database) {
  const empty = (b: unknown) => {
    if (!(b instanceof Uint8Array) || b.length < 8) return 1;
    return (b[3] >> 4) & 1;
  };
  db.function("ST_IsEmpty", (b: unknown) => empty(b));
  db.function("ST_MinX", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).E));
  db.function("ST_MaxX", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).E));
  db.function("ST_MinY", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).N));
  db.function("ST_MaxY", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).N));
}

const M = new Database(MASTER, { readonly: !APPLY });
if (APPLY) registerGpkgFunctions(M);

const addrOf = (h: any) => String(h.address ?? h.id ?? "").trim();
type Act = { addr:string; rows:number; note:string|null; pin:string|null;
             E:number|null; N:number|null; lat:number|null; lon:number|null;
             canvass:string|null; moved:number|null; why:string[] };
const acts: Act[] = []; const skipped: string[] = [];

for (const h of households) {
  const addr = addrOf(h);
  if (!addr) continue;
  const rows = (M.prepare(`SELECT COUNT(*) c FROM "${L}" WHERE "Street Address"=?`).get(addr) as any).c;
  if (!rows) { if (hasWork(h)) skipped.push(`${addr} -- not in the master`); continue; }

  const why: string[] = [];
  const note = (h.notes ?? "").trim() || null;
  if (note) why.push("note");

  const canvass = CANVASS_STATUS[h.contact_status] ?? null;
  if (canvass) why.push(`canvass="${canvass}"`);

  let pin: string|null = null, E: number|null = null, N: number|null = null;
  let lat: number|null = null, lon: number|null = null, moved: number|null = null;

  if (h.pin_status === "confirmed") {
    pin = "Confirmed correct"; why.push("pin confirmed");
  } else if (h.pin_status === "relocated") {
    const acc = Number(h.pin_fix_accuracy);
    if (!Number.isFinite(h.pin_fix_lat) || !Number.isFinite(h.pin_fix_lon)) {
      skipped.push(`${addr} -- pin marked relocated but carries no coordinates`);
    } else if (Number.isFinite(acc) && acc > MAX_ACCURACY_M) {
      skipped.push(`${addr} -- GPS fix too vague (±${Math.round(acc)}m > ${MAX_ACCURACY_M}m)`);
    } else {
      pin = "Wrong - relocated";
      lat = h.pin_fix_lat; lon = h.pin_fix_lon;
      const p = fwd(lat!, lon!); E = p.E; N = p.N;
      const cur = M.prepare(`SELECT geom FROM "${L}" WHERE "Street Address"=? LIMIT 1`).get(addr) as any;
      if (cur?.geom) { const g = parsePt(cur.geom);
        moved = Math.hypot(g.E - E, g.N - N) * 0.3048; }
      why.push(`pin moved ${moved?.toFixed(0) ?? "?"}m (±${Math.round(acc)}m)`);
    }
  }

  if (!why.length) continue;
  acts.push({ addr, rows, note, pin, E, N, lat, lon, canvass, moved, why });
}

function hasWork(h: any) {
  return !!((h.notes ?? "").trim() || h.pin_status || CANVASS_STATUS[h.contact_status]);
}

acts.sort((a,b)=>(b.moved ?? -1)-(a.moved ?? -1));
console.log(`${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
console.log(`households with feedback to write: ${acts.length}   voter rows: ${acts.reduce((t,a)=>t+a.rows,0)}`);
console.log(`skipped: ${skipped.length}\n`);
for (const a of acts)
  console.log(`  ${a.addr.padEnd(26)} ${String(a.rows).padStart(2)} row(s)   ${a.why.join(", ")}`);
if (skipped.length) { console.log(`\n--- skipped ---`); for (const s of skipped) console.log(`  ${s}`); }

if (APPLY) {
  let n = 0;
  M.exec("BEGIN");
  try {
    for (const a of acts) {
      if (a.pin && a.E != null) {
        n += M.prepare(`UPDATE "${L}" SET geom=:g, "Pin Status"=:p,
                        "Location Confidence"='Verified (canvasser confirmed)',
                        Easting=:E, Northing=:N,
                        "Geocodio Latitude"=:lat, "Geocodio Longitude"=:lon
                        WHERE "Street Address"=:a`)
          .run({ g: buildPt(a.E, a.N), p: a.pin, E: a.E, N: a.N, lat: a.lat, lon: a.lon, a: a.addr });
      } else if (a.pin) {
        n += M.prepare(`UPDATE "${L}" SET "Pin Status"=:p,
                        "Location Confidence"='Verified (canvasser confirmed)'
                        WHERE "Street Address"=:a`).run({ p: a.pin, a: a.addr });
      }
      if (a.note !== null)
        M.prepare(`UPDATE "${L}" SET "Notes"=:v WHERE "Street Address"=:a`).run({ v: a.note, a: a.addr });
      if (a.canvass !== null)
        M.prepare(`UPDATE "${L}" SET "Canvass Status"=:v WHERE "Street Address"=:a`).run({ v: a.canvass, a: a.addr });
    }
    M.exec("COMMIT");
  } catch (e) { M.exec("ROLLBACK"); throw e; }
  console.log(`\nwrote feedback for ${acts.length} address(es).`);
  console.log(`Re-run export_canvassapp.ps1 to push the corrected pins back out to the app.`);
}
M.close();
