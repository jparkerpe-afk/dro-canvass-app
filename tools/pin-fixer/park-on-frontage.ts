// Parks a household's pin in the street, on the centreline of the road its
// address actually names, instead of on a house we cannot identify.
//
// Why this exists: find-street-mismatches.ts matched a roll address to the
// nearest county address point carrying the same house number on a DIFFERENT
// street -- without ever checking whether that county point was already some
// other household's address. On Quendale Avenue the county layer has only 5
// address points against 13 roll households, so the corner parcels at the
// cul-de-sac mouths matched onto their neighbours. Four households ended up
// pinned 0.7-5.9m from a completely different family's house. onX tax-address
// data confirmed the roll was right about the street all along.
//
// There is no county address point for these parcels, so there is nothing to
// snap to. Parking on the frontage is deliberately imprecise: it puts the
// walker on the right street at roughly the right place and says so, rather
// than pointing confidently at the wrong door. The real fix is a GPS fix taken
// at the door with the app's "I'm standing here" button.
//
//   deno run --allow-read --allow-write --allow-ffi --allow-env --allow-net \
//     tools/pin-fixer/park-on-frontage.ts [--apply]
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt, buildPt, fwd, inv } from "./proj.ts";

const MASTER = "C:/DRO/Data/v3 Voter Data Edit.gpkg";
const L = "dro_voter_master_final_v3";
const APPLY = Deno.args.includes("--apply");
const ROADS = "C:/Users/jpark/AppData/Local/Temp/claude/C--DRO-CanvassApp/" +
  "e91be07b-047f-472e-9f68-9a665761a9df/scratchpad/quendale.json";

const CONF = "Approximate -- parked on the Quendale Ave frontage; the county has " +
  "no address point for this parcel, walker to locate and fix the pin at the door";

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

// ---- road centreline, as state-plane segments ----
const osm = JSON.parse(Deno.readTextFileSync(ROADS));
const segs: [{E:number;N:number},{E:number;N:number}][] = [];
for (const w of osm.elements.filter((e: any) => e.type === "way" && e.geometry))
  for (let i = 0; i < w.geometry.length - 1; i++)
    segs.push([fwd(w.geometry[i].lat, w.geometry[i].lon),
               fwd(w.geometry[i + 1].lat, w.geometry[i + 1].lon)]);
if (!segs.length) { console.error("no road geometry loaded"); Deno.exit(2); }

// Nearest point on the centreline to a given position.
function project(E: number, N: number) {
  let best = { E: 0, N: 0, m: Infinity };
  for (const [a, b] of segs) {
    const dx = b.E - a.E, dy = b.N - a.N;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((E - a.E) * dx + (N - a.N) * dy) / len2)) : 0;
    const px = a.E + t * dx, py = a.N + t * dy;
    const m = Math.hypot(E - px, N - py) * 0.3048;
    if (m < best.m) best = { E: px, N: py, m };
  }
  return best;
}

const M = new Database(MASTER, { readonly: !APPLY });
if (APPLY) registerGpkgFunctions(M);

// Quendale Ave households that the county has NO address point for. The ones it
// does cover (4, 8, 16) are geocoded onto their actual houses and must be left
// alone -- parking those in the street would replace a good pin with a vague one.
const ad = new Database("C:/DRO/Data/DROAddresses.gpkg", { readonly: true });
const countyQuendale = new Set(
  (ad.prepare(`SELECT NUMBER_ n FROM DROAddresses
               WHERE UPPER(TRIM(STREET))='QUENDALE'`).all() as any[])
    .map(r => String(r.n).trim()));
ad.close();
console.log(`county has address points for Quendale numbers: ${[...countyQuendale].sort((a,b)=>+a-+b).join(", ")}`);
console.log(`those are left untouched.\n`);

const targets = (M.prepare(
  `SELECT "Street Address" a, geom, COUNT(*) n, "Pin Status" p, "Location Confidence" c FROM "${L}"
   WHERE UPPER("Street Address") LIKE '% QUENDALE%' GROUP BY a`).all() as any[])
  .filter(r => r.geom)
  .filter(r => !countyQuendale.has(String(r.a).match(/^(\d+)/)?.[1] ?? ""))
  // Never park a household a canvasser has stood in front of.
  .filter(r => {
    const v = /confirmed correct/i.test(String(r.p ?? "")) ||
              /canvasser confirmed/i.test(String(r.c ?? ""));
    if (v) console.log(`  skipping ${String(r.a).trim()} -- confirmed at the door`);
    return !v;
  });

type Plan = { addr:string; rows:number; E:number; N:number; move:number; before:number };
const plan: Plan[] = [];
for (const t of targets) {
  const g = parsePt(t.geom);
  const p = project(g.E, g.N);
  plan.push({ addr: String(t.a).trim(), rows: t.n, E: p.E, N: p.N,
              move: Math.hypot(g.E - p.E, g.N - p.N) * 0.3048, before: p.m });
}
plan.sort((a, b) => b.move - a.move);

console.log(`${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);
console.log(`Quendale Ave households: ${plan.length}   voter rows: ${plan.reduce((t,p)=>t+p.rows,0)}\n`);
console.log(`  address                   rows  was N m off the frontage -> parked on it`);
for (const p of plan)
  console.log(`  ${p.addr.padEnd(26)} ${String(p.rows).padStart(3)}   ${p.before.toFixed(0).padStart(4)}m off  ->  moves ${p.move.toFixed(0)}m`);

if (APPLY) {
  const upd = M.prepare(`UPDATE "${L}" SET geom=:g, "Pin Status"='Wrong - relocated',
                         "Location Confidence"=:c, Easting=:E, Northing=:N,
                         "Geocodio Latitude"=:lat, "Geocodio Longitude"=:lon
                         WHERE "Street Address"=:a`);
  let n = 0;
  M.exec("BEGIN");
  try {
    for (const p of plan) {
      const ll = inv(p.E, p.N);
      n += upd.run({ g: buildPt(p.E, p.N), c: CONF, E: p.E, N: p.N,
                     lat: ll.lat, lon: ll.lon, a: p.addr });
    }
    M.exec("COMMIT");
  } catch (e) { M.exec("ROLLBACK"); throw e; }
  console.log(`\nparked ${n} voter rows across ${plan.length} addresses on the Quendale Ave centreline.`);
}
M.close();
