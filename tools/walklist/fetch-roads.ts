// One-time fetch of road centrelines for the walk-list maps.
//
// Cached into the repo rather than queried at build time: the sheets get
// rebuilt after every walk, often minutes before someone leaves the house,
// and a build that depends on a public API is a build that fails on the
// morning it matters. Roads are public OSM data and carry nothing about
// anyone, so unlike every other input here they are safe to commit.
//
//   deno run --allow-read --allow-write --allow-net tools/walklist/fetch-roads.ts

const BACKUP_DIR = "C:/DRO/CanvassApp/dlsfromphone";
const OUT = "C:/DRO/CanvassApp/tools/walklist/roads-dro.json";

const newest = [...Deno.readDirSync(BACKUP_DIR)]
  .filter((f) => f.isFile && /^dro_canvass_.*_backup\.json$/.test(f.name))
  .map((f) => f.name).sort().pop()!;
const b = JSON.parse(Deno.readTextFileSync(`${BACKUP_DIR}/${newest}`));
const lats = b.households.map((h: any) => h.lat), lons = b.households.map((h: any) => h.lon);
const pad = 0.004;
const bbox = [
  Math.min(...lats) - pad, Math.min(...lons) - pad,
  Math.max(...lats) + pad, Math.max(...lons) + pad,
].map((n) => n.toFixed(5)).join(",");
console.log("bbox", bbox);

const q = `[out:json][timeout:90];
way["highway"~"^(residential|unclassified|tertiary|secondary|primary|living_street|service|trunk)$"](${bbox});
out geom;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  body: "data=" + encodeURIComponent(q),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
});
if (!res.ok) { console.error("overpass failed", res.status); Deno.exit(1); }
const data = await res.json();

const ways = (data.elements || [])
  .filter((e: any) => e.type === "way" && Array.isArray(e.geometry))
  .map((e: any) => ({
    name: e.tags?.name || "",
    kind: e.tags?.highway || "",
    pts: e.geometry.map((g: any) => [
      Number(g.lat.toFixed(6)), Number(g.lon.toFixed(6)),
    ]),
  }));
Deno.writeTextFileSync(OUT, JSON.stringify({ bbox, fetched: new Date().toISOString().slice(0, 10), ways }));
const named = new Set(ways.filter((w: any) => w.name).map((w: any) => w.name));
console.log(`${ways.length} ways (${named.size} named) -> ${OUT}`);
console.log([...named].sort().join(", "));
