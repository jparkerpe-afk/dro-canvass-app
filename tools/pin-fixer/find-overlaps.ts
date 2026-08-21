import { Database } from "jsr:@db/sqlite@0.12";
import { parsePt } from "./proj.ts";
const THRESH_M=5;
// Pheasant Ridge / Quail Run use X10,X11,X12-style unit numbering within shared
// buildings — a condo complex, where co-located pins are expected, not an error.
const CONDO=/(PHEASANT RIDGE|QUAIL RUN)/;
const db=new Database("C:/DRO/Data/DRO_Voter_PinFix_2026-07-26.gpkg",{readonly:true});
function base(a:string){return a.trim().toUpperCase().replace(/\./g,"").replace(/\s+(APT|UNIT|STE|SUITE|#|BLDG)\s*\S+$/,"").replace(/\s+/g," ").trim();}
type H={base:string;addr:string;E:number;N:number;conf:string;v:number};
const m=new Map<string,H>();
for(const r of db.prepare(`SELECT geom,"Street Address" a,"Location Confidence" c FROM dro_voter_master_final_v3`).all() as any[]){
  const g=parsePt(r.geom),b=base(r.a); const c=m.get(b);
  if(c)c.v++; else m.set(b,{base:b,addr:r.a,E:g.E,N:g.N,conf:r.c,v:1});
}
db.close();
const hs=[...m.values()];
const parent=hs.map((_,i)=>i); const find=(i:number):number=>parent[i]===i?i:(parent[i]=find(parent[i]));
for(let i=0;i<hs.length;i++)for(let j=i+1;j<hs.length;j++)
  if(Math.hypot(hs[i].E-hs[j].E,hs[i].N-hs[j].N)*0.3048<THRESH_M){const a=find(i),b=find(j); if(a!==b)parent[a]=b;}
const cl=new Map<number,number[]>();
hs.forEach((_,i)=>{const r=find(i); if(!cl.has(r))cl.set(r,[]); cl.get(r)!.push(i);});
const groups=[...cl.values()].filter(g=>g.length>1);

const manual=(c:string)=>c.startsWith("Approximate");
const nonCondo=groups.filter(g=>!g.every(i=>CONDO.test(hs[i].base)));
const condoWithManual=groups.filter(g=>g.every(i=>CONDO.test(hs[i].base)) && g.some(i=>manual(hs[i].conf)));

function show(g:number[]){
  let d=0; for(let x=0;x<g.length;x++)for(let y=x+1;y<g.length;y++)
    d=Math.max(d,Math.hypot(hs[g[x]].E-hs[g[y]].E,hs[g[x]].N-hs[g[y]].N)*0.3048);
  console.log(`\n   spread ${d.toFixed(1)}m`);
  for(const i of g) console.log(`     ${manual(hs[i].conf)?"* ":"  "}${hs[i].addr.padEnd(30)} ${hs[i].v} voter(s)  ${manual(hs[i].conf)?"MANUALLY PLACED":hs[i].conf}`);
}
console.log(`=== NON-CONDO overlaps (${nonCondo.length} clusters) ===`);
for(const g of nonCondo) show(g);
console.log(`\n\n=== Condo-street clusters that include a pin we just placed (${condoWithManual.length}) ===`);
for(const g of condoWithManual) show(g);
console.log(`\n( * = pin placed by hand in this session )`);
