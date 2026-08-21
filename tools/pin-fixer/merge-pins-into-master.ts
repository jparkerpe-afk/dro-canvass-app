// Merges the July imagery pin work from DRO_Voter_PinFix_2026-07-26.gpkg into the
// pipeline master (v3 Voter Data Edit.gpkg) after the 2026 county roll refresh.
//
// The two files diverged: the pin-fixer wrote only to its own copy, and the 2026
// re-ingest rewrote the master from fresh Geocodio output. Without this merge,
// export_canvassapp.ps1 ships the new roll with the OLD bad geocodes.
//
// This is NOT a blanket copy. Each disputed address is adjudicated against the
// county address layer, which is independent of both files:
//
//   TAKE PINFIX  - a county point with the SAME house number sits within 10m of
//                  the PinFix pin but not the master's. Near-certain.
//   TAKE PINFIX  - (single-family only) no county point carries that number at
//                  all, so the county cannot adjudicate; the master's position is
//                  "Approximate -- verify in person" Geocodio interpolation,
//                  which is the known-bad method for exactly these addresses,
//                  while PinFix was placed by hand off rooftop numbers.
//   KEEP MASTER  - everything on Quail Run Ct / Pheasant Ridge Rd. The 2026
//                  pipeline already snapped 91 of 105 condo households onto their
//                  correctly-numbered county address point. The hand placements
//                  there were acknowledged as unreliable (units were never
//                  matched to buildings), so merging would make good pins worse.
//   KEEP MASTER  - 2999 Monterey Salinas Hwy, 1.7km from any county point in both
//                  files; outside county address coverage, neither means anything.
//
// One manual override: 900 Rosita Rd does not exist as an address. Its voters are
// placed at the Rosita Rd / Angelus Way intersection (from OSM centerlines) so the
// walker starts somewhere real rather than at a house that isn't theirs.
//
// Run with --apply to write; without it, reports and changes nothing.
//   deno run --allow-read --allow-write --allow-ffi --allow-env --allow-net \
//     tools/pin-fixer/merge-pins-into-master.ts [--apply]
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt, buildPt, fwd, inv } from "./proj.ts";

const MASTER = "C:/DRO/Data/v3 Voter Data Edit.gpkg";
const PINFIX = "C:/DRO/Data/DRO_Voter_PinFix_2026-07-26.gpkg";
const L = "dro_voter_master_final_v3";
const APPLY = Deno.args.includes("--apply");

// Streets whose pins must not be touched -- see header.
const CONDO = /^(QUAIL RUN|PHEASANT RIDGE)$/;
const SKIP_ADDR = new Set(["2999 Monterey Salinas Hwy Unit 6"]);

// 900 Rosita Rd is not a real address; park it in the street instead.
const INTERSECTION = { addr: "900 Rosita Rd", lat: 36.594431, lon: -121.844747,
  conf: "Approximate -- address not found; placed at the Rosita/Angelus " +
        "intersection, walker to locate",
  pin: "Wrong - relocated" };

const SUF = new Set(["PLACE","PL","ROAD","RD","AVENUE","AVE","DRIVE","DR","COURT","CT","CIRCLE","CIR",
  "STREET","ST","HIGHWAY","HWY","WAY","LANE","LN","TERRACE","TER","BOULEVARD","BLVD"]);
const norm = (s:string)=>s.toUpperCase().replace(/\./g,"").replace(/\s+/g," ").trim();
function strip(s:string){ const p=norm(s).split(" ");
  while(p.length>1&&SUF.has(p[p.length-1])) p.pop(); return p.join(" "); }
