import fs from 'fs';
const ROOT = new URL('../', import.meta.url).pathname;
import { JSDOM } from 'jsdom';
const dom = new JSDOM(fs.readFileSync(ROOT+'public/index.html','utf8'), { runScripts:'dangerously', pretendToBeVisual:true,
  beforeParse(w){ w.fetch=()=>Promise.reject(new Error('offline test')); w.CompressionStream=CompressionStream; w.DecompressionStream=DecompressionStream;
    w.URL.createObjectURL=()=>'blob:x'; w.URL.revokeObjectURL=()=>{}; }});
const { window } = dom, d = window.document, $ = id => d.getElementById(id);
let fail=0; const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m); if(!c)fail++;};

if (!fs.existsSync(ROOT+'tests/sample.tachibk')) {
  const core=[...fs.readFileSync(ROOT+'public/index.html','utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  fs.writeFileSync('/tmp/fx.mjs', core+'\nexport {PW,gzip};');
  const {PW,gzip}=await import('/tmp/fx.mjs?v='+Date.now());
  const r=new PW(); const m=new PW();
  m.vint(1,2499283573021220255n).str(2,'/manga/a').str(3,'Test Manga A').vint(13,1700000000000n).bool(100,true);
  const c=new PW(); c.str(1,'/c1').str(2,'Ch 1').bool(4,true).f32(9,1); m.msg(16,c.done());
  r.msg(1,m.done());
  const s=new PW(); s.str(1,'MangaDex').vint(2,2499283573021220255n); r.msg(101,s.done());
  fs.writeFileSync(ROOT+'tests/sample.tachibk', await gzip(r.done()));
}
const bytes = fs.readFileSync(ROOT+'tests/sample.tachibk');
const file = new window.File([bytes], 'my_library_2026-07-26.tachibk', { type:'application/octet-stream' });
Object.defineProperty($('file-input'), 'files', { value: [file], configurable: true });
$('file-input').dispatchEvent(new window.Event('change'));

ok($('file-info').classList.contains('visible'), 'file info shown');
ok($('output-name').value === 'my_library_2026-07-26_anikku.tachibk', 'output name suggested for default route: '+$('output-name').value);
ok(!$('btn-convert').disabled, 'convert enabled');

// switch to the kotatsu route for the main flow
$('from-app').value='mihon'; $('from-app').dispatchEvent(new window.Event('change'));
$('to-app').value='kotatsu'; $('to-app').dispatchEvent(new window.Event('change'));
ok($('output-name').value === 'my_library_2026-07-26_kotatsu.zip', 'output name follows route change: '+$('output-name').value);

$('opt-keiyoushi').checked = false;
$('btn-convert').dispatchEvent(new window.Event('click'));
await new Promise(r => setTimeout(r, 2500));

const logText = $('log-box').textContent;
console.log('\n--- log ---\n' + [...$('log-box').children].map(l=>'  '+l.textContent.trim()).join('\n') + '\n-----------\n');
ok($('log-status').textContent === 'Done', 'status Done (got: '+$('log-status').textContent+')');
ok($('btn-download').classList.contains('visible'), 'download button revealed');
ok(/favourites/.test(logText), 'log mentions favourites');
ok(!/error/i.test(logText), 'no errors in log');

// switch route and re-convert without reloading
$('from-app').value='animetail'; $('from-app').dispatchEvent(new window.Event('change'));
$('to-app').value='mihon'; $('to-app').dispatchEvent(new window.Event('change'));
ok($('output-name').value.endsWith('_mihon.tachibk'), 'filename follows route change: '+$('output-name').value);
$('btn-convert').dispatchEvent(new window.Event('click'));
await new Promise(r => setTimeout(r, 1500));
ok($('log-status').textContent === 'Done', 'second conversion also Done');
ok(/kept \d+ . manga/.test($('log-box').textContent), 'second run reports manga kept');

console.log(fail?`\n${fail} FAILURES`:'\nend-to-end browser flow passed');
