// Corrections derived from Jed's onX parcel screenshots (2026-08-23), applied
// against the county parcel polygons in DROParcels.gpkg.
//
// The Baxter Place rows resolve cleanly. onX prints owners north to south as
// Graham / Thomas / Kreeger on the west side and Hinds / Raskoff / Sampognaro on
// the east. Walking the parcels north to south gives exactly that order, and the
// three already-correct households (Graham 7, Hinds 8, Raskoff 4) land on their
// own parcels -- which is what makes the reading trustworthy rather than a guess.
//
// That leaves the two southern corner parcels, which front Quendale Avenue:
//   012-501-010-000  is KREEGER   -> 3 Quendale Ave   (currently holds 3 Baxter Pl)
//   012-501-018-000  is SAMPOGNARO-> 5 Quendale Ave   (currently holds nobody)
// and pushes Thomas/Economou up one:
//   012-501-011-000  is THOMAS    -> 3 Baxter Pl      (currently holds nobody)
//
// The county has TWO address points labelled "3 BAXTER", 21m apart, one on each
// of 010 and 011. The roll's 3 Baxter Pl household was geocoded onto the southern
// copy -- i.e. onto Kreeger's house. Moving Kreeger there without also moving
// 3 Baxter Pl off it would just re-stack two households on one roof, so both move.
//
// Positions are parcel CENTROIDS, not surveyed rooftops. On these lots the house
// covers most of the parcel so the centroid lands on or beside it, but it is not
// a GPS fix at the door, and the confidence string says so.
//
//   deno run --allow-read --allow-write --allow-ffi --allow-env --allow-net \
//     tools/pin-fixer/apply-onx-corrections.ts [--apply]
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt, buildPt, inv } from "./proj.ts";

const MASTER = "C:/DRO/Data/v3 Voter Data Edit.gpkg";
const L = "dro_voter_master_final_v3";
const APPLY = Deno.args.includes("--apply");

const CONF = "Approximate -- parcel centroid, owner confirmed against onX; " +
  "walker to confirm at the door";

// address -> the parcel it actually occupies
const MOVES: [string, string][] = [
  ["3 Quendale Ave", "012-501-010-000"],
  ["3 Baxter Pl",    "012-501-011-000"],
  // Same correction on the east side of the cul-de-sac: 018 is the southern
  // corner parcel, carries the county's "5 BAXTER" point, and has no household.
  // The roll has no 5 Baxter Pl at all, so nothing is displaced by this one.
  ["5 Quendale Ave", "012-501-018-000"],

  // The rest of the parked Quendale households. Every one of these parcels is
  // the southern corner of its cul-de-sac, carries a county point whose NUMBER
  // matches the roll's Quendale number, and is currently EMPTY -- so no other
  // household is displaced. onX names the owner at each: Palmerini, Pesic,
  // Chinn, Kageyama, Abergel.
  ["9 Quendale Ave",        "012-501-019-000"],
  ["21 Quendale Ave",       "012-501-036-000"],
  ["25 Quendale Ave Apt B", "012-501-037-000"],
  ["27 Quendale Ave",       "012-501-045-000"],
  ["31 Quendale Ave",       "012-501-046-000"],
  ["30 Quendale Ave",       "012-503-011-000"],

  // The last two, and the households they displace. Jed clicked both parcels in
  // onX on 2026-08-23:
  //   BROTT DONNA L  @ 36.59613,-121.83593  tax address 1816 Saint Helena St, Seaside
  //   DUBAS KATHLEEN E @ 36.59614,-121.83566  tax address *15 QUENDALE AVE* -- the
  //     owner's own mailing address is the site address, which settles it outright.
  // Both parcels currently hold the cul-de-sac household instead, so those move
  // north to the only remaining parcel carrying their own street number.
  ["11 Quendale Ave", "012-501-027-000"],
  ["11 Hillwil Pl",   "012-501-022-000"],
  ["15 Quendale Ave", "012-501-028-000"],
  ["15 Brae Pl",      "012-501-032-000"],

  // Setter Place, same shape again. onX prints the two columns flanking Setter as
  // Charamut/Valladao/Yeo on the west and O'Loughlin/Brimm/Myles on the east, and
  // the parcels fall in exactly those two longitude columns. So the EAST column's
  // southern corner is Myles (1 Quendale) and the WEST column's is Yeo
  // (1 Setter Pl) -- the roll had Yeo on the east one, i.e. on Myles's house.
  ["1 Quendale Ave", "012-501-009-000"],
  ["1 Setter Pl",    "012-501-001-000"],
];