function numOf(a:string){ const s=norm(a).replace(/\s+(APT|UNIT|STE|SUITE|#|BLDG)\s*\S+$/,"");
  const m=s.match(/^(\d+[A-Z]?)\s/); return m?m[1]:""; }
const S=(x:unknown)=>String(x??"").trim();

// GeoPackage R-tree triggers call SpatiaLite functions plain SQLite lacks; they
// fire on any geometry UPDATE and are needed even to prepare the statement.
// Dropping them would silently rot the spatial index, so register them instead.
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

// ---- county address points, the independent adjudicator ----
const ad = new Database("C:/DRO/Data/DROAddresses.gpkg", { readonly: true });
const county = (ad.prepare(`SELECT NUMBER_ n, STREET s, geom FROM DROAddresses`).all() as any[])
  .filter(r=>r.geom).map(r=>{ const g=parsePt(r.geom);
    return { num:S(r.n), st:strip(S(r.s)), E:g.E, N:g.N }; });
ad.close();
const nearestNumbered = (E:number,N:number,num:string) => county.filter(c=>c.num===num)
  .map(c=>({...c, m:Math.hypot(c.E-E,c.N-N)*0.3048})).sort((a,b)=>a.m-b.m)[0];

// ---- the pin work to consider ----
const P = new Database(PINFIX, { readonly: true });
const work = (P.prepare(`SELECT "Street Address" a, geom, "Location Confidence" c, "Pin Status" p
                         FROM "${L}" WHERE "Pin Status"='Wrong - relocated' GROUP BY a`).all() as any[]);
P.close();

const M = new Database(MASTER, { readonly: !APPLY });
if (APPLY) registerGpkgFunctions(M);

type Plan = { addr:string; E:number; N:number; conf:string; pin:string; why:string; move:number; rows:number };
const plan: Plan[] = []; const held: string[] = [];

for (const w of work) {
  const addr = S(w.a);
  const m = M.prepare(`SELECT geom FROM "${L}" WHERE "Street Address"=? LIMIT 1`).get(addr) as any;
  if (!m?.geom || !w.geom) { held.push(`${addr} -- not in the 2026 roll`); continue; }
  if (SKIP_ADDR.has(addr)) { held.push(`${addr} -- outside county address coverage`); continue; }

  const street = strip(addr.replace(/^\d+\s+/, ""));
  if (CONDO.test(street)) { held.push(`${addr} -- condo, master already county-snapped`); continue; }

  const pg = parsePt(w.geom), mg = parsePt(m.geom);
  const move = Math.hypot(pg.E-mg.E, pg.N-mg.N) * 0.3048;
  if (move < 1) { held.push(`${addr} -- already matches (<1m)`); continue; }

  const num = numOf(addr);
  const bp = nearestNumbered(pg.E, pg.N, num), bm = nearestNumbered(mg.E, mg.N, num);
  const pm = bp ? bp.m : Infinity, mm = bm ? bm.m : Infinity;

  let why = "";
  if (pm <= 10 && mm > 10) why = `county ${bp.num} ${bp.st} @ ${bp.m.toFixed(1)}m`;
  else if (pm > 10 && mm > 10) why = "no county point with that number; imagery beats interpolation";
  else { held.push(`${addr} -- master is closer to ${bm?.num} ${bm?.st}`); continue; }

  const rows = (M.prepare(`SELECT COUNT(*) c FROM "${L}" WHERE "Street Address"=?`).get(addr) as any).c;
  plan.push({ addr, E:pg.E, N:pg.N, conf:S(w.c), pin:S(w.p), why, move, rows });
}

// the manual intersection override replaces whatever was planned for that address
const ix = fwd(INTERSECTION.lat, INTERSECTION.lon);
const ixRows = (M.prepare(`SELECT COUNT(*) c FROM "${L}" WHERE "Street Address"=?`).get(INTERSECTION.addr) as any).c;
if (ixRows > 0) {
  const i = plan.findIndex(p=>p.addr===INTERSECTION.addr);
  const entry: Plan = { addr:INTERSECTION.addr, E:ix.E, N:ix.N, conf:INTERSECTION.conf,
    pin:INTERSECTION.pin, why:"manual: address does not exist, parked at the intersection",
    move:i>=0?plan[i].move:0, rows:ixRows };
  if (i>=0) plan[i]=entry; else plan.push(entry);
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
console.log(`addresses to update: ${plan.length}   voter rows: ${plan.reduce((t,p)=>t+p.rows,0)}`);
console.log(`held back:           ${held.length}\n`);
console.log(`  move  rows  address                     reason`);
for (const p of plan.sort((a,b)=>b.move-a.move))
  console.log(`  ${p.move.toFixed(0).padStart(4)}m ${String(p.rows).padStart(4)}  ${p.addr.padEnd(26)} ${p.why}`);

if (APPLY) {
  const upd = M.prepare(`UPDATE "${L}" SET geom=:g, "Location Confidence"=:c, "Pin Status"=:p,
                         "Geocodio Latitude"=:lat, "Geocodio Longitude"=:lon, Easting=:E, Northing=:N
                         WHERE "Street Address"=:a`);
  let n = 0;
  M.exec("BEGIN");
  try {
    for (const p of plan) {
      const ll = inv(p.E, p.N);
      n += upd.run({ g:buildPt(p.E,p.N), c:p.conf, p:p.pin, lat:ll.lat, lon:ll.lon,
                     E:p.E, N:p.N, a:p.addr });
    }
    M.exec("COMMIT");
  } catch (e) { M.exec("ROLLBACK"); throw e; }
  console.log(`\nwrote ${n} voter rows across ${plan.length} addresses.`);
}
M.close();
