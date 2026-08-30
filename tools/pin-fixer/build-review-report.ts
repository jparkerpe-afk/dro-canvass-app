// Writes a standalone HTML page listing every household whose pin is currently
// questionable, with the reason and what would settle it.
//
// Stays on this machine. The page carries addresses and voter counts, so it is
// never published, never committed, and never deployed -- same rule as the CSV.
//
//   deno run --allow-read --allow-write --allow-ffi --allow-env --allow-net \
//     tools/pin-fixer/build-review-report.ts
// Then open tools/pin-fixer/review-report.html
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt, inv } from "./proj.ts";

const L = "dro_voter_master_final_v3";
const OUT = "C:/DRO/CanvassApp/tools/pin-fixer/review-report.html";
const CONDO = /QUAIL RUN|PHEASANT RIDGE/i;
// Outside the county parcel/address coverage entirely -- nothing here can be
// resolved from data, so they are listed once and not repeated in every section.
const OUT_OF_COVERAGE = /CALLE DEL OAKS|MONTEREY SALINAS/i;

function parsePoly(buf: Uint8Array) {
  const flags = buf[3], env = (flags >> 1) & 7, hl = 8 + [0,32,48,48,64][env];
  const dv = new DataView(buf.buffer, buf.byteOffset + hl);
  let o = 0; const le = dv.getUint8(o) === 1; o += 1;
  const type = dv.getUint32(o, le); o += 4;
  const stride = (type > 1000 && type < 2000) ? 24 : 16;
  const rings: {E:number;N:number}[][] = [];
  const rd = () => { const nr = dv.getUint32(o, le); o += 4;
    for (let r = 0; r < nr; r++) { const np = dv.getUint32(o, le); o += 4; const p = [];
      for (let i = 0; i < np; i++) { p.push({ E: dv.getFloat64(o, le), N: dv.getFloat64(o+8, le) }); o += stride; }
      rings.push(p); } };
  const b = type % 1000;
  if (b === 3) rd(); else if (b === 6) { const n = dv.getUint32(o, le); o += 4; for (let i = 0; i < n; i++) { o += 5; rd(); } }
  else return null;
  return rings.length ? rings : null;
}
const inside = (rings: any[], E: number, N: number) => { let c = false; const r = rings[0];
  for (let i = 0, j = r.length-1; i < r.length; j = i++)
    if (((r[i].N > N) !== (r[j].N > N)) && (E < (r[j].E-r[i].E)*(N-r[i].N)/(r[j].N-r[i].N)+r[i].E)) c = !c;
  return c; };

const P = new Database("C:/DRO/Data/DROParcels.gpkg", { readonly: true });
const parcels = (P.prepare(`SELECT APN_FORMAT apn, geom FROM DROParcels`).all() as any[])
  .filter(r => r.geom).map(r => { const g = parsePoly(r.geom); return g ? { apn: String(r.apn), rings: g } : null; })
  .filter(Boolean) as any[];
P.close();

const M = new Database("C:/DRO/Data/v3 Voter Data Edit.gpkg", { readonly: true });
const hh = (M.prepare(`SELECT "Street Address" a, geom, COUNT(*) v,
                       "Location Confidence" c, "Pin Status" p, Notes n
                       FROM "${L}" GROUP BY a`).all() as any[])
  .filter(r => r.geom).map(r => ({
    addr: String(r.a).trim(), v: r.v, conf: String(r.c ?? ""), pin: String(r.p ?? ""),
    note: String(r.n ?? "").trim(), ...parsePt(r.geom),
  }));
M.close();

const verified = (h: any) => h.pin === "Confirmed correct" || /canvasser confirmed/i.test(h.conf);
const ll = (h: any) => { const p = inv(h.E, h.N); return `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`; };

type Item = { addr: string; v: number; why: string; detail: string; pos: string };
const sections: { title: string; blurb: string; items: Item[] }[] = [];

// 1. two households on one point
const byPos = new Map<string, any[]>();
for (const h of hh) { const k = `${h.E.toFixed(2)},${h.N.toFixed(2)}`;
  if (!byPos.has(k)) byPos.set(k, []); byPos.get(k)!.push(h); }
const stacked: Item[] = [];
for (const [, group] of byPos) {
  if (group.length < 2) continue;
  if (group.every(g => CONDO.test(g.addr))) continue;      // condo units genuinely share a point
  if (group.some(g => /APT|UNIT/i.test(g.addr))) continue; // flats in one building
  for (const g of group)
    stacked.push({ addr: g.addr, v: g.v, why: "Two households on one point",
      detail: `shares this exact position with ${group.filter(x => x !== g).map(x => x.addr).join(", ")}`,
      pos: ll(g) });
}
sections.push({ title: "Stacked pins", blurb:
  "Two separate households sitting on the same spot. One of them is on somebody else's roof. " +
  "Re-place both in the pin reviewer.", items: stacked });

// 2. not on any parcel
const offParcel = hh.filter(h => !CONDO.test(h.addr) && !OUT_OF_COVERAGE.test(h.addr)
    && !parcels.some(p => inside(p.rings, h.E, h.N)))
  .map(h => ({ addr: h.addr, v: h.v, why: "Not on any parcel",
    detail: verified(h) ? "confirmed at the door, so left alone" : "pin sits in a road, verge or open ground",
    pos: ll(h) }));
