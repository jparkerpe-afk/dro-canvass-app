// Citywide version of the Kreeger check.
//
// Kreeger was one instance of a general defect: at the mouth of a cul-de-sac the
// county address layer often carries a point numbered for the SIDE street while
// the parcel is actually addressed on the THROUGH street. Geocoding then puts the
// side-street household on the corner parcel, and the through-street household
// has nowhere to go. Every such intersection can produce the same error, so this
// walks all 735 parcels and reports the three shapes it makes:
//
//   STACKED   two or more households pinned inside one parcel. One of them is on
//             somebody else's roof.
//   MISMATCH  the household's street does not match the street of the county
//             point on the parcel it sits in -- the Kreeger signature.
//   ORPHAN    a parcel carrying a county point whose "<number> <street>" IS a real
//             roll address, but with no household pinned in it. Somebody belongs
//             there and is elsewhere.
//
// This reports only. Nothing is moved: which household belongs on a contested
// parcel needs the onX owner name, not geometry alone.
//
// A POSITION CONFIRMED BY A HUMAN AT THE DOOR IS NEVER QUESTIONED. It outranks
// the county address layer, the parcel layer and anything inferable from them.
// This matters because the county layer is wrong in exactly the places someone
// bothered to go and check: on Rosita Rd 800-860 the county points are shifted
// one lot south (see fix_rosita_shift.py), and the canvasser-verified households
// therefore sit on a "neighbouring" parcel BY DESIGN. Reading that as an error
// nearly undid a correction that had been right for months.
//
//   deno run --allow-read --allow-ffi --allow-env --allow-net \
//     tools/pin-fixer/audit-parcel-occupancy.ts [street-filter]
import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt, inv } from "./proj.ts";

const L = "dro_voter_master_final_v3";
const FILTER = (Deno.args[0] ?? "").toUpperCase();

const SUF = new Set(["PLACE","PL","ROAD","RD","AVENUE","AVE","DRIVE","DR","COURT","CT","CIRCLE","CIR",
  "STREET","ST","HIGHWAY","HWY","WAY","LANE","LN","TERRACE","TER","BOULEVARD","BLVD"]);
const norm = (s:string)=>s.toUpperCase().replace(/[.,]/g,"").replace(/\s+/g," ").trim();
const strip = (s:string)=>{const p=norm(s).split(" ");
  while(p.length>1&&SUF.has(p[p.length-1]))p.pop(); return p.join(" ");};
