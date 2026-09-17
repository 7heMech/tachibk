import fs from 'fs';
const ROOT = new URL('../', import.meta.url).pathname;
const src = fs.readFileSync(ROOT+'tools/data.js','utf8') + fs.readFileSync(ROOT+'tools/core.js','utf8')
  + "\nexport {mihonSourceId,kotatsuId,md5,zipRead,zipWrite,jsonDump,jsonParseBig,runConversion,PW,decodeBackup,KOTATSU_PARSERS,gzip,gunzip,crc32,pbFields};";
fs.writeFileSync('/tmp/mod.mjs', src);
const M = await import('/tmp/mod.mjs');

const enc = new TextEncoder();
let fail = 0;
const ok = (c, m) => { console.log((c?'  ok  ':'FAIL  ') + m); if(!c) fail++; };

// md5
const hex = b => [...b].map(x=>x.toString(16).padStart(2,'0')).join('');
ok(hex(M.md5(enc.encode('')))==='d41d8cd98f00b204e9800998ecf8427e', 'md5 empty');
ok(hex(M.md5(enc.encode('abc')))==='900150983cd24fb0d6963f7d28e17f72', 'md5 abc');
ok(hex(M.md5(enc.encode('a'.repeat(1000)))).length===32, 'md5 long');

// source ids
ok(M.mihonSourceId('MangaDex','en',1)===2499283573021220255n, 'MangaDex source id');
ok(M.mihonSourceId('Toonily','en',1)>0n, 'Toonily id positive');

// kotatsu id determinism + range
const kid = M.kotatsuId('MANGADEX','/manga/abc');
ok(typeof kid==='bigint' && kid===M.kotatsuId('MANGADEX','/manga/abc'), 'kotatsu id stable');
ok(kid >= -(2n**63n) && kid < 2n**63n, 'kotatsu id in i64 range');

// parser table
ok(M.KOTATSU_PARSERS.size>1200, 'parser table loaded: '+M.KOTATSU_PARSERS.size);
ok(M.KOTATSU_PARSERS.byName.get('MANGADEX').domains[0]==='mangadex.org', 'mangadex domain');

// json bigint
const big = 8843726351923847623n;
ok(M.jsonDump({a:big}).includes('8843726351923847623'), 'jsonDump keeps bigint');
ok(M.jsonParseBig('[{"manga_id": 8843726351923847623}]')[0].manga_id==='8843726351923847623', 'jsonParseBig quotes long ints');

// zip roundtrip
const files=[{name:'favourites',data:enc.encode('['+'"x",'.repeat(500)+'"y"]')},{name:'index',data:enc.encode('[{}]')}];
const z = await M.zipWrite(files);
const back = await M.zipRead(z);
ok(back.length===2 && back[0].name==='favourites', 'zip roundtrip names');
ok(new TextDecoder().decode(back[0].data)===new TextDecoder().decode(files[0].data), 'zip roundtrip data');
ok(z[0]===0x50&&z[1]===0x4b, 'zip magic');

console.log(fail? `\n${fail} FAILURES` : '\nall core unit tests passed');
