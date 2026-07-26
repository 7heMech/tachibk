import fs from 'fs';
const ROOT = new URL('../', import.meta.url).pathname;
import { JSDOM } from 'jsdom';
const html = fs.readFileSync(ROOT+'public/index.html','utf8');
const errs = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w){ w.fetch = () => Promise.reject(new Error('offline')); w.CompressionStream = CompressionStream; w.DecompressionStream = DecompressionStream;
    w.addEventListener('error', e => errs.push(e.message)); } });
const { window } = dom; const d = window.document;
let fail=0; const ok=(c,m)=>{console.log((c?'  ok  ':'FAIL  ')+m); if(!c)fail++;};
const $ = id => d.getElementById(id);

ok(errs.length===0, 'no runtime errors on load' + (errs.length?': '+errs.join('; '):''));
ok($('from-app').options.length===10 && $('to-app').options.length===10, 'both selects populated with 10 apps');
ok([...$('from-app').querySelectorAll('optgroup')].length===3, '3 optgroups');
ok($('title-from').textContent==='Mihon' && $('title-to').textContent==='Kotatsu', 'default route Mihon -> Kotatsu');
ok($('mapping-grid').children.length>0, 'mapping rows rendered: '+$('mapping-grid').children.length);
ok($('route-note').textContent.length>60, 'route note rendered');
ok($('parser-count').textContent==='1,256', 'parser count shown: '+$('parser-count').textContent);
ok(!$('opt-row-libname').classList.contains('hidden'), 'library-name option visible for ->kotatsu');
ok($('opt-row-lang').classList.contains('hidden'), 'language option hidden for ->kotatsu');
ok($('btn-convert').disabled, 'convert disabled with no file');
ok($('kind-group').classList.contains('hidden'), 'anime toggle hidden (kotatsu has no anime)');

// swap
$('btn-swap').dispatchEvent(new window.Event('click'));
ok($('title-from').textContent==='Kotatsu' && $('title-to').textContent==='Mihon', 'swap works');
ok(!$('opt-row-lang').classList.contains('hidden') && !$('opt-row-keep').classList.contains('hidden'), 'lang + keep options appear for kotatsu->mihon');
ok($('opt-lang').options.length>10, 'language list populated: '+$('opt-lang').options.length);

// anime pair
$('from-app').value='animetail'; $('from-app').dispatchEvent(new window.Event('change'));
$('to-app').value='anikku'; $('to-app').dispatchEvent(new window.Event('change'));
ok($('kind-group').classList.contains('hidden'), 'toggle hidden for animetail->anikku (only anime is possible)');
ok($('mapping-grid').textContent.includes('501') && $('mapping-grid').textContent.includes('103'), 'auto-selected anime: mapping shows 501 -> 103');
ok($('mapping-grid').textContent.includes('106') && $('mapping-grid').textContent.includes('109'), 'extensions + custom buttons mapped');

// a genuinely two-kind pair: both store manga and anime
$('to-app').value='aniyomi'; $('to-app').dispatchEvent(new window.Event('change'));
ok(!$('kind-group').classList.contains('hidden'), 'toggle appears for animetail->aniyomi (both kinds shared)');
ok([...$('kind-seg').children].every(b=>!b.disabled), 'both kind buttons enabled');
$('kind-seg').querySelector('[data-kind=manga]').dispatchEvent(new window.Event('click',{bubbles:true}));
ok(/manga/.test($('mapping-grid').textContent) && /101/.test($('mapping-grid').textContent), 'switching to manga updates the mapping');

// per-target root differences are visible in the UI
$('from-app').value='komikku'; $('from-app').dispatchEvent(new window.Event('change'));
$('to-app').value='neko'; $('to-app').dispatchEvent(new window.Event('change'));
const rows=[...$('mapping-grid').children];
ok(rows.filter(r=>r.classList.contains('discard')).length>=4, 'komikku->neko shows dropped fields: '+rows.filter(r=>r.classList.contains('discard')).length);
ok(/not in Neko/.test($('mapping-grid').textContent), 'names the target that lacks the field');

// same-app guard (from-app is 'komikku' at this point)
$('to-app').value='komikku'; $('to-app').dispatchEvent(new window.Event('change'));
ok($('route-note').classList.contains('bad') && $('btn-convert').disabled, 'same-app selection blocked');

console.log(fail?`\n${fail} FAILURES`:'\nall UI tests passed');
