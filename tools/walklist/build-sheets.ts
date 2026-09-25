// Second-pass walk list: printable turf packets for volunteers.
//
// The first pass was one walker who knew the town. This one is strangers with
// paper, so the sheet has to be a capture form, not a reading list: three
// outcome boxes per household, three support boxes per person, one comment
// line. Jed transcribes the returns into the app afterwards, which is why the
// vocabulary on paper maps onto what the app already stores rather than
// inventing its own.
//
// Input is the walker's backup JSON -- the same file the inbound merge reads.
// The roll CSV cannot be used: it carries no contact outcomes, and outcomes are
// most of what decides who is on this list.
//
//   deno run --allow-read --allow-write tools/walklist/build-sheets.ts \
//     [backup.json] [--out DIR] [--size N]

const BACKUP_DIR = "C:/DRO/CanvassApp/dlsfromphone";
const DEFAULT_OUT = "C:/DRO/CanvassApp/walklists";

// Always the newest backup in the folder, never a date written into the source.
// A hardcoded filename is how a sheet ends up sending someone to a door that
// was knocked last weekend: the file keeps working, so nothing announces that
// it has gone stale. The build prints which file it used, every time.
function newestBackup(): string {
  const files = [...Deno.readDirSync(BACKUP_DIR)]
    .filter((f) => f.isFile && /^dro_canvass_.*_backup\.json$/.test(f.name))
    .map((f) => f.name)
    .sort();
  if (!files.length) {
    console.error(`no backup files in ${BACKUP_DIR}`);
    Deno.exit(2);
  }
  return `${BACKUP_DIR}/${files[files.length - 1]}`;
}

// ---- the filter -------------------------------------------------------------
//
// Agreed with Jed 2026-09-22. A household drops out if ANY of these hold; a
// person drops off an otherwise-listed household if their activity level is
// Inactive. Every rule here is a decision, not a technicality, so each says why.

// Deferred: the two condo complexes are a different problem (106 households,
// unreliable pins, shared entrances) and get their own walk.
const DEFERRED = /QUAIL RUN|PHEASANT RIDGE/;

// Calle Del Oaks sits ~400m from the Oaks condos and ~1km from the nearest
// neighbourhood street. It is not walkable from anything else on this list and
// was removed permanently, not reassigned.
const OFF_LIST_STREET = /^CALLE DEL OAKS$/;

// Someone came to the door and answered -- talked or refused. Also records the
// roll itself got wrong. Re-knocking these is wasted volunteer time.
const ANSWERED = ["talked", "refused", "moved", "wrong_address"];

// A recorded yes, or a sign already in the yard. Both mean the persuasion
// conversation has happened.
const YES = new Set(["strong_yes", "lean_yes"]);

// Keep anyone with a pulse in the voter file. "New / Not Yet Rated" is not a
// positive activity level, but it is not Inactive either -- it means a new
// registration with no history yet, which is the most movable voter there is.
const TARGETABLE = new Set(["Active", "Mild", "New / Not Yet Rated"]);

// Individually ruled off by Jed, for a mix of reasons: not a residence, not
// reachable on foot, already handled by him directly, or a door where sending
// a stranger would do more harm than good. Deliberately not annotated per
// address -- this file is public, and a reason next to an address would
// publish something about whoever lives there.
const REMOVED = new Set([
  "959 VIA VERDE",
  "2999 MONTEREY SALINAS HWY UNIT 6",
  "820 ALTURA PL",
  "7 WALLACE PL",
  "4 SAUCITO AVE",
]);

// ---- turf sizing ------------------------------------------------------------
//
// Jed's own timestamps give 25 doors/hour over 406 timed doors. A first-time
// volunteer reading a sheet, at the observed 33% answer rate, runs closer to
// 15. 28 households is therefore about two hours including walking.
//
// This is the size a turf aims for, not a hard cap: the build divides the real
// total by the number of turfs that implies, so they come out even rather than
// leaving a stub at the end. Override with --size.
const TURF_TARGET = 28;

// A block is a contiguous house-number run on one street. Capping it keeps a
// single long street from swallowing a whole turf, and splitting on a spatial
// jump stops a street that bends away from itself being treated as one run.
//
// The cap is also what lets turfs come out even: a block is indivisible once
// built, so a coarse one cannot be used to fill a small gap. At 14 the rebuild
// swung between 23 and 33 households; at 8 it holds inside 26 to 31 for about
// 20m of extra walking.
const BLOCK_MAX = 8;
const BLOCK_JUMP_M = 180;

const args = Deno.args.filter((a) => !a.startsWith("--"));
const flag = (name: string) => {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : null;
};
const BACKUP = args[0] || newestBackup();
const OUT = flag("--out") || DEFAULT_OUT;
const SIZE = Number(flag("--size")) || TURF_TARGET;
console.log(`reading ${BACKUP.split("/").pop()}`);

