// Triages onX parcel-owner names against the voter roll.
//
// onX labels a parcel with its OWNER; the roll lists REGISTERED VOTERS. They
// disagree for perfectly ordinary reasons — renters, unregistered spouses, adult
// children, trusts and LLCs, a sale since the roll was pulled. So a mismatch is a
// QUESTION, never a correction. This tool sorts them into buckets and leaves the
// judgement to a human.
//
// Name order differs between the sources: onX writes "Kreeger Gary L"
// (surname first), the roll writes "Gary Lynn Kreeger" (surname last).
//
// Input: a JSON file of { "street name": ["Owner Name", ...] } — one entry per
// parcel, in whatever order they appear on the map.
//
//   deno run --allow-read --allow-ffi --allow-env --allow-net \
//     tools/pin-fixer/match-parcel-owners.ts <owners.json>
import { Database } from "jsr:@db/sqlite@0.12";

const L = "dro_voter_master_final_v3";
const SUF = new Set(["PLACE","PL","ROAD","RD","AVENUE","AVE","DRIVE","DR","COURT","CT","CIRCLE","CIR",
  "STREET","ST","HIGHWAY","HWY","WAY","LANE","LN","TERRACE","TER","BOULEVARD","BLVD"]);
// Entities, not people — no voter will ever match these.
const ENTITY = /\b(LLC|INC|TRUST|TR|ESTATE|CORP|COMPANY|CO|PARTNERS|LP|PROPERTIES|HOMES|CHURCH|CITY|COUNTY)\b/;

const norm = (s:string)=>s.toUpperCase().replace(/[.,]/g,"").replace(/\s+/g," ").trim();
const strip = (s:string)=>{const p=norm(s).split(" ");
  while(p.length>1&&SUF.has(p[p.length-1]))p.pop(); return p.join(" ");};
function edit(a:string,b:string){
  const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);
  for(let j=0;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[a.length][b.length];
}
// Deliberately strict. A two-edit tolerance matched "Kitson" to "Hilson" and
// reported a confident address for a man who is not in the roll at all -- a
// false confirmation is worse than a miss, because it silently removes a
// parcel from the list of things to check. One edit, and only for names long
// enough that one edit is not most of the word.
const close=(a:string,b:string)=> a===b || (a.length>=6 && b.length>=6 && edit(a,b)<=1);

// onX: surname first. Roll: surname last.
const onxParts=(n:string)=>{const p=norm(n).split(" "); return {sur:p[0]??"", given:p.slice(1)};};
const rollParts=(n:string)=>{const p=norm(n).split(" ").filter(x=>!/^(JR|SR|II|III|IV)$/.test(x));
  return {sur:p[p.length-1]??"", given:p.slice(0,-1)};};

const file = Deno.args[0];
if (!file) { console.error("usage: match-parcel-owners.ts <owners.json>"); Deno.exit(2); }
const input: Record<string,string[]> = JSON.parse(Deno.readTextFileSync(file));

const M = new Database("C:/DRO/Data/v3 Voter Data Edit.gpkg", { readonly: true });
const voters = (M.prepare(`SELECT TRIM("Voter Name") n, "Street Address" a FROM "${L}"`).all() as any[])
  .map(r=>({ name:String(r.n), addr:String(r.a).trim(), street:strip(String(r.a).replace(/^\d+\s+/,"")),
             ...rollParts(String(r.n)) }));
M.close();

type Row = { street:string; owner:string; bucket:string; detail:string };
const rows: Row[] = [];

for (const [streetRaw, owners] of Object.entries(input)) {
  const street = strip(streetRaw);
  for (const owner of owners) {
    const { sur, given } = onxParts(owner);
    if (ENTITY.test(norm(owner))) {
      rows.push({ street:streetRaw, owner, bucket:"ENTITY",
        detail:"company or trust — no voter expected; flag as non-residential" });
      continue;
    }
    const bySur = voters.filter(v=>close(v.sur, sur));
    if (!bySur.length) {
      rows.push({ street:streetRaw, owner, bucket:"NO MATCH",
        detail:"surname appears nowhere in the roll — absentee owner, or the occupant is an unregistered renter" });
      continue;
    }
    const sameStreet = bySur.filter(v=>close(v.street, street));
    const givenHit = (v:any)=> !given.length || given.some(g=>g.length>1 && v.given.some((x:string)=>close(x,g)));

    if (sameStreet.length) {
      const exact = sameStreet.filter(givenHit);
      const use = exact.length ? exact : sameStreet;
      const addrs = [...new Set(use.map(v=>v.addr))];
      rows.push({ street:streetRaw, owner,
        bucket: exact.length ? (addrs.length===1 ? "CONFIRMED" : "AMBIGUOUS") : "SURNAME ONLY",
        detail: `${addrs.join(" / ")}  (${use.map(v=>v.name).join("; ")})` });
    } else {
      const addrs=[...new Set(bySur.map(v=>`${v.addr}`))];
      rows.push({ street:streetRaw, owner, bucket:"WRONG STREET?",
        detail:`roll puts this surname on ${addrs.join(" / ")} — not ${streetRaw}` });
    }
  }
}

const ORDER = ["WRONG STREET?","NO MATCH","AMBIGUOUS","SURNAME ONLY","ENTITY","CONFIRMED"];
const NOTE: Record<string,string> = {
  "WRONG STREET?": "CHECK THESE FIRST — owner and roll disagree about the street",
  "NO MATCH":      "no voter with this surname anywhere — expected for absentee owners",
  "AMBIGUOUS":     "matches more than one address on this street",
  "SURNAME ONLY":  "surname matches on this street but the given name does not — could be a relative",
  "ENTITY":        "not a person",
  "CONFIRMED":     "owner and roll agree on street and name",
};
console.log(`parcels read: ${rows.length}   streets: ${Object.keys(input).length}\n`);
for (const b of ORDER) {
  const g = rows.filter(r=>r.bucket===b);
  if (!g.length) continue;
  console.log(`=== ${b} (${g.length}) — ${NOTE[b]} ===`);
  for (const r of g) console.log(`  ${r.street.padEnd(16)} ${r.owner.padEnd(26)} ${r.detail}`);
  console.log();
}
console.log(`summary: ` + ORDER.map(b=>`${b} ${rows.filter(r=>r.bucket===b).length}`).join("   "));
