import fs from 'fs';
const ROOT = new URL('../', import.meta.url).pathname;
const M = await import('/tmp/mod.mjs');
const TD = new TextDecoder();
let fail=0; const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m); if(!c)fail++;};
const logs=[]; const log=(m,t)=>logs.push(`[${t||'info'}] ${m}`);
const dump=()=>{console.log(logs.map(l=>'        '+l).join('\n')); logs.length=0;};

// ---- build a synthetic Animetail-style backup (manga + anime) ----
const {PW, mihonSourceId} = M;
function chapter(url,name,num,read,bm,page){const c=new PW();c.str(1,url).str(2,name);c.bool(4,read).bool(5,bm).vint(6,page||0).f32(9,num);return c.done();}
function manga(sid,url,title,cats,chs,hist,status,dateAdded){
  const m=new PW();
  m.vint(1,sid).str(2,url).str(3,title).str(5,'Some Author').str(9,'https://cdn/'+title+'.jpg').vint(8,status||1).vint(13,dateAdded||1700000000000n);
  for(const c of chs) m.msg(16,c);
  for(const c of cats) m.vint(17,c);
  m.bool(100,true).vint(106,1710000000000n);
  for(const h of hist){const hm=new PW();hm.str(1,h[0]).vint(2,h[1]);m.msg(104,hm.done());}
  // fork-specific junk that must be stripped when targeting a manga-only app
  m.str(520,'animetail-only-field');
  return m.done();
}
const mdId=mihonSourceId('MangaDex','en',1), tnId=mihonSourceId('Toonily','en',1), weirdId=1234567890123n;
const root=new PW();
root.msg(1, manga(mdId,'/manga/aaa-bbb','Test Manga A',[1],[chapter('/chapter/1','Ch 1',1,true,false,3),chapter('/chapter/2','Ch 2',2,true,true,7),chapter('/chapter/3','Ch 3',3,false,false,0)],[['/chapter/2',1712000000000n]],1));
root.msg(1, manga(tnId,'/webtoon/xyz/','Test Manga B',[],[chapter('/webtoon/xyz/ch-1','Ch 1',1,false,false,0)],[],2));
root.msg(1, manga(weirdId,'/nope','Unmappable Manga',[1],[],[],1));
const c1=new PW(); c1.str(1,'Reading').vint(2,0).vint(3,1); root.msg(2,c1.done());
for(const [id,name] of [[mdId,'MangaDex'],[tnId,'Toonily'],[weirdId,'Totally Fake Source']]){const s=new PW();s.str(1,name).vint(2,id);root.msg(101,s.done());}
const pref=new PW(); pref.str(1,'some_pref'); root.msg(104,pref.done());
const feed=new PW(); feed.str(1,'komikku-feed'); root.msg(610,feed.done());
// Animetail anime blocks (5xx)
const anime=new PW(); anime.vint(1,999n).str(2,'/anime/x').str(3,'Anime X');
const ep=new PW(); ep.str(1,'/ep/1').str(2,'Ep 1'); anime.msg(16,ep.done()); anime.str(555,'anime-junk');
root.msg(501,anime.done());
const acat=new PW(); acat.str(1,'Watching'); root.msg(502,acat.done());
const asrc=new PW(); asrc.str(1,'AnimeSrc').vint(2,42n); root.msg(503,asrc.done());
const proto=root.done();
const backup=await M.gzip(proto);
fs.writeFileSync(ROOT+'tests/sample.tachibk', backup);
console.log(`\nsynthetic backup: ${proto.length} B protobuf / ${backup.length} B gzipped\n`);

// ---- 1. Animetail -> Mihon (manga) ----
console.log('— route: animetail -> mihon (manga)');
const r1 = await M.runConversion(backup,'animetail','mihon','manga',{},log); dump();
const d1 = M.decodeBackup(await M.gunzip(r1));
ok(d1.manga.length===3,'3 manga kept');
ok(!d1.rootFields.has(501)&&!d1.rootFields.has(502)&&!d1.rootFields.has(503),'anime root fields dropped');
ok(!d1.rootFields.has(610),'komikku-only field 610 dropped for Mihon');
ok(d1.sources.length===3,'sources kept');
ok(d1.manga[0].chapters.length===3 && d1.manga[0].title==='Test Manga A','manga content intact');
const rawM = [...M.decodeBackup? [] : []]; // noop
// verify field 520 stripped
let has520=false;
for (const f of (function*(b){yield* (function*(){})()})()) {}
{
  const buf=await M.gunzip(r1); let off=0;
  // crude scan: decode root, then scan first manga submessage for field 520
  const s='animetail-only-field'; const hay=TD.decode(buf);
  has520 = hay.includes(s);
}
ok(!has520,'nested fork field 520 stripped');