// Absentee owner -> the household renting from them. onX tax addresses are
// elsewhere, so the people the roll lists are tenants, not owners. The roll's own
// Occupancy field says "Owner" for all of these and is not to be trusted: it
// reports 1124 owners against 56 renters across 1180 records.
const RENTERS: [string, string][] = [
  ["4 Hillwil Pl",   "Owner of record is Sullivan Suzie Marie (tax address Pacific Grove) - occupants are tenants. [onX 2026-08-23]"],
  ["4 Brae Pl",      "Owner of record is Carnazzo Daniel J (tax address Monterey) - occupants are tenants. [onX 2026-08-23]"],
  ["11 Quendale Ave","Owner of record is Brott Donna L (tax address Seaside) - occupants are tenants. [onX 2026-08-23]"],
  ["7 Baxter Pl",    "Owner of record is Graham Gerald H, who lives at 1019 Rosita Rd - family-owned, not a rental. [onX 2026-08-23]"],
  // Placed by the same column reading that resolved 1 Quendale: Brimm is the
  // middle parcel of Setter's east column, which is 4 Setter Pl.
  ["4 Setter Pl",    "Owner of record is Brimm Yuriko (tax address Berkeley) - occupants are tenants. [onX 2026-08-23]"],
];

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

// GeoPackage MultiPolygonZ: 1000-series WKB types carry a Z, so 24 bytes a vertex.
function parsePoly(buf: Uint8Array) {
  const flags = buf[3], env = (flags >> 1) & 7, hl = 8 + [0,32,48,48,64][env];
  const dv = new DataView(buf.buffer, buf.byteOffset + hl);
  let o = 0; const le = dv.getUint8(o) === 1; o += 1;
  const type = dv.getUint32(o, le); o += 4;
  const stride = (type > 1000 && type < 2000) ? 24 : 16;
  const rings: { E:number; N:number }[][] = [];
  const rd = () => { const nr = dv.getUint32(o, le); o += 4;
    for (let r = 0; r < nr; r++) { const np = dv.getUint32(o, le); o += 4; const p = [];
      for (let i = 0; i < np; i++) { p.push({ E: dv.getFloat64(o, le), N: dv.getFloat64(o+8, le) }); o += stride; }
      rings.push(p); } };
  const base = type % 1000;
  if (base === 3) rd();
  else if (base === 6) { const n = dv.getUint32(o, le); o += 4; for (let i = 0; i < n; i++) { o += 5; rd(); } }
  else return null;
  return rings.length ? rings : null;
}
const centroid = (rings: any[]) => { const r = rings[0]; let A=0, cx=0, cy=0;
  for (let i = 0; i < r.length-1; i++) { const a=r[i], b=r[i+1]; const f=a.E*b.N-b.E*a.N;
    A += f; cx += (a.E+b.E)*f; cy += (a.N+b.N)*f; }
  A *= 0.5; return A ? { E: cx/(6*A), N: cy/(6*A) } : r[0]; };

const P = new Database("C:/DRO/Data/DROParcels.gpkg", { readonly: true });
const parcelC = new Map<string, {E:number;N:number}>();
for (const r of P.prepare(`SELECT APN_FORMAT apn, geom FROM DROParcels`).all() as any[]) {
  if (!r.geom) continue;
  const g = parsePoly(r.geom);
  if (g) parcelC.set(String(r.apn), centroid(g));
}
P.close();

