// Oaks Pin Mover — drag condo pins onto the right building, on aerial imagery.
//
// The two condo complexes geocode almost on top of each other, and some units
// land on the wrong building entirely. The phone app spreads crowded pins into
// a grid so they can at least be tapped apart, but that is a display trick: it
// makes them reachable, not right. This is where they get made right.
//
// Aerial imagery rather than the street map, because the thing you are aiming
// at is a roof, and the street map draws the complex as one undifferentiated
// block.
//
// Everything a drag produces is written as a CANVASSER-GRADE correction:
//   Pin Status          "Wrong - relocated"
//   Location Confidence "Verified (canvasser confirmed)"
// That second one matters beyond this tool. The app refuses to spread a pin
// carrying it, so a unit placed here keeps the spot you chose instead of being
// shuffled back into the grid on the next import.
//
// Run:  deno run --allow-read --allow-write --allow-net --allow-ffi --allow-env \
//         tools/pin-fixer/oaks-map.ts

import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt, buildPt, fwd } from "./proj.ts";

const VOTER_GPKG = "C:/DRO/Data/v3 Voter Data Edit.gpkg";
const LAYER = "dro_voter_master_final_v3";
const PORT = 8788;
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const PIN_STATUS_MOVED = "Wrong - relocated";
const CONFIDENCE_MOVED = "Verified (canvasser confirmed)";

// Geometry UPDATEs fire the GeoPackage R-tree triggers, which call SpatiaLite
// functions plain SQLite has never heard of. Register them or every write dies
// with "no such function: ST_IsEmpty"; drop the triggers instead and the index
// silently rots.
function openVoters(readonly = true) {
  const db = new Database(VOTER_GPKG, { readonly });
  const empty = (b: unknown) => !b || (b as Uint8Array).length === 0;
  db.function("ST_IsEmpty", (b: unknown) => (empty(b) ? 1 : 0));
  db.function("ST_MinX", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).E));
  db.function("ST_MaxX", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).E));
  db.function("ST_MinY", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).N));
  db.function("ST_MaxY", (b: unknown) => (empty(b) ? null : parsePt(b as Uint8Array).N));
  return db;
}

const IS_OAKS = `("Street Address" LIKE '%Quail Run%' OR "Street Address" LIKE '%Pheasant Ridge%')`;

function loadPins() {
  const db = openVoters(true);
  try {
    const rows = db.prepare(`
      SELECT "Street Address" addr,
             "Geocodio Latitude"  lat,
             "Geocodio Longitude" lon,
             "Pin Status"          pin,
             "Location Confidence" conf,
             COUNT(*)              voters,
             GROUP_CONCAT("Voter Name", ' / ') names
        FROM "${LAYER}"
       WHERE ${IS_OAKS}
       GROUP BY 1,2,3,4,5
       ORDER BY 1
    `).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      address: String(r.addr),
      lat: Number(r.lat),
      lon: Number(r.lon),
      // A pin somebody confirmed at the door outranks anything decided from
      // imagery. The tool shows these locked rather than hiding them, so it is
      // obvious why they will not drag.
      locked: String(r.pin ?? "") === "Confirmed correct",
      moved: String(r.pin ?? "") === PIN_STATUS_MOVED,
      confidence: String(r.conf ?? ""),
      voters: Number(r.voters),
      names: String(r.names ?? "").split(" / ").map((s) => s.trim()).filter(Boolean),
    }));
  } finally {
    db.close();
  }
}

function saveMoves(moves: Array<{ address: string; lat: number; lon: number }>) {
  const db = openVoters(false);
  const applied: string[] = [];
  const refused: string[] = [];
  try {
    const locked = new Set(
      (db.prepare(
        `SELECT DISTINCT "Street Address" a FROM "${LAYER}"
          WHERE ${IS_OAKS} AND "Pin Status" = 'Confirmed correct'`,
      ).all() as Array<{ a: string }>).map((r) => r.a),
    );
    const stmt = db.prepare(`
      UPDATE "${LAYER}"
         SET geom = :geom,
             "Easting" = :e,
             "Northing" = :n,
             "Geocodio Latitude"  = :lat,
             "Geocodio Longitude" = :lon,
             "Pin Status"          = :pin,
             "Location Confidence" = :conf,
             "Correction"          = :rev
       WHERE "Street Address" = :addr
    `);
    const stamp = new Date().toISOString().slice(0, 10);
    db.exec("BEGIN");
    for (const m of moves) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) {
        refused.push(`${m.address}: coordinate is not a number`);
        continue;
      }
      // Sanity fence around Del Rey Oaks. A drag that lands outside it is a
      // slip, not a correction.
      if (m.lat < 36.55 || m.lat > 36.63 || m.lon < -121.90 || m.lon > -121.79) {
        refused.push(`${m.address}: ${m.lat.toFixed(5)},${m.lon.toFixed(5)} is outside Del Rey Oaks`);
        continue;
      }
      if (locked.has(m.address)) {
        refused.push(`${m.address}: confirmed at the door, not moving it`);
        continue;
      }
      const { E, N } = fwd(m.lat, m.lon);
      const n = stmt.run({
        geom: buildPt(E, N), e: E, n: N, lat: m.lat, lon: m.lon,
        pin: PIN_STATUS_MOVED, conf: CONFIDENCE_MOVED,
        rev: `pin placed on imagery ${stamp}`,
        addr: m.address,
      });
      if (n > 0) applied.push(m.address);
      else refused.push(`${m.address}: no such address in the master`);
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already closed out */ }
    throw err;
  } finally {
    db.close();
  }
  return { applied, refused };
}

async function serveFile(path: string, contentType: string) {
  try {
    return new Response(await Deno.readFile(path), { headers: { "content-type": contentType } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return await serveFile(`${HERE}/oaks-map.html`, "text/html; charset=utf-8");
  }
  if (url.pathname === "/maplibre-gl.js") {
    return await serveFile("C:/DRO/CanvassApp/js/vendor/maplibre-gl.js", "text/javascript");
  }
  if (url.pathname === "/maplibre-gl.css") {
    return await serveFile("C:/DRO/CanvassApp/css/vendor/maplibre-gl.css", "text/css");
  }
  if (url.pathname === "/pins") {
    return Response.json(loadPins());
  }
  if (url.pathname === "/save" && req.method === "POST") {
    try {
      const body = await req.json();
      const moves = Array.isArray(body?.moves) ? body.moves : [];
      if (!moves.length) return Response.json({ applied: [], refused: [] });
      const r = saveMoves(moves);
      console.log(`saved ${r.applied.length}: ${r.applied.join(", ")}`);
      for (const x of r.refused) console.log(`  refused ${x}`);
      return Response.json(r);
    } catch (err) {
      console.error(err);
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }
  return new Response("not found", { status: 404 });
});

console.log(`Oaks pin mover  ->  http://127.0.0.1:${PORT}`);
console.log(`  Writing to: ${VOTER_GPKG}`);
console.log(`  Drag a pin onto its building, then Save. Export to the phone afterwards.`);