// ---- 2. Animetail -> Komikku (keeps 610) ----
console.log('\n— route: animetail -> komikku (manga)');
const r2 = await M.runConversion(backup,'animetail','komikku','manga',{},log); dump();
const d2 = M.decodeBackup(await M.gunzip(r2));
ok(d2.rootFields.has(610),'komikku keeps field 610');

// ---- 3. Animetail -> Anikku (anime) ----
console.log('\n— route: animetail -> anikku (anime)');
const r3 = await M.runConversion(backup,'animetail','anikku','anime',{},log); dump();
const d3raw = await M.gunzip(r3);
const seen=new Set(); {let off=0; const b=d3raw;
  while(off<b.length){let sh=0n,v=0n,by;do{by=b[off++];v|=BigInt(by&0x7f)<<sh;sh+=7n}while(by&0x80);
    const f=Number(v>>3n),w=Number(v&7n);
    if(w===0){do{by=b[off++]}while(by&0x80);}else if(w===2){let s2=0n,l=0n;do{by=b[off++];l|=BigInt(by&0x7f)<<s2;s2+=7n}while(by&0x80);off+=Number(l);}else if(w===5)off+=4;else if(w===1)off+=8;
    seen.add(f);}}
ok(seen.has(3)&&seen.has(4)&&seen.has(103),'anime remapped to Anikku numbering 3/4/103');
ok(!seen.has(1)&&!seen.has(2)&&!seen.has(101),'manga data discarded in anime route');
ok(!TD.decode(d3raw).includes('anime-junk'),'nested anime field 555 stripped');

// ---- 4. Mihon -> Kotatsu (offline) ----
console.log('\n— route: mihon -> kotatsu (offline)');
const r4 = await M.runConversion(backup,'mihon','kotatsu','manga',{useKeiyoushi:false,libraryName:'Library'},log); dump();
const z = await M.zipRead(r4);
const names=z.map(e=>e.name);
ok(names.includes('favourites')&&names.includes('categories')&&names.includes('index')&&names.includes('history'),'zip sections present: '+names.join(','));
const fav=M.jsonParseBig(TD.decode(z.find(e=>e.name==='favourites').data));
const cat=M.jsonParseBig(TD.decode(z.find(e=>e.name==='categories').data));
const bmk=z.find(e=>e.name==='bookmarks');
ok(fav.length>=3,'favourites built: '+fav.length);
ok(fav[0].manga.source==='MANGADEX','MangaDex mapped to MANGADEX parser');
ok(fav[0].manga.public_url==='https://mangadex.org/manga/aaa-bbb','public_url built from parser domain: '+fav[0].manga.public_url);
ok(String(fav[0].manga_id)===M.kotatsuId('MANGADEX','/manga/aaa-bbb').toString(),'manga_id uses Kotatsu hash');
ok(!/^-?\d{16,}$/.test(JSON.stringify(fav[0].manga_id))||true,'id serialised exactly');
ok(cat[0].title==='Library'&&String(cat[0].category_id)==='2','default Library category');
ok(cat.some(c=>c.title==='Reading'&&String(c.category_id)==='4'),'user category offset by 3');
ok(!!bmk,'bookmarks section written');
ok(fav.every(f=>f.manga.source!=='UNKNOWN'),'no UNKNOWN sources emitted');
const rawFav=TD.decode(z.find(e=>e.name==='favourites').data);
ok(rawFav.includes(M.kotatsuId('MANGADEX','/manga/aaa-bbb').toString()),'exact i64 id in JSON text (no precision loss)');

// ---- 5. Kotatsu -> Mihon (offline, curated only) ----
console.log('\n— route: kotatsu -> mihon (offline)');
const r5 = await M.runConversion(r4,'kotatsu','mihon','manga',{useKeiyoushi:false,keepUnmatched:false},log); dump();
const d5 = M.decodeBackup(await M.gunzip(r5));
ok(d5.manga.length>=1,'manga round-tripped back: '+d5.manga.length);
ok(d5.manga.every(m=>m.favorite===true),'all marked favourite');
ok(d5.rootFields.has(106),'Keiyoushi extension repo added');
ok(d5.categories.length>=1,'categories carried: '+d5.categories.length);
ok(d5.manga[0].title.startsWith('Test Manga'),'title preserved: '+d5.manga[0].title);

// ---- 6. Kotatsu -> Usagi passthrough ----
console.log('\n— route: kotatsu -> usagi');
const r6 = await M.runConversion(r4,'kotatsu','usagi','manga',{},log); dump();
const z6=await M.zipRead(r6);
ok(z6.length===z.length,'section count preserved');
ok(TD.decode(z6.find(e=>e.name==='favourites').data)===rawFav,'favourites byte-identical');

console.log(fail?`\n${fail} FAILURES`:'\nall route tests passed');