const backup = JSON.parse(Deno.readTextFileSync(BACKUP));
if (backup.format !== "dro-canvass-backup") {
  console.error(`not a CanvassApp backup (format="${backup.format}").`);
  Deno.exit(2);
}

type Voter = {
  name: string;
  age: string;
  party: string;
  activity_level: string;
  stale: boolean;
  support_level: string;
  householdId: string;
};
type House = {
  id: string;
  address: string;
  num: number;
  street: string;
  lat: number;
  lon: number;
  notes: string;
  targets: Voter[];
  companions: Voter[];
  node: number; // nearest point on the street network; set once, after filtering
};

const streetOf = (a: string) =>
  String(a).trim().replace(/^[0-9]+[A-Za-z]?\s+/, "").toUpperCase()
    .replace(/\s+(APT|UNIT|STE)\s+.*$/, "");

const byHousehold = new Map<string, Voter[]>();
for (const v of backup.voters as Voter[]) {
  if (!byHousehold.has(v.householdId)) byHousehold.set(v.householdId, []);
  byHousehold.get(v.householdId)!.push(v);
}

const houses: House[] = [];
for (const h of backup.households) {
  const street = streetOf(h.address);
  if (DEFERRED.test(street) || OFF_LIST_STREET.test(street)) continue;
  if (REMOVED.has(h.id)) continue;

  const live = (byHousehold.get(h.id) || []).filter((v) => !v.stale);
  if (!live.length) continue; // address exists, nobody registered behind it
  if (ANSWERED.includes(h.contact_status)) continue;
  if (h.sign) continue;
  if (live.some((v) => YES.has(v.support_level))) continue;

  const targets = live.filter((v) => TARGETABLE.has(v.activity_level));
  if (!targets.length) continue; // everyone here is Inactive

  houses.push({
    id: h.id,
    address: h.address,
    num: parseInt(h.address) || 0,
    street,
    lat: h.lat,
    lon: h.lon,
    notes: (h.notes || "").trim(),
    targets,
    // Inactive housemates still live here and still open the door. Printing
    // them greyed means the volunteer knows who they are talking to; leaving
    // them off means the sheet looks wrong the moment one answers.
    companions: live.filter((v) => !TARGETABLE.has(v.activity_level)),
    node: -1,
  });
}

const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const y = (a.lat - b.lat) * 111320;
  const x = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(x, y);
};

// ---- the street network -----------------------------------------------------
//
// Cached OSM centrelines, loaded once. They do two jobs: the map printed at the
// top of each packet, and -- more importantly -- the distances the turfs are
// grouped by.

// Street names come from two different worlds: the roll abbreviates ("ROSITA
// RD"), OSM spells out ("Rosita Road"). Normalise the suffix to one spelling --
// but KEEP it. Dropping it entirely looks tidier and is wrong here: Del Rey
// Oaks has both a Carlton Drive and a Carlton Place, and a Portola Drive and a
// Portola Avenue, and collapsing them drew a neighbouring street as if it were
// one of this turf's own.
const SUFFIX: Record<string, string> = {
  ROAD: "RD", RD: "RD", DRIVE: "DR", DR: "DR", AVENUE: "AVE", AVE: "AVE",
  PLACE: "PL", PL: "PL", COURT: "CT", CT: "CT", CIRCLE: "CIR", CIR: "CIR",
  STREET: "ST", ST: "ST", LANE: "LN", LN: "LN", HIGHWAY: "HWY", HWY: "HWY",
  BOULEVARD: "BLVD", BLVD: "BLVD", WAY: "WAY", RUN: "RUN", PATH: "PATH",
};
function roadKey(s: string): string {
  const parts = s.toUpperCase().replace(/\./g, "").replace(/\s+/g, " ").trim().split(" ");
  const last = parts[parts.length - 1];
  if (parts.length > 1 && SUFFIX[last]) parts[parts.length - 1] = SUFFIX[last];
  return parts.join(" ");
}

type Road = { name: string; kind: string; pts: [number, number][] };
const ROADS: Road[] = (() => {
  try {
    return JSON.parse(
      Deno.readTextFileSync(new URL("./roads-dro.json", import.meta.url)),
    ).ways;
  } catch {
    console.error("! roads-dro.json missing -- run fetch-roads.ts first");
    return [];
  }
})();

//
// Turfs used to be grouped by straight-line distance, and it was wrong in a way
// that nothing on the sheet revealed. Rosita, Paloma and Via Verde run parallel
// and meet only at their far ends, so doors 500m apart as the crow flies are a
// round trip on foot. One turf measured a tidy 528m across and was a 7.7km
// walk. Grouping runs on network distance instead, which also keeps a turf on
// one street without having to be told to: along a street is near, across the
// back fence is not.

