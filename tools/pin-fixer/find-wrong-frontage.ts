// Number-agnostic wrong-street check. Companion to find-street-mismatches.ts.
//
// find-street-mismatches.ts needs the SAME house number to exist on another street.
// This one ignores the number: it flags any household whose pin sits on top of some
// other street's address points while being nowhere near a single point on the street
// the roll names. That catches records where the house number is wrong too.
// Read-only. Re-runnable.
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt } from "./proj.ts";

const ON_M = 15;    // this close to a county point = standing on that street's frontage
const OFF_M = 40;   // this far from every point on your own street = not on it

const SUF = new Set(["PLACE","PL","ROAD","RD","AVENUE","AVE","DRIVE","DR","COURT","CT","CIRCLE","CIR",
  "STREET","ST","HIGHWAY","HWY","WAY","LANE","LN","TERRACE","TER","BOULEVARD","BLVD"]);
function norm(s:string){ return s.toUpperCase().replace(/\./g,"").replace(/\s+/g," ").trim(); }
function stripSuffix(s:string){ const p=norm(s).split(" ");
  while(p.length>1 && SUF.has(p[p.length-1])) p.pop(); return p.join(" "); }
function streetOf(a:string){
  const s=norm(a).replace(/\s+(APT|UNIT|STE|SUITE|#|BLDG)\s*\S+$/,"");
  const m=s.match(/^(\d+[A-Z]?)\s+(.+)$/); if(!m) return null;
  return { num:m[1], street:stripSuffix(m[2]) };
}
// tolerate the roll's spelling variants (HILLWIL vs county HILWILL, GREENOCK vs GREENOCH)
function edit(a:string,b:string){
  const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);
  for(let j=0;j<=b.length;j++) d[0][j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++)
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[a.length][b.length];
}
const same=(a:string,b:string)=> a===b || edit(a,b)<=2;

const ad=new Database("C:/DRO/Data/DROAddresses.gpkg",{readonly:true});
const county=(ad.prepare(`SELECT NUMBER_ n, STREET s, USE_TYPE u, geom FROM DROAddresses`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePt(r.geom);
    return {num:String(r.n).trim().toUpperCase(), street:stripSuffix(String(r.s??"")),
            use:r.u??"", E:g.E, N:g.N};});
ad.close();

const v=new Database("C:/DRO/Data/DRO_Voter_PinFix_2026-07-26.gpkg",{readonly:true});
const hh=(v.prepare(`SELECT "Street Address" a, geom, "Location Confidence" c, "Pin Status" p, COUNT(*) n
                     FROM dro_voter_master_final_v3 GROUP BY a`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePt(r.geom);
    return {addr:r.a, conf:r.c, pin:r.p, voters:r.n, E:g.E, N:g.N, ...(streetOf(r.a)??{num:"",street:""})};});
v.close();

const out:any[]=[];
for(const h of hh){
  if(!h.street) continue;
  let near:any=null, nearM=Infinity, ownM=Infinity;
  for(const c of county){
    const m=Math.hypot(c.E-h.E,c.N-h.N)*0.3048;
    if(m<nearM){nearM=m; near=c;}
    if(same(c.street,h.street) && m<ownM) ownM=m;
  }
  if(!near || same(near.street,h.street)) continue;
  if(nearM<=ON_M && ownM>=OFF_M) out.push({h, near, nearM, ownM, numMatch:near.num===h.num});
}
out.sort((a,b)=>a.nearM-b.nearM);

console.log(`pins on another street's frontage (<=${ON_M}m to it, >=${OFF_M}m to any point on their own street): ${out.length}\n`);
console.log(`  dist  own-st  household                     v   county point at that spot   num?`);
for(const o of out)
  console.log(`  ${o.nearM.toFixed(0).padStart(3)}m ${o.ownM.toFixed(0).padStart(5)}m  ${o.h.addr.padEnd(28)} ${String(o.h.voters).padStart(2)}  ${(o.near.num+" "+o.near.street).padEnd(26)} ${o.numMatch?"SAME":"----"}`);

const novel=out.filter(x=>!x.numMatch);
console.log(`\n---- the ones find-street-mismatches.ts CANNOT see (house number differs too): ${novel.length} ----\n`);
for(const o of novel)
  console.log(`  ${o.nearM.toFixed(0).padStart(3)}m  ${o.h.addr.padEnd(26)} ${String(o.h.voters).padStart(2)}v  ->  county has "${o.near.num} ${o.near.street}" (${o.near.use}) there;\n        nearest real ${o.h.street} point is ${o.ownM.toFixed(0)}m away.  pin: ${o.h.pin??"(county geocode)"}`);
