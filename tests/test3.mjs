const M = await import('/tmp/mod.mjs');
const TD=new TextDecoder(); let fail=0;
const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m); if(!c)fail++;};
const logs=[];const log=(m,t)=>logs.push(`[${t||'info'}] ${m}`);const dump=()=>{console.log(logs.map(l=>'        '+l).join('\n'));logs.length=0};
const {PW,mihonSourceId}=M;

// pick a parser whose title is NOT in the curated map, to exercise name matching
const cand=[...M.KOTATSU_PARSERS.byTitleKey.entries()].find(([k,v])=>v.title&&v.title.length>5&&!['MANGADEX','TOONILY'].includes(v.name));
console.log('name-match probe:', cand[1].name, '/', cand[1].title);
const nid=mihonSourceId(cand[1].title,'en',1);

function mk(sid,url,title){const m=new PW();m.vint(1,sid).str(2,url).str(3,title).vint(13,1700000000000n).bool(100,true);
  const c=new PW();c.str(1,'/c1').str(2,'Ch 1').bool(4,true).f32(9,1);m.msg(16,c.done());return m.done();}
const root=new PW();
root.msg(1,mk(nid,'/x/y','By Name'));
root.msg(1,mk(mihonSourceId('MangaDex','en',1),'/manga/zz','By Curated'));
for(const [id,n] of [[nid,cand[1].title],[mihonSourceId('MangaDex','en',1),'MangaDex']]){const s=new PW();s.str(1,n).vint(2,id);root.msg(101,s.done());}
const bk=await M.gzip(root.done());

console.log('\n— offline name matching');
const z1=await M.runConversion(bk,'mihon','kotatsu','manga',{useKeiyoushi:false},log);dump();
const f1=M.jsonParseBig(TD.decode((await M.zipRead(z1)).find(e=>e.name==='favourites').data));
ok(f1.some(f=>f.manga.source===cand[1].name),'matched by source name -> '+cand[1].name);

console.log('\n— with Keiyoushi index (network)');
try{
  const z2=await M.runConversion(bk,'mihon','kotatsu','manga',{useKeiyoushi:true},log);dump();
  ok((await M.zipRead(z2)).length>=4,'online run produced a zip');
  const t=await M.runConversion(z2,'kotatsu','mihon','manga',{useKeiyoushi:true},log);dump();
  const d=M.decodeBackup(await M.gunzip(t));
  ok(d.manga.length>=1,'kotatsu->mihon with keiyoushi: '+d.manga.length+' manga');
  ok(d.sources.some(s=>s.name==='MangaDex'),'MangaDex resolved to real Mihon source');
  const md=d.manga.find(m=>m.title==='By Curated');
  ok(md && md.source===2499283573021220255n,'real MangaDex source id assigned: '+(md&&md.source));
}catch(e){ ok(false,'network path threw: '+e.message); }

// malformed input handling
console.log('\n— error handling');
try{ await M.runConversion(new Uint8Array([1,2,3,4,5]),'kotatsu','mihon','manga',{},log); ok(false,'should reject non-zip'); }
catch(e){ logs.length=0; ok(/ZIP/i.test(e.message),'non-zip rejected: '+e.message); }
try{ await M.runConversion(bk,'mihon','anikku','anime',{},log); ok(false,'should reject manga-only backup on anime route'); }
catch(e){ logs.length=0; ok(/anime/i.test(e.message),'anime route rejects manga-only backup'); }

console.log(fail?`\n${fail} FAILURES`:'\nall integration tests passed');