type Graph = { pos: { lat: number; lon: number }[]; adj: [number, number][][] };
const graph: Graph = { pos: [], adj: [] };
const nodeIdx = new Map<string, number>();
function nodeAt(lat: number, lon: number): number {
  const k = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  let i = nodeIdx.get(k);
  if (i === undefined) {
    i = graph.pos.length;
    nodeIdx.set(k, i);
    graph.pos.push({ lat, lon });
    graph.adj.push([]);
  }
  return i;
}
// Which named streets each node belongs to, so a house can be attached to its
// own street rather than to whatever happens to be nearest.
const nodeStreets = new Map<number, Set<string>>();
for (const w of ROADS) {
  if (/^(trunk|motorway)$/.test(w.kind)) continue; // not walkable for canvassing
  const k = w.name ? roadKey(w.name) : "";
  for (let i = 0; i < w.pts.length; i++) {
    const a = nodeAt(w.pts[i][0], w.pts[i][1]);
    if (k) {
      if (!nodeStreets.has(a)) nodeStreets.set(a, new Set());
      nodeStreets.get(a)!.add(k);
    }
    if (i) {
      const b = nodeAt(w.pts[i - 1][0], w.pts[i - 1][1]);
      const d = metres(graph.pos[a], graph.pos[b]);
      graph.adj[a].push([b, d]);
      graph.adj[b].push([a, d]);
    }
  }
}

// Attach a house to ITS OWN street by name, falling back to any named road and
// only then to whatever is closest.
//
// Nearest-node snapping alone is badly wrong here. Half of these houses have an
// unnamed service way -- a driveway or a parking aisle -- passing closer than
// their own street, and those rejoin the network somewhere else entirely. Two
// doors 674m apart on Rosita measured 6km apart because one of them had been
// attached to a driveway, and that produced turfs that looked compact and were
// seven-kilometre walks.
function nearestNode(p: { lat: number; lon: number }, street?: string): number {
  const want = street ? roadKey(street) : "";
  let best = -1, bd = Infinity;
  let namedBest = -1, namedBd = Infinity;
  let anyBest = 0, anyBd = Infinity;
  for (let i = 0; i < graph.pos.length; i++) {
    const d = metres(p, graph.pos[i]);
    if (d < anyBd) { anyBd = d; anyBest = i; }
    const names = nodeStreets.get(i);
    if (!names) continue;
    if (d < namedBd) { namedBd = d; namedBest = i; }
    if (want && names.has(want) && d < bd) { bd = d; best = i; }
  }
  // A match on the right street is worth walking a little further to reach; a
  // house is not 250m from its own street, so that far out it is the roll that
  // is wrong and nearest-named is the better guess.
  if (best >= 0 && bd < 250) return best;
  if (namedBest >= 0) return namedBest;
  return anyBest;
}

// Binary heap Dijkstra. A sorted-array queue is fine for one run and far too
// slow once every block wants its own.
function dijkstra(src: number): Float64Array {
  const dist = new Float64Array(graph.pos.length).fill(Infinity);
  dist[src] = 0;
  const heap: [number, number][] = [[0, src]];
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const down = (i: number) => {
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let s = i;
      if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
      if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
      if (s === i) break;
      [heap[s], heap[i]] = [heap[i], heap[s]];
      i = s;
    }
  };
  while (heap.length) {
    const [d, u] = heap[0];
    heap[0] = heap[heap.length - 1];
    heap.pop();
    if (heap.length) down(0);
    if (d > dist[u]) continue;
    for (const [v, w] of graph.adj[u]) {
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; heap.push([nd, v]); up(heap.length - 1); }
    }
  }
  return dist;
}

// Everything a volunteer reads is in yards or miles. The metres are internal --
// they come from the OSM geometry and there is no reason to convert those --
// but nobody walking Del Rey Oaks thinks in kilometres.
const YD_PER_M = 1.09361;
const YD_PER_MILE = 1760;
function distance(m: number): string {
  const yd = m * YD_PER_M;
  // Half a mile is about where "880 yards" stops being a picture of a walk.
  if (yd < YD_PER_MILE / 2) return `${Math.round(yd / 10) * 10} yards`;
  const mi = yd / YD_PER_MILE;
  return `${mi.toFixed(1)} ${mi < 1.05 && mi >= 0.95 ? "mile" : "miles"}`;
}

const distCache = new Map<number, Float64Array>();
function walkMetres(a: { node: number }, b: { node: number }): number {
  if (!distCache.has(a.node)) distCache.set(a.node, dijkstra(a.node));
  const d = distCache.get(a.node)![b.node];
  // Disconnected (a snapping accident, or a genuinely cut-off stub) must never
  // read as "close" -- that is exactly how the bad turfs got built.
  return isFinite(d) ? d : 1e6;
}

