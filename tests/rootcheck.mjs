import fs from 'fs';
const ROOT = new URL('../', import.meta.url).pathname;
const core=[...fs.readFileSync(ROOT+'public/index.html','utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
fs.writeFileSync('/tmp/rc.mjs', core+'\nexport {runConversion,PW,gzip,gunzip,decodeBackup,APPS};');
const M=await import('/tmp/rc.mjs?v='+Date.now());
let fail=0; const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m); if(!c)fail++;};
const log=()=>{}; const {PW}=M;

// Komikku-style source with every field populated
const r=new PW();
const m=new PW(); m.vint(1,1n).str(2,'/a').str(3,'T'); r.msg(1,m.done());
const c=new PW(); c.str(1,'Cat'); r.msg(2,c.done());
const so=new PW(); so.str(1,'S').vint(2,1n); r.msg(101,so.done());
const p=new PW(); p.str(1,'k'); r.msg(104,p.done());
const sp=new PW(); sp.str(1,'sk'); r.msg(105,sp.done());
const es=new PW(); es.str(1,'u').str(2,'n'); r.msg(106,es.done());
const ss=new PW(); ss.str(1,'search'); r.msg(600,ss.done());
const fd=new PW(); fd.str(1,'feed'); r.msg(610,fd.done());
const bk=await M.gzip(r.done());

const roots = async to => {
  const raw=await M.gunzip(await M.runConversion(bk,'komikku',to,'manga',{},log));
  const seen=new Set(); let o=0;
  while(o<raw.length){let sh=0n,v=0n,b;do{b=raw[o++];v|=BigInt(b&0x7f)<<sh;sh+=7n}while(b&0x80);
    const f=Number(v>>3n),w=Number(v&7n); seen.add(f);
    if(w===0){do{b=raw[o++]}while(b&0x80)}else if(w===2){let s2=0n,l=0n;do{b=raw[o++];l|=BigInt(b&0x7f)<<s2;s2+=7n}while(b&0x80);o+=Number(l)}else if(w===5)o+=4;else if(w===1)o+=8;}
  return [...seen].sort((a,b)=>a-b).join(',');
};
ok(await roots('mihon')==='1,2,101,104,105,106','-> Mihon drops 600/610: '+await roots('mihon'));
ok(await roots('sy')==='1,2,101,104,105,106,600','-> SY keeps 600, drops 610: '+await roots('sy'));
ok(await roots('yokai')==='1,2,101,104,105','-> Yokai drops 106/600/610: '+await roots('yokai'));
ok(await roots('neko')==='1,2','-> Neko keeps only manga+categories: '+await roots('neko'));
ok(await roots('animetail')==='1,2,101,104,105,106','-> Animetail: '+await roots('animetail'));

// extension store shape on the kotatsu->tachi route
const kz=await M.runConversion(bk,'komikku','kotatsu','manga',{useKeiyoushi:false},log).catch(()=>null);
console.log(fail?`\n${fail} FAILURES`:'\nper-target root sets verified');
