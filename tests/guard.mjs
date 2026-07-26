import fs from 'fs';
const ROOT = new URL('../', import.meta.url).pathname; import { JSDOM } from 'jsdom';
const core=[...fs.readFileSync(ROOT+'public/index.html','utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
fs.writeFileSync('/tmp/guard-mod.mjs', core+'\nexport {runConversion,PW,gzip,gunzip,validateRoute,APPS};');
const M = await import('/tmp/guard-mod.mjs?v='+Date.now());
let fail=0; const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m); if(!c)fail++;};
const log=()=>{};

ok(M.APPS.anikku.kinds.join()==='anime','Anikku registered as anime-only');
ok(!M.validateRoute('anikku','mihon','manga').ok,'anikku->mihon rejected');
ok(M.validateRoute('anikku','mihon','manga').code==='nokind','...for the right reason');
ok(!M.validateRoute('anikku','komikku','anime').ok,'anikku->komikku rejected on anime too');
ok(M.validateRoute('animetail','anikku','anime').ok,'animetail->anikku still valid');
ok(M.validateRoute('animetail','mihon','manga').ok,'animetail->mihon still valid');
ok(M.validateRoute('anikku','aniyomi','anime').ok,'anikku->aniyomi valid');
ok(M.validateRoute('aniyomi','anikku','manga').code==='wrongkind','aniyomi->anikku as manga is wrongkind');

const bytes=new Uint8Array([0x1f,0x8b,0,0]); // guard rejects before parsing
try{ await M.runConversion(bytes,'anikku','mihon','manga',{},log); ok(false,'engine should refuse'); }
catch(e){ ok(/nothing in common/.test(e.message),'engine message: '+e.message); }

// 504/506 now carried
const {PW}=M; const r=new PW();
const a=new PW(); a.vint(1,1n).str(3,'A'); r.msg(501,a.done());
const ex=new PW(); ex.str(1,'ext'); r.msg(504,ex.done());
const cb=new PW(); cb.str(1,'btn'); r.msg(506,cb.done());
r.vint(500,1);
const out=await M.runConversion(await M.gzip(r.done()),'aniyomi','anikku','anime',{},log);
const raw=await M.gunzip(out); const seen=new Set(); let o=0;
while(o<raw.length){let sh=0n,v=0n,b;do{b=raw[o++];v|=BigInt(b&0x7f)<<sh;sh+=7n}while(b&0x80);
  const f=Number(v>>3n),w=Number(v&7n); seen.add(f);
  if(w===0){do{b=raw[o++]}while(b&0x80)}else if(w===2){let s2=0n,l=0n;do{b=raw[o++];l|=BigInt(b&0x7f)<<s2;s2+=7n}while(b&0x80);o+=Number(l)}else if(w===5)o+=4;else if(w===1)o+=8;}
ok(seen.has(3)&&seen.has(106)&&seen.has(109),'504->106 and 506->109 carried: '+[...seen].sort((x,y)=>x-y).join(','));
ok(!seen.has(500),'isLegacy flag dropped');

// UI
const dom=new JSDOM(fs.readFileSync(ROOT+'public/index.html','utf8'),{runScripts:'dangerously',pretendToBeVisual:true,
  beforeParse(w){w.fetch=()=>Promise.reject(new Error('offline'));w.CompressionStream=CompressionStream;w.DecompressionStream=DecompressionStream;
    w.addEventListener('error',e=>{console.log('FAIL  uncaught page error: '+e.message);process.exitCode=1;});}});
const {window}=dom,d=window.document,$=i=>d.getElementById(i);
$('from-app').value='anikku'; $('from-app').dispatchEvent(new window.Event('change'));
$('to-app').value='mihon'; $('to-app').dispatchEvent(new window.Event('change'));
ok($('route-note').classList.contains('bad'),'UI flags the pair as invalid');
ok(/only contain anime/.test($('route-note').textContent),'UI explains why');
ok(/Aniyomi or Animetail/.test($('route-note').textContent),'UI suggests the two-pass workaround');
ok($('mapping-grid').children.length===0,'no mapping rows for invalid route');
ok([...$('from-app').options].find(o=>o.value==='anikku'),'Anikku still selectable (valid for anime routes)');
$('to-app').value='animetail'; $('to-app').dispatchEvent(new window.Event('change'));
ok(!$('route-note').classList.contains('bad'),'anikku->animetail accepted');
ok($('kind-group').classList.contains('hidden'),'kind toggle hidden (only anime shared)');
console.log(fail?`\n${fail} FAILURES`:'\nall guard tests passed');