// Door-to-door walking length, taking the nearest unvisited door each time.
// Not the optimal route -- that is the travelling salesman -- but it is how a
// person actually walks a street, and it is an honest number in a way that
// straight-line span is not. Span said 528m for what was a 7.7km afternoon.
function routeMetres(hs: { node: number }[]): number {
  if (hs.length < 2) return 0;
  const left = new Set(hs.keys());
  let cur = 0, total = 0;
  left.delete(0);
  while (left.size) {
    let pick = -1, best = Infinity;
    for (const j of left) {
      const d = walkMetres(hs[cur], hs[j]);
      if (d < best) { best = d; pick = j; }
    }
    total += best;
    cur = pick;
    left.delete(pick);
  }
  return total;
}

// ---- blocks -> turfs --------------------------------------------------------

// Put every door on the street network once, up front: the grouping asks for
// distances between blocks thousands of times.
for (const h of houses) h.node = nearestNode(h, h.street);

type Block = { street: string; houses: House[]; lat: number; lon: number; node: number };
const blocks: Block[] = [];
const byStreet = new Map<string, House[]>();
for (const h of houses) {
  if (!byStreet.has(h.street)) byStreet.set(h.street, []);
  byStreet.get(h.street)!.push(h);
}
for (const [street, arr] of byStreet) {
  arr.sort((a, b) => a.num - b.num);
  let run: House[] = [];
  const flush = () => {
    if (!run.length) return;
    blocks.push({
      street,
      houses: run,
      lat: run.reduce((s, h) => s + h.lat, 0) / run.length,
      lon: run.reduce((s, h) => s + h.lon, 0) / run.length,
      // Anchor on a real door rather than the averaged centre: the mean of a
      // curved street can land off the network entirely.
      node: run[Math.floor(run.length / 2)].node,
    });
    run = [];
  };
  for (const h of arr) {
    if (run.length && (metres(run[run.length - 1], h) > BLOCK_JUMP_M || run.length >= BLOCK_MAX)) flush();
    run.push(h);
  }
  flush();
}

// Greedy: seed each turf at whatever is furthest from the centre of what is
// left, then accrete the nearest block until the turf is full. Seeding at the
// edge rather than the middle stops the last turf being a ring of leftovers
// scattered around the town.
//
// Each turf takes a share of what is still unassigned, recomputed as the build
// goes: ceil(houses left / turfs left). A fixed fill line does not work, because
// a turf that overshoots its share steals from the turfs after it and the last
// one starves -- the first rebuild after a walk produced turfs of 33 and 14,
// and a volunteer handed the stub is finished in forty minutes while another is
// still out. Recomputing after every turf makes the error self-correcting: take
// one house too many here and the quota for everyone after drops to absorb it.
const turfCount = Math.max(1, Math.round(houses.length / SIZE));

type Turf = { blocks: Block[]; houses: House[] };
const unassigned = new Set(blocks.keys());
const turfs: Turf[] = [];
while (unassigned.size) {
  const rest = [...unassigned].map((i) => blocks[i]);
  const left = rest.reduce((s, b) => s + b.houses.length, 0);
  const quota = Math.ceil(left / Math.max(1, turfCount - turfs.length));
  const mid = {
    lat: rest.reduce((s, b) => s + b.lat, 0) / rest.length,
    lon: rest.reduce((s, b) => s + b.lon, 0) / rest.length,
  };
  let seed = 0, far = -1;
  for (const i of unassigned) {
    const d = metres(blocks[i], mid);
    if (d > far) { far = d; seed = i; }
  }
  // Seeding is still by straight line -- it only picks a corner of town to
  // start from, and the walking cost of getting there is nobody's problem.
  const turf: Turf = { blocks: [blocks[seed]], houses: [...blocks[seed].houses] };
  unassigned.delete(seed);
  while (turf.houses.length < quota && unassigned.size) {
    // Prefer the nearest block, but never one that overshoots the quota by more
    // than it undershoots -- taking a whole block to land 4 over is worse than
    // stopping 2 under, and the next turf inherits the difference either way.
    let pick = -1, best = Infinity;
    for (const i of unassigned) {
      const after = turf.houses.length + blocks[i].houses.length;
      if (after > quota && after - quota > quota - turf.houses.length) continue;
      // Score by the FURTHEST block already in the turf, not the nearest.
      // Nearest-block growth chains: every step is short, but the two ends end
      // up across town from each other, and two turfs came out as 7km walks
      // that measured under 500m across. Taking the candidate whose worst case
      // is smallest bounds how far apart a turf's extremes can get.
      const d = Math.max(...turf.blocks.map((b) => walkMetres(b, blocks[i])));
      if (d < best) { best = d; pick = i; }
    }
    if (pick < 0) break;
    turf.blocks.push(blocks[pick]);
    turf.houses.push(...blocks[pick].houses);
    unassigned.delete(pick);
  }
  turfs.push(turf);
}
turfs.sort((a, b) => b.houses.length - a.houses.length);

// ---- rendering --------------------------------------------------------------

