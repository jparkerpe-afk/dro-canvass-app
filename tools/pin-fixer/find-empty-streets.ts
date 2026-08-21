// Inverse sweep: which streets have county address points but no (or too few) voters?
// The premise is Chiquito Way — 1 county address point, 0 voter households claiming
// "Chiquito", because its only household is filed in the roll as 1067 Paloma Rd.
// Read-only. Re-runnable.
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt } from "./proj.ts";

const NEAR_M = 40;          // a pin this close to a street's address points is "on" that street
const SUF = new Set(["PLACE","PL","ROAD","RD","AVENUE","AVE","DRIVE","DR","COURT","CT","CIRCLE","CIR",
  "STREET","ST","HIGHWAY","HWY","WAY","LANE","LN","TERRACE","TER","BOULEVARD","BLVD"]);

function norm(s:string){ return s.toUpperCase().replace(/\./g,"").replace(/\s+/g," ").trim(); }
function stripSuffix(s:string){
  const parts=norm(s).split(" ");
  while(parts.length>1 && SUF.has(parts[parts.length-1])) parts.pop();
  return parts.join(" ");
}
function streetOf(a:string){
  const s=norm(a).replace(/\s+(APT|UNIT|STE|SUITE|#|BLDG)\s*\S+$/,"");
  const m=s.match(/^(\d+[A-Z]?)\s+(.+)$/); if(!m) return null;
  return { num:m[1], street:stripSuffix(m[2]) };
}
function edit(a:string,b:string){
  const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);
  for(let j=0;j<=b.length;j++) d[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++)
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[a.length][b.length];
}
const sameStreet=(a:string,b:string)=> a===b || edit(a,b)<=2;

// ---- county address points, grouped by street -------------------------------
const ad=new Database("C:/DRO/Data/DROAddresses.gpkg",{readonly:true});
const county=(ad.prepare(`SELECT NUMBER_ n, STREET s, geom FROM DROAddresses`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePt(r.geom);
    return {num:String(r.n).trim().toUpperCase(), street:stripSuffix(String(r.s??"")), E:g.E, N:g.N};});
ad.close();

const cStreets=new Map<string,typeof county>();
for(const c of county){ if(!cStreets.has(c.street)) cStreets.set(c.street,[]); cStreets.get(c.street)!.push(c); }

// ---- voter households, grouped by the street the roll claims ----------------
const v=new Database("C:/DRO/Data/DRO_Voter_PinFix_2026-07-26.gpkg",{readonly:true});
const hh=(v.prepare(`SELECT "Street Address" a, geom, "Location Confidence" c, COUNT(*) n
                     FROM dro_voter_master_final_v3 GROUP BY a`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePt(r.geom);
    return {addr:r.a, conf:r.c, voters:r.n, E:g.E, N:g.N, ...(streetOf(r.a)??{num:"",street:""})};});
v.close();

const vStreets=new Map<string,typeof hh>();
for(const h of hh){ if(!h.street) continue;
  if(!vStreets.has(h.street)) vStreets.set(h.street,[]); vStreets.get(h.street)!.push(h); }

// ---- compare ----------------------------------------------------------------
type Row={street:string; cPts:number; vHH:number; vVoters:number; claimedAs:string; near:any[]};
const rows:Row[]=[];
for(const [street,pts] of cStreets){
  // voter streets that fuzzy-match this county street
  const matched=[...vStreets.entries()].filter(([s])=>sameStreet(s,street));
  const vHH=matched.reduce((t,[,l])=>t+l.length,0);
  const vVoters=matched.reduce((t,[,l])=>t+l.reduce((u,h)=>u+h.voters,0),0);
  // voter pins physically sitting on this street, whatever they call themselves
  const near=hh.map(h=>{
      let best=Infinity, bc:any=null;
      for(const p of pts){ const m=Math.hypot(p.E-h.E,p.N-h.N)*0.3048; if(m<best){best=m; bc=p;} }
      return {h, m:best, c:bc};
    }).filter(x=>x.m<=NEAR_M).sort((a,b)=>a.m-b.m);
  rows.push({street, cPts:pts.length, vHH, vVoters,
             claimedAs:matched.map(([s])=>s).filter(s=>s!==street).join("/"), near});
}

rows.sort((a,b)=>(b.cPts-b.vHH)-(a.cPts-a.vHH) || b.cPts-a.cPts);

console.log(`county streets: ${cStreets.size}   county address points: ${county.length}`);
console.log(`voter street names: ${vStreets.size}   voter households: ${hh.length}\n`);

const orphan=rows.filter(r=>r.vHH===0);
console.log(`=========== STREETS WITH ZERO VOTER HOUSEHOLDS (${orphan.length}) ===========\n`);
for(const r of orphan){
  console.log(`${r.street}  --  ${r.cPts} county address point(s), 0 voters claiming this street`);
  console.log(`   county numbers: ${[...new Set(cStreets.get(r.street)!.map(c=>c.num))].join(", ")}`);
  if(r.near.length){
    console.log(`   voter pins physically within ${NEAR_M}m of those points:`);
    for(const x of r.near.slice(0,8))
      console.log(`      ${x.m.toFixed(0).padStart(3)}m  ${x.h.addr.padEnd(26)} ${String(x.h.voters).padStart(2)}v   (county point there: ${x.c.num} ${x.c.street})`);
  } else console.log(`   no voter pins within ${NEAR_M}m -- genuinely unregistered or vacant`);
  console.log();
}

console.log(`\n=========== UNDER-REPRESENTED STREETS (county points >> voter households) ===========\n`);
console.log(`street                    cPts  vHH  vVoters  deficit`);
for(const r of rows.filter(r=>r.vHH>0 && r.cPts-r.vHH>=3))
  console.log(`${r.street.padEnd(24)}  ${String(r.cPts).padStart(4)} ${String(r.vHH).padStart(4)} ${String(r.vVoters).padStart(8)} ${String(r.cPts-r.vHH).padStart(8)}`);

console.log(`\n\n=========== VOTER STREET NAMES WITH NO COUNTY STREET AT ALL ===========\n`);
for(const [s,l] of [...vStreets].sort((a,b)=>b[1].length-a[1].length)){
  if([...cStreets.keys()].some(c=>sameStreet(c,s))) continue;
  console.log(`${s.padEnd(24)} ${String(l.length).padStart(3)} households -- ${l.slice(0,6).map(h=>h.addr).join("; ")}${l.length>6?" ...":""}`);
}
