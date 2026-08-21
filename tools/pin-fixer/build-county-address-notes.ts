// Emits an annotations file that attaches the county's own address to the ~34
// households whose roll address names a street the county has no record of.
//
// The roll is kept VERBATIM. Nothing here rewrites `address`; each entry sets
// `county_address`, which the app shows as a second line under the address so
// the walker knows what the street sign will say. Regenerating overwrites the
// note rather than stacking a second one, so this is safe to re-run.
//
// Only the near-certain band ships (same house number, different street, within
// NEAR_M of the pin). The 19-49m "likely" band is dominated by the Quail Run /
// Pheasant Ridge condo block, where the two streets are numbered in parallel and
// a match means nothing.
//
//   deno run --allow-read --allow-write --allow-ffi --allow-env --allow-net \
//     tools/pin-fixer/build-county-address-notes.ts
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt } from "./proj.ts";

const NEAR_M = 10;
// Reads the pipeline master, not the July PinFix copy: since the 2026 roll
// refresh the master is the live source, and merge-pins-into-master.ts has
// folded the imagery pin work into it.
const SRC = "C:/DRO/Data/v3 Voter Data Edit.gpkg";
const OUT = "C:/DRO/CanvassApp/data/annotations_county_address_2026-08-21.json";

const SUF = new Set(["PLACE","PL","ROAD","RD","AVENUE","AVE","DRIVE","DR","COURT","CT","CIRCLE","CIR",
  "STREET","ST","HIGHWAY","HWY","WAY","LANE","LN","TERRACE","TER","BOULEVARD","BLVD"]);
// County SUFFIX is spelled out where present, and blank on 567 of 738 points.
const ABBREV: Record<string,string> = { PLACE:"Pl", ROAD:"Rd", AVENUE:"Ave", DRIVE:"Dr", COURT:"Ct",
  CIRCLE:"Cir", STREET:"St", HIGHWAY:"Hwy", WAY:"Way", LANE:"Ln", TERRACE:"Ter", BOULEVARD:"Blvd" };
const CANON: Record<string,string> = { PL:"Pl", RD:"Rd", AVE:"Ave", DR:"Dr", CT:"Ct", CIR:"Cir",
  ST:"St", HWY:"Hwy", WAY:"Way", LN:"Ln", TER:"Ter", BLVD:"Blvd", ...ABBREV };

function norm(s:string){ return s.toUpperCase().replace(/\./g,"").replace(/\s+/g," ").trim(); }
function stripSuffix(s:string){ const p=norm(s).split(" ");
  while(p.length>1 && SUF.has(p[p.length-1])) p.pop(); return p.join(" "); }
function splitAddr(a:string){
  const s=norm(a).replace(/\s+(APT|UNIT|STE|SUITE|#|BLDG)\s*\S+$/,"");
  const m=s.match(/^(\d+[A-Z]?)\s+(.+)$/); if(!m) return null;
  const parts=m[2].split(" "); const tail:string[]=[];
  while(parts.length>1 && SUF.has(parts[parts.length-1])) tail.unshift(parts.pop()!);
  return { num:m[1], street:parts.join(" "), suffix:tail[0]??"" };
}
function edit(a:string,b:string){
  const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);
  for(let j=0;j<=b.length;j++) d[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++)
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[a.length][b.length];
}
const same=(a:string,b:string)=> a===b || edit(a,b)<=2;
const title=(s:string)=> s.toLowerCase().replace(/\b[a-z]/g,c=>c.toUpperCase());

// ---- county points -----------------------------------------------------------
const ad=new Database("C:/DRO/Data/DROAddresses.gpkg",{readonly:true});
const county=(ad.prepare(`SELECT NUMBER_ n, STREET s, SUFFIX su, geom FROM DROAddresses`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePt(r.geom);
    return {num:String(r.n).trim().toUpperCase(), street:stripSuffix(String(r.s??"")),
            suffix:norm(String(r.su??"")), E:g.E, N:g.N};});
ad.close();

// ---- voter households --------------------------------------------------------
const v=new Database(SRC,{readonly:true});
const hh=(v.prepare(`SELECT "Street Address" a, geom, COUNT(*) n
                     FROM dro_voter_master_final_v3 GROUP BY a`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePt(r.geom);
    return {addr:String(r.a), voters:r.n, E:g.E, N:g.N, ...(splitAddr(String(r.a))??{num:"",street:"",suffix:""})};});
v.close();

// The county leaves SUFFIX blank on most streets, so prefer the suffix the roll
// itself uses for that street (majority vote) and fall back to the county's.
const rollSuffix=new Map<string,Map<string,number>>();
for(const h of hh){ if(!h.street||!h.suffix) continue;
  if(!rollSuffix.has(h.street)) rollSuffix.set(h.street,new Map());
  const m=rollSuffix.get(h.street)!; m.set(h.suffix,(m.get(h.suffix)??0)+1); }

// Streets the roll never names (so there is no vote) and the county leaves
// blank. Only needed where the street genuinely has a suffix — "Via Verde" is
// correctly bare in both sources and must stay that way.
const OVERRIDE: Record<string,string> = { CHIQUITO: "Way" };

function suffixFor(street:string, countySuffix:string){
  const votes=rollSuffix.get(street);
  if(votes && votes.size) return CANON[[...votes].sort((a,b)=>b[1]-a[1])[0][0]] ?? "";
  return ABBREV[countySuffix] ?? OVERRIDE[street] ?? "";
}

// ---- match --------------------------------------------------------------------
const entries:any[]=[]; const bare:string[]=[];
for(const h of hh){
  if(!h.num) continue;
  if(county.some(c=>c.num===h.num && same(c.street,h.street))) continue;  // roll and county agree
  const best=county.filter(c=>c.num===h.num && !same(c.street,h.street))
    .map(c=>({...c, m:Math.hypot(c.E-h.E,c.N-h.N)*0.3048}))
    .filter(c=>c.m<=NEAR_M).sort((a,b)=>a.m-b.m)[0];
  if(!best) continue;
  const suf=suffixFor(best.street,best.suffix);
  if(!suf) bare.push(`${best.num} ${title(best.street)}`);
  entries.push({
    address: h.addr,
    county_address: `${best.num} ${title(best.street)}${suf?" "+suf:""}`,
    _voters: h.voters, _metres: Number(best.m.toFixed(1)),
  });
}
entries.sort((a,b)=>a._metres-b._metres);

const out={
  format: "dro-canvass-annotations",
  version: 1,
  description: `County address of record for ${entries.length} households whose roll address `+
    `names a street the county has no record of. The roll address is left unchanged; `+
    `this only adds the county's name for the same house, which is what the street `+
    `sign and mailbox will say. Generated from DROAddresses.gpkg (county address `+
    `points) matched against hand-verified pin positions; every match is the same `+
    `house number on a different street within ${NEAR_M}m of the pin.`,
  generated_at: new Date().toISOString(),
  entries: entries.map(({_voters,_metres,...e})=>e),
};
Deno.writeTextFileSync(OUT, JSON.stringify(out,null,2)+"\n");

console.log(`wrote ${entries.length} entries -> ${OUT}\n`);
for(const e of entries)
  console.log(`  ${String(e._metres).padStart(4)}m  ${e.address.padEnd(26)} ${String(e._voters).padStart(2)}v  ->  ${e.county_address}`);
if(bare.length) console.log(`\nNOTE - rendered with no street suffix: ${[...new Set(bare)].join(", ")}`);