const PARTY: Record<string, string> = {
  "Democratic": "Dem",
  "Republican": "Rep",
  "No Party Preference": "NPP",
  "American Independent": "Am Ind",
  "Libertarian": "Lib",
  "Peace and Freedom": "P&F",
  "Green": "Grn",
};
const party = (p: string) => PARTY[p] || p || "—";
const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// App notes are newline-separated, and the walker leaves blank lines behind.
// Collapse to one printed line -- but only on the newlines: notes carry dates
// like "7/20/2026", so a slash is content, not a separator.
const noteLine = (s: string) =>
  s.split("\n").map((l) => l.trim()).filter(Boolean).join(" · ");

const CSS = `
/* Sized for the people actually carrying it: the volunteers skew older, and
   this gets read standing up, at arm's length, on a clipboard, often in full
   sun. Body text is 13.5pt rather than the 11pt a desk document would use,
   and the secondary grey is darkened to hold its contrast on paper -- a light
   grey that looks refined on screen turns into nothing at all in print. */
:root { --ink:#1a1a1a; --rule:#c0c0c0; --grey:#5f5f5f; --brand:#203864; }
* { box-sizing:border-box; }
body { font:13.5pt/1.45 "Helvetica Neue",Arial,sans-serif; color:var(--ink);
       margin:0; padding:12mm 10mm; background:#fff; }
h1 { font-size:18pt; margin:0; color:var(--brand); letter-spacing:.02em; }
.sub { font-size:11.5pt; color:var(--grey); margin:3px 0 0; }
header { border-bottom:2px solid var(--brand); padding-bottom:6px; margin-bottom:9px; }
.fill { display:flex; gap:18px; margin:10px 0 6px; font-size:12.5pt; }
.fill span { flex:1; border-bottom:1px solid var(--ink); padding-bottom:3px; }
.fill b { font-weight:600; }
.legend { font-size:11pt; color:var(--grey); margin:0 0 12px; line-height:1.4;
          border:1px solid var(--rule); padding:7px 9px; border-radius:3px; }
.hh { border-bottom:1px solid var(--rule); padding:9px 0 8px;
      break-inside:avoid; page-break-inside:avoid; }
.hh-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.addr { font-weight:700; font-size:15pt; }
.warn { font-size:11.5pt; color:#8a3a12; font-style:italic; margin:3px 0 0; }
.who { width:100%; border-collapse:collapse; margin-top:6px; }
.who td { padding:3px 0; vertical-align:baseline; }
.who .nm { width:40%; }
.who .ag { width:7%; color:var(--grey); }
.who .pt { width:14%; color:var(--grey); }
.who .bx { width:39%; text-align:right; white-space:nowrap; }
tr.companion td { color:var(--grey); font-size:12pt; font-style:italic; }
.box { display:inline-block; width:14px; height:14px; border:1.5px solid var(--ink);
       margin:0 5px 0 13px; vertical-align:-2px; }
.box.first { margin-left:0; }
/* A pen needs roughly 7mm of clear height, and the line has to read as
   somewhere to write rather than as a divider -- the first cut used a 15px
   dotted rule and it vanished into the layout. */
.note { margin-top:7px; height:30px; border-bottom:1px solid var(--ink);
        display:flex; align-items:flex-end; }
.note::before { content:"notes"; font-size:9.5pt; color:var(--grey);
                letter-spacing:.06em; text-transform:uppercase;
                padding-bottom:3px; }
.street-head { font-size:13pt; font-weight:700; letter-spacing:.06em;
               text-transform:uppercase; color:var(--brand);
               margin:14px 0 3px; padding-top:5px; border-top:1px solid var(--brand); }
footer { margin-top:14px; font-size:10pt; color:var(--grey);
         display:flex; justify-content:space-between; }
/* The turf map. Greys are chosen to survive a cheap office printer: the
   neighbouring roads have to read as context without competing with this
   turf's own streets or with the house dots. */
.map { width:100%; height:auto; display:block; margin:8px 0 2px;
       border:1px solid var(--rule); break-inside:avoid; page-break-inside:avoid; }
.map .rd { fill:none; stroke:#c4c4c4; stroke-width:2.4; stroke-linecap:round;
           stroke-linejoin:round; }
.map .rd.on { stroke:#6d6d6d; stroke-width:4.4; }
.map .ho { fill:var(--brand); stroke:#fff; stroke-width:1.1; }
.map .lb { font-size:11px; fill:#8a8a8a; text-anchor:middle;
           paint-order:stroke; stroke:#fff; stroke-width:3.2; stroke-linejoin:round; }
.map .lb.on { font-size:13px; font-weight:700; fill:#1a1a1a; }
.map .bar { stroke:#1a1a1a; stroke-width:1.4; fill:none; }
.map .sc { font-size:10px; fill:#1a1a1a; text-anchor:middle; }
.map-cap { font-size:9.5pt; color:var(--grey); margin:0 0 10px; }

/* Each turf starts a new sheet, so the combined file can be printed in one
   job and then split into packets along the page breaks. */
.turf { break-before:page; page-break-before:always; }
.turf:first-of-type { break-before:auto; page-break-before:auto; }
@page { size:letter; margin:10mm; }
@media print { body { padding:0; } .noprint { display:none; } }
`;

