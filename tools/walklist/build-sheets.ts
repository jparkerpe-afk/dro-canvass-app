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
  });
}

const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const y = (a.lat - b.lat) * 111320;
  const x = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(x, y);
};

// ---- blocks -> turfs --------------------------------------------------------

type Block = { street: string; houses: House[]; lat: number; lon: number };
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
      const d = Math.min(...turf.blocks.map((b) => metres(b, blocks[i])));
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
@page { size:letter; margin:10mm; }
@media print { body { padding:0; } .noprint { display:none; } }
`;

const boxes = (labels: string[]) =>
  labels.map((l, i) =>
    `<span class="box${i === 0 ? " first" : ""}"></span>${esc(l)}`).join("");

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

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Turf ${n} — ${ordered[0][0]}</title>
<style>${CSS}</style></head><body>
<header>
  <h1>CHERYL PARKER · DEL REY OAKS</h1>
  <p class="sub">Turf ${n} of ${total} &middot; ${turf.houses.length} households &middot; ${targetCount} people to ask</p>
</header>
<div class="fill">
  <span><b>Volunteer</b></span><span><b>Date</b></span><span><b>Finished</b></span>
</div>
<p class="legend">
  Mark one outcome per <b>address</b>, and yes / maybe / no for each <b>person you actually speak to</b>.
  Leave a person blank if you did not talk to them &mdash; blank is not a no.
  Names in grey are registered at the address but are not on our list; if one answers the door, talk to them anyway and write it in the notes.
  <b>Yard signs, moved-away, wrong address:</b> write it on the notes line.
</p>
${body}
<footer><span>Turf ${n} of ${total}</span><span>Return this sheet to Jed &mdash; it is the only copy.</span></footer>
</body></html>`;
}

// ---- write ------------------------------------------------------------------

Deno.mkdirSync(OUT, { recursive: true });
for (const f of Deno.readDirSync(OUT)) {
  if (f.isFile && f.name.endsWith(".html")) Deno.removeSync(`${OUT}/${f.name}`);
}

const stamp = new Date().toISOString().slice(0, 10);
const rows: string[] = [];
turfs.forEach((turf, i) => {
  const n = i + 1;
  const file = `turf-${String(n).padStart(2, "0")}.html`;
  Deno.writeTextFileSync(`${OUT}/${file}`, renderTurf(turf, n, turfs.length));

  const streets = [...new Set(turf.blocks.map((b) => b.street))].sort();
  let span = 0;
  for (const a of turf.houses) for (const b of turf.houses) span = Math.max(span, metres(a, b));
  const targets = turf.houses.reduce((s, h) => s + h.targets.length, 0);
  rows.push(`<tr><td><a href="${file}">Turf ${n}</a></td><td>${turf.houses.length}</td>` +
    `<td>${targets}</td><td>${Math.round(span)} m</td><td>${streets.map(esc).join(", ")}</td></tr>`);
  console.log(`turf ${String(n).padStart(2)}  ${String(turf.houses.length).padStart(3)} hh  ` +
    `${String(targets).padStart(3)} targets  ${String(Math.round(span)).padStart(4)}m  ${streets.join(", ")}`);
});

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
<p class="legend">One packet per volunteer. Set <b>Walker name</b> in the app to that volunteer's
name before typing their sheets in, so <code>contacted_by</code> records who actually knocked.</p>
<table><tr><th>Turf</th><th>Households</th><th>People</th><th>Span</th><th>Streets</th></tr>
${rows.join("\n")}</table>
</body></html>`);

const totalTargets = houses.reduce((s, h) => s + h.targets.length, 0);
const companions = houses.reduce((s, h) => s + h.companions.length, 0);
console.log(`\n${houses.length} households / ${totalTargets} targets / ${companions} greyed`);
console.log(`${turfs.length} turfs -> ${OUT}`);