const M = new Database(MASTER, { readonly: !APPLY });
if (APPLY) registerGpkgFunctions(M);

console.log(`${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
console.log(`--- pin moves ---`);
const plan: any[] = [];
const refused: string[] = [];
for (const [addr, apn] of MOVES) {
  // A position confirmed by a human at the door outranks the county layer, the
  // parcel layer, and any inference drawn from them. Never overwrite one.
  const cur0 = M.prepare(`SELECT "Pin Status" p, "Location Confidence" c FROM "${L}"
                          WHERE "Street Address"=? LIMIT 1`).get(addr) as any;
  if (cur0 && (/confirmed correct/i.test(String(cur0.p ?? "")) ||
               /canvasser confirmed/i.test(String(cur0.c ?? "")))) {
    refused.push(`${addr} -- confirmed at the door; refusing to move it`);
    continue;
  }
  const c = parcelC.get(apn);
  if (!c) { console.log(`  ${addr}: parcel ${apn} not found`); continue; }
  const cur = M.prepare(`SELECT geom FROM "${L}" WHERE "Street Address"=? LIMIT 1`).get(addr) as any;
  const rows = (M.prepare(`SELECT COUNT(*) c FROM "${L}" WHERE "Street Address"=?`).get(addr) as any).c;
  const d = cur?.geom ? Math.hypot(parsePt(cur.geom).E - c.E, parsePt(cur.geom).N - c.N) * 0.3048 : NaN;
  const ll = inv(c.E, c.N);
  console.log(`  ${addr.padEnd(18)} ${String(rows).padStart(2)} row(s)  moves ${isNaN(d)?"?":d.toFixed(0)}m  ->  ${ll.lat.toFixed(6)},${ll.lon.toFixed(6)}  (parcel ${apn})`);
  plan.push({ addr, ...c, lat: ll.lat, lon: ll.lon, rows });
}

if (refused.length) {
  console.log(`\n--- REFUSED (door-verified, left alone) ---`);
  for (const r of refused) console.log(`  ${r}`);
}

console.log(`\n--- ownership notes ---`);
for (const [addr, note] of RENTERS) {
  const rows = (M.prepare(`SELECT COUNT(*) c FROM "${L}" WHERE "Street Address"=?`).get(addr) as any).c;
  const cur = (M.prepare(`SELECT Notes n FROM "${L}" WHERE "Street Address"=? LIMIT 1`).get(addr) as any)?.n ?? "";
  console.log(`  ${addr.padEnd(18)} ${String(rows).padStart(2)} row(s)  ${String(cur).trim() ? "APPEND to existing note" : "new note"}`);
}

if (APPLY) {
  M.exec("BEGIN");
  try {
    for (const p of plan) {
      M.prepare(`UPDATE "${L}" SET geom=:g, "Pin Status"='Wrong - relocated',
                 "Location Confidence"=:c, Easting=:E, Northing=:N,
                 "Geocodio Latitude"=:lat, "Geocodio Longitude"=:lon
                 WHERE "Street Address"=:a`)
        .run({ g: buildPt(p.E, p.N), c: CONF, E: p.E, N: p.N, lat: p.lat, lon: p.lon, a: p.addr });
    }
    for (const [addr, note] of RENTERS) {
      // Append, never overwrite -- a walker's own note must survive.
      const cur = String((M.prepare(`SELECT Notes n FROM "${L}" WHERE "Street Address"=? LIMIT 1`)
        .get(addr) as any)?.n ?? "").trim();
      if (cur.includes("[onX 2026-08-23]")) continue;
      M.prepare(`UPDATE "${L}" SET Notes=:v WHERE "Street Address"=:a`)
        .run({ v: cur ? `${cur}\n${note}` : note, a: addr });
    }
    M.exec("COMMIT");
  } catch (e) { M.exec("ROLLBACK"); throw e; }
  console.log(`\nmoved ${plan.length} household(s), noted ownership on ${RENTERS.length}.`);
}
M.close();