const boxes = (labels: string[]) =>
  labels.map((l, i) =>
    `<span class="box${i === 0 ? " first" : ""}"></span>${esc(l)}`).join("");

// ---- the turf map -----------------------------------------------------------
//
// Drawn as inline SVG from cached OSM centrelines rather than a tile image: it
// prints black-on-white at any size, needs no network on the morning of a walk,
// and nothing about it can fail silently in a print dialog the way a background
// image does.

const shortName = (s: string) => s.replace(/\s+(Place|Court|Circle)$/, "");

const MAP_W = 640;          // svg user units; CSS scales it to the page width
const MAP_H = 250;
const MAP_PAD_M = 70;       // breathing room beyond the furthest house
const MAP_MIN_M = 260;      // stops a tight cul-de-sac turf zooming absurdly

function turfMap(turf: Turf): string {
  if (!ROADS.length) return "";
  const lats = turf.houses.map((h) => h.lat), lons = turf.houses.map((h) => h.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const mPerLat = 111320, mPerLon = 111320 * Math.cos(midLat * Math.PI / 180);
  // Work in metres from the turf centre, then fit that box to the svg.
  const X = (lon: number) => (lon - midLon) * mPerLon;
  const Y = (lat: number) => -(lat - midLat) * mPerLat;

  let halfW = Math.max(...lons.map((l) => Math.abs(X(l)))) + MAP_PAD_M;
  let halfH = Math.max(...lats.map((l) => Math.abs(Y(l)))) + MAP_PAD_M;
  halfW = Math.max(halfW, MAP_MIN_M / 2);
  halfH = Math.max(halfH, (MAP_MIN_M / 2) * (MAP_H / MAP_W));
  // Match the svg aspect so nothing is squashed.
  if (halfW / halfH < MAP_W / MAP_H) halfW = halfH * (MAP_W / MAP_H);
  else halfH = halfW * (MAP_H / MAP_W);

  const sx = (lon: number) => MAP_W / 2 + (X(lon) / halfW) * (MAP_W / 2);
  const sy = (lat: number) => MAP_H / 2 + (Y(lat) / halfH) * (MAP_H / 2);
  const inView = (lat: number, lon: number) =>
    Math.abs(X(lon)) <= halfW && Math.abs(Y(lat)) <= halfH;

  const mine = new Set(turf.houses.map((h) => roadKey(h.street)));
  const paths: string[] = [];
  const labels: { x: number; y: number; t: string; on: boolean }[] = [];
  const seen = new Set<string>();

  for (const w of ROADS) {
    if (!w.pts.some(([la, lo]) => inView(la, lo))) continue;
    const on = !!w.name && mine.has(roadKey(w.name));
    const d = w.pts.map(([la, lo], i) =>
      `${i ? "L" : "M"}${sx(lo).toFixed(1)} ${sy(la).toFixed(1)}`).join("");
    paths.push(`<path d="${d}" class="${on ? "rd on" : "rd"}"/>`);

    if (w.name && !seen.has(w.name)) {
      const vis = w.pts.filter(([la, lo]) => inView(la, lo));
      if (vis.length) {
        // A label near the edge prints half-cut ("General Jim Mo"), which reads
        // as a mistake rather than as a map that ends. Walk along the street
        // looking for a spot with room, starting from the middle -- one
        // position only was enough to lose "Portola Drive" off a turf whose
        // main street it is.
        const room = 14 + shortName(w.name).length * 3.1;
        const order = [...vis.keys()].sort((a, b) =>
          Math.abs(a - vis.length / 2) - Math.abs(b - vis.length / 2));
        for (const i of order) {
          const x = sx(vis[i][1]), y = sy(vis[i][0]);
          if (x > room && x < MAP_W - room && y > 14 && y < MAP_H - 22) {
            labels.push({ x, y, t: shortName(w.name), on });
            // Claim the name only once a position actually worked. OSM splits
            // one street into many ways, and claiming on the first one seen
            // let a way that merely clips the corner of the view silently
            // block every other piece of the same street from being named.
            seen.add(w.name);
            break;
          }
        }
      }
    }
  }

  // De-clutter. A neighbour's label that lands on something already placed is
  // simply dropped -- overlapping type prints worse than a missing name. But
  // this turf's own streets are the point of the map, and short cul-de-sacs
  // sit close enough together that three of them collided and vanished, so
  // those get nudged up and down until they find room and are placed either
  // way as a last resort.
  const placed: typeof labels = [];
  // Half-width of a centred label, in svg units. Bold "on" labels are set
  // larger, so they need more room than a neighbour's name. Both labels count:
  // measuring only the incoming one let adjacent cul-de-sacs print as
  // "Hillwil Place Voe Place" with the names touching.
  // ~7.2 svg units per character bold, ~5.8 regular, halved for a centred
  // label. Do not fold the /2 into the constants and then divide again, which
  // is how these came out at half width and printed touching.
  const labHalf = (l: { t: string; on: boolean }) => l.t.length * (l.on ? 7.2 : 5.8) / 2;
  // The vertical threshold has to exceed the line height, or two labels count
  // as clear while visibly sitting on top of each other.
  const LINE = 16;
  const clashes = (x: number, y: number, l: { t: string; on: boolean }) =>
    placed.some((p) =>
      Math.abs(p.x - x) < labHalf(p) + labHalf(l) + 5 && Math.abs(p.y - y) < LINE);

  for (const l of labels.sort((a, b) => Number(b.on) - Number(a.on))) {
    if (!clashes(l.x, l.y, l)) { placed.push(l); continue; }
    if (!l.on) continue;
    let put = false;
    for (const dy of [-LINE, LINE, -LINE * 2, LINE * 2, -LINE * 3, LINE * 3]) {
      const y = l.y + dy;
      if (y > 14 && y < MAP_H - 22 && !clashes(l.x, y, l)) {
        placed.push({ ...l, y });
        put = true;
        break;
      }
    }
    if (!put) placed.push(l);
  }

  const dots = turf.houses.map((h) =>
    `<circle cx="${sx(h.lon).toFixed(1)}" cy="${sy(h.lat).toFixed(1)}" r="3.4" class="ho"/>`).join("");

  // Scale bar: a round number of metres that fits comfortably across.
  // Round yards, not round metres -- a bar labelled "229 yards" is no use.
  const wantYd = (halfW * 2 * YD_PER_M) / 4;
  const niceYd = [50, 100, 150, 200, 250, 300, 440, 880].reduce((a, b) =>
    Math.abs(b - wantYd) < Math.abs(a - wantYd) ? b : a);
  const barPx = ((niceYd / YD_PER_M) / (halfW * 2)) * MAP_W;

  return `<svg class="map" viewBox="0 0 ${MAP_W} ${MAP_H}" role="img" aria-label="Map of this turf">
  <rect width="${MAP_W}" height="${MAP_H}" fill="#fff"/>
  ${paths.join("")}
  ${dots}
  ${placed.map((l) =>
    `<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" class="lb${l.on ? " on" : ""}">${esc(l.t)}</text>`).join("")}
  <g transform="translate(14 ${MAP_H - 14})">
    <line x1="0" y1="0" x2="${barPx.toFixed(1)}" y2="0" class="bar"/>
    <line x1="0" y1="-4" x2="0" y2="4" class="bar"/>
    <line x1="${barPx.toFixed(1)}" y1="-4" x2="${barPx.toFixed(1)}" y2="4" class="bar"/>
    <text x="${(barPx / 2).toFixed(1)}" y="-7" class="sc">${niceYd} yards</text>
  </g>
  <g transform="translate(${MAP_W - 20} 22)">
    <path d="M0 8 L0 -8 M0 -8 L-3.5 -3 M0 -8 L3.5 -3" class="bar"/>
    <text x="0" y="20" class="sc">N</text>
  </g>
</svg>`;
}

function renderTurf(turf: Turf, n: number, total: number): string {
  // Streets in the order a walker meets them: biggest block first, then the
  // stubs hanging off it, each in house-number order.
  const groups = new Map<string, House[]>();
  for (const h of turf.houses) {
    if (!groups.has(h.street)) groups.set(h.street, []);
    groups.get(h.street)!.push(h);
  }
  const ordered = [...groups.entries()]
    .map(([s, hs]) => [s, hs.sort((a, b) => a.num - b.num)] as [string, House[]])
    .sort((a, b) => b[1].length - a[1].length);

  const targetCount = turf.houses.reduce((s, h) => s + h.targets.length, 0);
  const body = ordered.map(([street, hs]) => `
  <div class="street-head">${esc(street)}</div>
  ${hs.map((h) => `
  <div class="hh">
    <div class="hh-top">
      <span class="addr">${esc(h.address)}</span>
      <span>${boxes(["talked", "not home", "refused"])}</span>
    </div>
    ${h.notes ? `<p class="warn">${esc(noteLine(h.notes))}</p>` : ""}
    <table class="who">
      ${h.targets.map((v) => `<tr>
        <td class="nm">${esc(v.name.trim())}</td>
        <td class="ag">${esc(v.age)}</td>
        <td class="pt">${esc(party(v.party))}</td>
        <td class="bx">${boxes(["yes", "maybe", "no"])}</td>
      </tr>`).join("")}
      ${h.companions.map((v) => `<tr class="companion">
        <td class="nm">· ${esc(v.name.trim())}</td>
        <td class="ag">${esc(v.age)}</td>
        <td class="pt">${esc(party(v.party))}</td>
        <td class="bx">not a target</td>
      </tr>`).join("")}
    </table>
    <div class="note"></div>
  </div>`).join("")}`).join("");

  return `<section class="turf">
<header>
  <h1>CHERYL PARKER · DEL REY OAKS</h1>
  <p class="sub">Turf ${n} of ${total} &middot; ${turf.houses.length} households &middot; ${targetCount} people to ask &middot; about ${distance(routeMetres(turf.houses))} on foot</p>
</header>
<div class="fill">
  <span><b>Volunteer</b></span><span><b>Date</b></span><span><b>Finished</b></span>
</div>
<p class="legend">
  Mark one outcome per <b>address</b>, and yes / maybe / no for each <b>person you actually speak to</b>.
  Leave a person blank if you did not talk to them &mdash; blank is not a no.
  Names in grey are registered at the address but are not on our list; if one answers the door, talk to them anyway and write it in the notes.
</p>
${turfMap(turf)}
<p class="map-cap">Every dot is a door on this sheet. Streets in bold are yours; the paler ones are just there to get your bearings.</p>
${body}
<footer><span>Turf ${n} of ${total}</span><span>Return this sheet to Jed &mdash; it is the only copy.</span></footer>
</section>`;
}

const page = (title: string, inner: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>${esc(title)}</title>
<style>${CSS}</style></head><body>
${inner}
</body></html>`;

// Every turf in one file, each starting a fresh sheet of paper. Ten separate
// print jobs is friction for no reason -- print once, then split the stack by
// the turf number that is already in every footer.
const combined = (parts: string[]) =>
  page(`All turfs — walk list`, parts.join("\n"));

// ---- write ------------------------------------------------------------------

Deno.mkdirSync(OUT, { recursive: true });
for (const f of Deno.readDirSync(OUT)) {
  if (f.isFile && f.name.endsWith(".html")) Deno.removeSync(`${OUT}/${f.name}`);
}

const stamp = new Date().toISOString().slice(0, 10);
const rows: string[] = [];
const allParts: string[] = [];
turfs.forEach((turf, i) => {
  const n = i + 1;
  const file = `turf-${String(n).padStart(2, "0")}.html`;
  const inner = renderTurf(turf, n, turfs.length);
  allParts.push(inner);
  Deno.writeTextFileSync(`${OUT}/${file}`, page(`Turf ${n}`, inner));

  const streets = [...new Set(turf.blocks.map((b) => b.street))].sort();
  const targets = turf.houses.reduce((s, h) => s + h.targets.length, 0);
  const route = routeMetres(turf.houses);
  rows.push(`<tr><td><a href="${file}">Turf ${n}</a></td><td>${turf.houses.length}</td>` +
    `<td>${targets}</td><td>${distance(route)}</td><td>${streets.map(esc).join(", ")}</td></tr>`);
  console.log(`turf ${String(n).padStart(2)}  ${String(turf.houses.length).padStart(3)} hh  ` +
    `${String(targets).padStart(3)} targets  ${distance(route).padStart(9)} walk  ${streets.join(", ")}`);
});

Deno.writeTextFileSync(`${OUT}/all-turfs.html`, combined(allParts));

Deno.writeTextFileSync(`${OUT}/index.html`, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Walk list ${stamp}</title>
<style>${CSS}
table{width:100%;border-collapse:collapse;font-size:10pt}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--rule)}
th{color:var(--grey);font-size:8.5pt;text-transform:uppercase;letter-spacing:.05em}
a{color:var(--brand)}</style></head><body>
<header><h1>SECOND-PASS WALK LIST</h1>
<p class="sub">Built ${stamp} from ${esc(BACKUP.split("/").pop() || "")} &middot;
${houses.length} households &middot; ${houses.reduce((s, h) => s + h.targets.length, 0)} people to ask &middot;
${turfs.length} turfs</p></header>
<p class="legend"><b><a href="all-turfs.html">Print all turfs in one job</a></b> &mdash; each turf starts a
new sheet, and every page carries its turf number, so the stack splits straight into packets.
One packet per volunteer. Set <b>Walker name</b> in the app to that volunteer's
name before typing their sheets in, so <code>contacted_by</code> records who actually knocked.</p>
<table><tr><th>Turf</th><th>Households</th><th>People</th><th>On foot</th><th>Streets</th></tr>
${rows.join("\n")}</table>
</body></html>`);

const totalTargets = houses.reduce((s, h) => s + h.targets.length, 0);
const companions = houses.reduce((s, h) => s + h.companions.length, 0);
console.log(`\n${houses.length} households / ${totalTargets} targets / ${companions} greyed`);
console.log(`${turfs.length} turfs -> ${OUT}`);