const numOf = (a:string)=>{const m=norm(a).replace(/\s+(APT|UNIT|STE|SUITE|#|BLDG)\s*\S+$/,"").match(/^(\d+[A-Z]?)\s/); return m?m[1]:"";};
function edit(a:string,b:string){
  const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);
  for(let j=0;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[a.length][b.length];}
const same=(a:string,b:string)=>a===b||edit(a,b)<=2;   // HILLWIL vs HILWILL

// GeoPackage MultiPolygonZ -- 1000-series WKB types carry a Z, 24 bytes a vertex.
function parsePoly(buf:Uint8Array){
  const flags=buf[3], env=(flags>>1)&7, hl=8+[0,32,48,48,64][env];
  const dv=new DataView(buf.buffer, buf.byteOffset+hl);
  let o=0; const le=dv.getUint8(o)===1; o+=1; const type=dv.getUint32(o,le); o+=4;
  const stride=(type>1000&&type<2000)?24:16; const rings:{E:number;N:number}[][]=[];
  const rd=()=>{const nr=dv.getUint32(o,le);o+=4;
    for(let r=0;r<nr;r++){const np=dv.getUint32(o,le);o+=4;const p=[];
      for(let i=0;i<np;i++){p.push({E:dv.getFloat64(o,le),N:dv.getFloat64(o+8,le)});o+=stride;} rings.push(p);}};
  const b=type%1000;
  if(b===3) rd(); else if(b===6){const n=dv.getUint32(o,le);o+=4;for(let i=0;i<n;i++){o+=5;rd();}} else return null;
  return rings.length?rings:null;}
const centroid=(r0:any[])=>{const r=r0[0];let A=0,cx=0,cy=0;
  for(let i=0;i<r.length-1;i++){const a=r[i],b=r[i+1];const f=a.E*b.N-b.E*a.N;A+=f;cx+=(a.E+b.E)*f;cy+=(a.N+b.N)*f;}
  A*=0.5;return A?{E:cx/(6*A),N:cy/(6*A)}:r[0];};
const inside=(rings:any[],E:number,N:number)=>{let c=false;const r=rings[0];
  for(let i=0,j=r.length-1;i<r.length;j=i++)
    if(((r[i].N>N)!==(r[j].N>N))&&(E<(r[j].E-r[i].E)*(N-r[i].N)/(r[j].N-r[i].N)+r[i].E))c=!c;return c;};

const P=new Database("C:/DRO/Data/DROParcels.gpkg",{readonly:true});
const parcels=(P.prepare(`SELECT APN_FORMAT apn, geom FROM DROParcels`).all() as any[])
  .filter(r=>r.geom).map(r=>{const g=parsePoly(r.geom);
    return g?{apn:String(r.apn), rings:g, c:centroid(g)}:null;}).filter(Boolean) as any[];
P.close();

const ad=new Database("C:/DRO/Data/DROAddresses.gpkg",{readonly:true});
const county=(ad.prepare(`SELECT NUMBER_ n, STREET s, geom FROM DROAddresses`).all() as any[])
  .filter(r=>r.geom).map(r=>({num:String(r.n).trim(), st:strip(String(r.s??"")), ...parsePt(r.geom)}));
ad.close();

const M=new Database("C:/DRO/Data/v3 Voter Data Edit.gpkg",{readonly:true});
const all=(M.prepare(`SELECT "Street Address" a, geom, COUNT(*) v, "Pin Status" p, "Location Confidence" c
                      FROM "${L}" GROUP BY a`).all() as any[])
  .filter(r=>r.geom).map(r=>({addr:String(r.a).trim(), v:r.v, num:numOf(String(r.a)),
    st:strip(String(r.a).replace(/^\d+\s+/,"")),
    verified: /confirmed correct/i.test(String(r.p??"")) || /canvasser confirmed/i.test(String(r.c??"")),
    ...parsePt(r.geom)}));
M.close();
// Verified-at-the-door households still count as OCCUPYING their parcel -- they
// are just never themselves reported as a problem.
const hh=all;
const verified=all.filter(h=>h.verified);
const rollKey=new Set(hh.filter(h=>h.num).map(h=>`${h.num}|${h.st}`));

const stacked:any[]=[], mismatch:any[]=[], orphan:any[]=[];
for(const p of parcels){
  const pts=county.filter(c=>inside(p.rings,c.E,c.N));
  const occ=hh.filter(h=>inside(p.rings,h.E,h.N));
  // A parcel holding a door-verified household is settled. Do not report it as
  // stacked, mismatched or orphaned -- the human already answered the question.
  if(occ.some(o=>o.verified)) continue;
  if(occ.length>1) stacked.push({p,pts,occ});
  if(occ.length===1 && pts.length){
    const h=occ[0];
    if(!pts.some(c=>same(c.st,h.st))) mismatch.push({p,pts,h});
  }
  if(occ.length===0 && pts.length){
    const claim=pts.filter(c=>[...rollKey].some(k=>{const [n,s]=k.split("|"); return n===c.num&&same(s,c.st);}));
    if(claim.length) orphan.push({p,pts:claim});
  }
}
const hit=(s:string)=>!FILTER||s.toUpperCase().includes(FILTER);

console.log(`parcels ${parcels.length}   county points ${county.length}   households ${hh.length}`);
console.log(`${verified.length} household(s) confirmed at the door -- excluded from every finding below.`);
if(FILTER) console.log(`filtered to "${FILTER}"`);

const st1=stacked.filter(x=>x.occ.some((o:any)=>hit(o.addr)));
console.log(`\n=== STACKED: one parcel, two or more households (${st1.length}) ===`);
for(const s of st1){
  const ll=inv(s.p.c.E,s.p.c.N);
  console.log(`  ${s.p.apn}  county: ${s.pts.map((c:any)=>c.num+" "+c.st).join(", ")||"none"}   ${ll.lat.toFixed(6)},${ll.lon.toFixed(6)}`);
  for(const o of s.occ) console.log(`      ${o.addr} (${o.v}v)`);
}

const mm=mismatch.filter(x=>hit(x.h.addr)||x.pts.some((c:any)=>hit(c.st)));
console.log(`\n=== MISMATCH: household's street differs from the parcel's county point (${mm.length}) ===`);
for(const m of mm.sort((a,b)=>a.h.addr.localeCompare(b.h.addr)))
  console.log(`  ${m.h.addr.padEnd(24)} (${m.h.v}v) sits on a parcel the county calls "${m.pts.map((c:any)=>c.num+" "+c.st).join(", ")}"   ${m.p.apn}`);

const orp=orphan.filter(x=>x.pts.some((c:any)=>hit(c.st)));
console.log(`\n=== ORPHAN: parcel holds a real roll address but nobody is pinned in it (${orp.length}) ===`);
for(const o of orp.sort((a,b)=>a.pts[0].st.localeCompare(b.pts[0].st))){
  const ll=inv(o.p.c.E,o.p.c.N);
  console.log(`  ${o.pts.map((c:any)=>c.num+" "+c.st).join(", ").padEnd(22)} empty   ${o.p.apn}  ${ll.lat.toFixed(6)},${ll.lon.toFixed(6)}`);
}
console.log(`\nsummary  STACKED ${st1.length}   MISMATCH ${mm.length}   ORPHAN ${orp.length}`);