sections.push({ title: "Pins that are not on a lot", blurb:
  "The pin falls outside every county parcel. Condos and the addresses outside county coverage " +
  "are excluded -- they are listed separately.", items: offParcel });

// 3. flagged approximate and never confirmed
const approx = hh.filter(h => /approximate|estimated/i.test(h.conf) && !verified(h)
    && !CONDO.test(h.addr))
  .map(h => ({ addr: h.addr, v: h.v, why: "Never confirmed at a door",
    detail: h.conf, pos: ll(h) }))
  .sort((a, b) => a.addr.localeCompare(b.addr));
sections.push({ title: "Placed by eye, not yet confirmed", blurb:
  "Positions worked out from imagery, parcels or the county layer. They are the best guess available " +
  "but nobody has stood in front of them. The walker still sees a warning badge on these.",
  items: approx });

// 4. condos
const condo = hh.filter(h => CONDO.test(h.addr) && !parcels.some(p => inside(p.rings, h.E, h.N)))
  .map(h => ({ addr: h.addr, v: h.v, why: "Condo unit",
    detail: "sits on the county point for its unit number, in the shared driveway rather than on a building",
    pos: ll(h) }));
sections.push({ title: "Condo complexes", blurb:
  "Quail Run and Pheasant Ridge. The unit footprints are ~100 sq m and packed tight, so for almost all " +
  "of these the second-nearest building is within 3m of the nearest -- snapping them to a building would " +
  "be a coin flip on which unit. They are left on the county's own point for their unit number. " +
  "Only feet can improve these.", items: condo });

// 5. outside county coverage
const outside = hh.filter(h => OUT_OF_COVERAGE.test(h.addr))
  .map(h => ({ addr: h.addr, v: h.v, why: "Outside county coverage",
    detail: "no parcel or address point within reach; nothing in the data can place it", pos: ll(h) }));
sections.push({ title: "Outside the county layers", blurb:
  "Calle Del Oaks and Monterey Salinas Hwy. Neither the parcel layer nor the address layer reaches these.",
  items: outside });

const total = sections.reduce((t, s) => t + s.items.length, 0);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]!));

const html = `<!doctype html>
<meta charset="utf-8">
<title>DRO pins — questionable</title>
<style>
  :root { --navy:#203864; --rust:#8B371A; --cream:#F7ECE8; --rule:#e3d8d3; --text:#333; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.55 'Open Sans',Arial,sans-serif; color:var(--text); background:#fff; }
  header { background:var(--navy); color:#fff; padding:1.1rem 1.4rem; }
  h1 { margin:0; font:700 1.35rem 'Montserrat',Arial,sans-serif; letter-spacing:.02em; }
  header p { margin:.35rem 0 0; opacity:.85; font-size:.9rem; }
  main { padding:1.2rem 1.4rem 3rem; max-width:1100px; }
  section { margin:0 0 2.2rem; }
  h2 { font:700 1.05rem 'Montserrat',Arial,sans-serif; color:var(--navy);
       margin:0 0 .3rem; padding-bottom:.3rem; border-bottom:2px solid var(--rule); }
  .count { color:var(--rust); font-weight:700; }
  .blurb { margin:.5rem 0 .9rem; font-size:.92rem; color:#555; max-width:78ch; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; }
  th { text-align:left; background:var(--cream); padding:.45rem .6rem; font-weight:600;
       border-bottom:1px solid var(--rule); white-space:nowrap; }
  td { padding:.45rem .6rem; border-bottom:1px solid #f0eae7; vertical-align:top; }
  tr:hover td { background:#fcf8f7; }
  .addr { font-weight:600; white-space:nowrap; }
  .pos { font-family:ui-monospace,Consolas,monospace; font-size:.82rem; color:#666; white-space:nowrap; }
  .none { color:#2e7d32; font-style:italic; padding:.4rem 0; }
  footer { padding:1rem 1.4rem; border-top:1px solid var(--rule); color:#777; font-size:.85rem; }
</style>
<header>
  <h1>Questionable pins</h1>
  <p>${total} household${total===1?"":"s"} worth a second look &middot; generated ${new Date().toLocaleString()}</p>
</header>
<main>
${sections.map(s => `  <section>
    <h2>${esc(s.title)} <span class="count">${s.items.length}</span></h2>
    <p class="blurb">${esc(s.blurb)}</p>
    ${s.items.length === 0 ? '<p class="none">Nothing outstanding here.</p>' : `<table>
      <tr><th>Address</th><th>Voters</th><th>Why</th><th>Detail</th><th>Position</th></tr>
      ${s.items.map(i => `<tr>
        <td class="addr">${esc(i.addr)}</td>
        <td>${i.v}</td>
        <td>${esc(i.why)}</td>
        <td>${esc(i.detail)}</td>
        <td class="pos">${i.pos}</td>
      </tr>`).join("\n      ")}
    </table>`}
  </section>`).join("\n")}
</main>
<footer>
  Local file. Contains addresses and voter counts, so it is never committed, published or deployed.<br>
  Re-run <code>tools/pin-fixer/build-review-report.ts</code> to refresh, and use
  <code>server.ts --review</code> to fix anything listed.
</footer>
`;
Deno.writeTextFileSync(OUT, html);
console.log(`wrote ${OUT}`);
for (const s of sections) console.log(`   ${String(s.items.length).padStart(4)}  ${s.title}`);
console.log(`   ${String(total).padStart(4)}  total`);
