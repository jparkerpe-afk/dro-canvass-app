const FT = 1200/3937, a = 6378137.0, f = 1/298.257222101;
const e2 = 2*f - f*f, e = Math.sqrt(e2);
const rad=(d:number)=>d*Math.PI/180, deg=(r:number)=>r*180/Math.PI;
// Params read from gpkg_spatial_ref_sys WKT of this very file (CA zone 4 ftUS)
const P={phi1:37.25, phi2:36, phi0:35.3333333333333, lam0:-119, E0:6561666.667, N0:1640416.667};
const mF=(p:number)=>Math.cos(p)/Math.sqrt(1-e2*Math.sin(p)**2);
const tF=(p:number)=>Math.tan(Math.PI/4-p/2)/Math.pow((1-e*Math.sin(p))/(1+e*Math.sin(p)),e/2);
const p1=rad(P.phi1),p2=rad(P.phi2),p0=rad(P.phi0),l0=rad(P.lam0);
const n=(Math.log(mF(p1))-Math.log(mF(p2)))/(Math.log(tF(p1))-Math.log(tF(p2)));
const F=mF(p1)/(n*Math.pow(tF(p1),n));
const rho0=a*F*Math.pow(tF(p0),n);
export function fwd(lat:number,lon:number){
  const rho=a*F*Math.pow(tF(rad(lat)),n), th=n*(rad(lon)-l0);
  return { E:(rho*Math.sin(th))/FT+P.E0, N:(rho0-rho*Math.cos(th))/FT+P.N0 };
}
export function inv(E_ft:number,N_ft:number){
  const E=(E_ft-P.E0)*FT, N=(N_ft-P.N0)*FT;
  const rho=Math.sign(n)*Math.sqrt(E*E+(rho0-N)**2), th=Math.atan2(E,rho0-N);
  const ti=Math.pow(rho/(a*F),1/n);
  let phi=Math.PI/2-2*Math.atan(ti);
  for(let i=0;i<15;i++){const s=Math.sin(phi); phi=Math.PI/2-2*Math.atan(ti*Math.pow((1-e*s)/(1+e*s),e/2));}
  return { lat:deg(phi), lon:deg(th/n+l0) };
}
export function parsePt(buf:Uint8Array){
  const env=(buf[3]>>1)&7, hl=8+[0,32,48,48,64][env];
  const dv=new DataView(buf.buffer,buf.byteOffset+hl); const le=dv.getUint8(0)===1;
  return { E:dv.getFloat64(5,le), N:dv.getFloat64(13,le) };
}
export function buildPt(E:number,N:number,srs=2228){
  const b=new Uint8Array(29); const dv=new DataView(b.buffer);
  b[0]=0x47;b[1]=0x50;b[2]=0x00;b[3]=0x01; dv.setInt32(4,srs,true);
  b[8]=1; dv.setUint32(9,1,true); dv.setFloat64(13,E,true); dv.setFloat64(21,N,true);
  return b;
}
