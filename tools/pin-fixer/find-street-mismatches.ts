import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt, inv } from "./proj.ts";

const SEARCH_M = 150;
const SUF = new Set(["PLACE","PL","ROAD","RD","AVENUE","AVE","DRIVE","DR","COURT","CT","CIRCLE","CIR",
  "STREET","ST","HIGHWAY","HWY","WAY","LANE","LN","TERRACE","TER","BOULEVARD","BLVD"]);

function norm(s:string){ return s.toUpperCase().replace(/\./g,"").replace(/\s+/g," ").trim(); }
function streetOf(a:string){
  const s=norm(a).replace(/\s+(APT|UNIT|STE|SUITE|#|BLDG)\s*\S+$/,"");
  const m=s.match(/^(\d+[A-Z]?)\s+(.+)$/); if(!m) return null;
  const parts=m[2].split(" ");
  while(parts.length>1 && SUF.has(parts[parts.length-1])) parts.pop();
  return { num:m[1], street:parts.join(" ") };
}
// tolerate the roll's spelling variants (HILLWIL vs county HILWILL, GREENOCK vs GREENOCH)
function edit(a:string,b:string){
  const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);
  for(let j=0;j<=b.length;j++) d[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++)
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[a.length][b.length];
}
const sameStreet=(a:string,b:string)=> a===b || edit(a,b)<=2;

const ad=new Database("C:/DRO/Data/DROAddresses.gpkg",{readonly:true});
const county=(ad.prepare(`SELECT NUMBER_ n, STREET s, geom FROM DROAddresses`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePt(r.geom);
    return {num:String(r.n).trim().toUpperCase(), street:norm(String(r.s??"")), E:g.E, N:g.N};});
ad.close();

const v=new Database("C:/DRO/Data/DRO_Voter_PinFix_2026-07-26.gpkg",{readonly:true});
const hh=(v.prepare(`SELECT "Street Address" a, geom, "Location Confidence" c, COUNT(*) n
                     FROM dro_voter_master_final_v3 GROUP BY a`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePt(r.geom);
    return {addr:r.a, conf:r.c, voters:r.n, E:g.E, N:g.N, ...(streetOf(r.a)??{num:"",street:""})};});
v.close();

const found:any[]=[];
for(const h of hh){
  if(!h.num) continue;
  const exact=county.some(c=>c.num===h.num && sameStreet(c.street,h.street));
  if(exact) continue;                                   // roll and county agree
  const cands=county.filter(c=>c.num===h.num && !sameStreet(c.street,h.street))
    .map(c=>({...c, m:Math.hypot(c.E-h.E,c.N-h.N)*0.3048}))
    .filter(c=>c.m<=SEARCH_M).sort((a,b)=>a.m-b.m);
  if(cands.length) found.push({h, best:cands[0], all:cands});
}
found.sort((a,b)=>a.best.m-b.best.m);
console.log(`households with no county record under their own street name,`);
console.log(`but the SAME house number on a different street within ${SEARCH_M}m:  ${found.length}\n`);
for(const f of found){
  console.log(`  ${f.h.addr.padEnd(26)} ${String(f.h.voters).padStart(2)}v  -> "${f.best.num} ${f.best.street}"  ${f.best.m.toFixed(0)}m`);
  console.log(`        currently: ${f.h.conf}`);
  if(f.all.length>1) console.log(`        other candidates: ${f.all.slice(1).map((c:any)=>`${c.num} ${c.street} (${c.m.toFixed(0)}m)`).join(", ")}`);
}

console.log("\n\n================ BANDED ================");
const band=(lo:number,hi:number,label:string)=>{
  const g=found.filter(f=>f.best.m>=lo&&f.best.m<hi);
  console.log(`\n--- ${label}  (${g.length}) ---`);
  for(const f of g) console.log(`  ${f.best.m.toFixed(0).padStart(3)}m  ${f.h.addr.padEnd(24)} ${String(f.h.voters).padStart(2)}v  =>  ${f.best.num} ${f.best.street}`);
};
band(0,10,"NEAR-CERTAIN: same number, different street, within 10m");
band(10,50,"LIKELY");
band(50,1e9,"WEAK - probably coincidence (parallel numbering)");
