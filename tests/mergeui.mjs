/*
 * Merge mode in a real DOM: mode switch, multi-file add, priority reordering,
 * target selection and a full click-through to a downloadable blob.
 *
 * The window.onerror handler is not optional — see AGENTS.md §5. A ReferenceError
 * partway through refresh() once left the element a test inspected already set to
 * the right value, so the suite went green against broken code.
 */
import fs from 'fs';
import { JSDOM } from 'jsdom';
const ROOT = new URL('../', import.meta.url).pathname;
const html = fs.readFileSync(ROOT + 'public/index.html', 'utf8');

const core = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
fs.writeFileSync('/tmp/mergeui-fx.mjs', core + '\nexport {PW,gzip,zipWrite,jsonDump,kotatsuId,mihonSourceId};');
const F = await import('/tmp/mergeui-fx.mjs?v=' + Date.now());
const TE = new TextEncoder();

const errs = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = () => Promise.reject(new Error('offline test'));
    w.CompressionStream = CompressionStream; w.DecompressionStream = DecompressionStream;
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    w.addEventListener('error', e => errs.push(e.message));
  },
});
const { window } = dom, d = window.document, $ = id => d.getElementById(id);
let fail = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const click = (el, ev) => el.dispatchEvent(new window.Event(ev || 'click', { bubbles: true }));
const tick = ms => new Promise(r => setTimeout(r, ms || 60));

/* ---- fixtures ---- */
const { PW } = F;
const md = F.mihonSourceId('MangaDex', 'en', 1);
function mihonBackup(url, title, catName) {
  const r = new PW();
  const m = new PW();
  m.vint(1, md).str(2, url).str(3, title).vint(13, 1700000000000n).vint(17, 0).bool(100, true);
  const c = new PW(); c.str(1, url + '/c1').str(2, 'Ch 1').bool(4, true).f32(9, 1);
  m.msg(16, c.done());
  r.msg(1, m.done());
  const cat = new PW(); cat.str(1, catName).vint(2, 0).vint(3, 9);
  r.msg(2, cat.done());
  const s = new PW(); s.str(1, 'MangaDex').vint(2, md); r.msg(101, s.done());
  return r.done();
}
function anikkuBackup() {
  const r = new PW();
  const ep = new PW(); ep.str(1, '/e/1').str(2, 'Ep 1').bool(4, true);
  const a = new PW(); a.vint(1, 42n).str(2, '/anime/x').str(3, 'Anime X').msg(16, ep.done()).bool(100, true);
  r.msg(3, a.done());
  const cat = new PW(); cat.str(1, 'Watching').vint(2, 0).vint(3, 1); r.msg(4, cat.done());
  const s = new PW(); s.str(1, 'AnimeSrc').vint(2, 42n); r.msg(103, s.done());
  return r.done();
}
const mkFile = (bytes, name) => new window.File([bytes], name, { type: 'application/octet-stream' });
const drop = async files => {
  Object.defineProperty($('merge-file-input'), 'files', { value: files, configurable: true });
  click($('merge-file-input'), 'change');
  await tick(150);
};

/* ---- 1. the convert flow is untouched ---- */
ok(errs.length === 0, 'no runtime errors on load' + (errs.length ? ': ' + errs.join('; ') : ''));
ok(!$('convert-pane').classList.contains('hidden'), 'convert mode is the default');
ok($('merge-pane').classList.contains('hidden'), 'merge pane starts hidden');
ok($('btn-merge').classList.contains('hidden'), 'merge button starts hidden');
ok($('title-from').textContent === 'Aniyomi' && $('title-to').textContent === 'Anikku', 'default convert route intact');

/* ---- 2. switching modes ---- */
click($('mode-seg').querySelector('[data-mode=merge]'));
ok($('convert-pane').classList.contains('hidden') && !$('merge-pane').classList.contains('hidden'), 'switching to merge swaps the panes');
ok($('btn-convert').classList.contains('hidden') && !$('btn-merge').classList.contains('hidden'), 'and swaps the action button');
ok($('btn-merge').disabled, 'merge disabled with no files');
ok($('merge-to').options.length === 10, 'target select populated: ' + $('merge-to').options.length);
ok($('merge-to').value === 'aniyomi', 'defaults to the one target that stores both kinds');
ok(/first file wins/.test($('merge-note').textContent), 'the empty state explains that order is priority');

/* ---- 3. adding files ---- */
await drop([
  mkFile(await F.gzip(mihonBackup('/manga/a', 'Shared Series', 'Reading')), 'phone.tachibk'),
  mkFile(await F.gzip(anikkuBackup()), 'tv.tachibk'),
]);
ok(errs.length === 0, 'no runtime errors while parsing' + (errs.length ? ': ' + errs.join('; ') : ''));
ok($('merge-list').children.length === 2, 'two rows in the file list: ' + $('merge-list').children.length);
const rowText = i => $('merge-list').children[i].textContent;
ok(/phone\.tachibk/.test(rowText(0)) && /Mihon family/.test(rowText(0)), 'first row identifies the format: ' + rowText(0).trim());
ok(/Anikku \/ legacy Aniyomi/.test(rowText(1)), 'second row detects the anime layout: ' + rowText(1).trim());
ok(/1 manga/.test(rowText(0)) && /1 anime/.test(rowText(1)), 'per-file counts shown');
ok(!$('btn-merge').disabled, 'merge enabled once files parse');
ok(/1 manga and 1 anime/.test($('merge-note').textContent), 'summary counts both kinds: ' + $('merge-note').textContent.trim());
ok($('output-name').value === 'merged_library_aniyomi.tachibk', 'output name suggested: ' + $('output-name').value);

/* ---- 4. a target that cannot hold everything says so ---- */
$('merge-to').value = 'mihon'; click($('merge-to'), 'change');
ok(/1 anime will be dropped/.test($('merge-note').textContent), 'dropping anime is called out for Mihon: ' + $('merge-note').textContent.trim());
ok($('output-name').value === 'merged_library_mihon.tachibk', 'output name follows the target');
$('merge-to').value = 'anikku'; click($('merge-to'), 'change');
ok(/1 manga will be dropped/.test($('merge-note').textContent), 'and dropping manga is called out for Anikku');

/* ---- 5. priority reordering ---- */
$('merge-to').value = 'aniyomi'; click($('merge-to'), 'change');
ok($('merge-list').querySelector('[data-act=up]').disabled, 'the first row cannot move up');
click($('merge-list').children[1].querySelector('[data-act=up]'));
ok(/tv\.tachibk/.test(rowText(0)) && /phone\.tachibk/.test(rowText(1)), 'moving a row up reorders priority: ' + rowText(0).trim().slice(0, 20));
click($('merge-list').children[0].querySelector('[data-act=down]'));
ok(/phone\.tachibk/.test(rowText(0)), 'and moving it back down restores the order');

/* ---- 6. the whole flow ---- */
$('opt-keiyoushi').checked = false;
click($('btn-merge'));
await tick(2500);
const logText = $('log-box').textContent;
console.log('\n--- log ---\n' + [...$('log-box').children].map(l => '  ' + l.textContent.trim()).join('\n') + '\n-----------\n');
ok($('log-status').textContent === 'Done', 'merge finished (status: ' + $('log-status').textContent + ')');
ok($('btn-download').classList.contains('visible'), 'download button revealed');
ok(/wrote 1 manga/.test(logText) && /wrote 1 anime/.test(logText), 'log reports both halves written');
ok(/501–506 layout/.test(logText), 'log names the anime layout it chose');
ok(!/error/i.test(logText), 'no errors in the log');
ok(errs.length === 0, 'no uncaught page errors during the merge' + (errs.length ? ': ' + errs.join('; ') : ''));

/* Running it a second time must produce the same result — the engine mutates its
   decoded entries, so the files have to be re-read rather than reused. */
click($('btn-merge'));
await tick(2500);
ok($('log-status').textContent === 'Done', 'a second merge without reloading also succeeds');
ok(/manga: 1 in, 1 out/.test($('log-box').textContent), 'and reports the same counts, not a library folded into itself');

/* ---- 7. removing files, and going back to convert ---- */
click($('merge-list').children[0].querySelector('[data-act=rm]'));
ok($('merge-list').children.length === 1, 'removing a row shrinks the list');
click($('merge-list').children[0].querySelector('[data-act=rm]'));
ok($('merge-list').children.length === 0 && $('btn-merge').disabled, 'emptying the list disables merge');

click($('mode-seg').querySelector('[data-mode=convert]'));
ok(!$('convert-pane').classList.contains('hidden') && $('merge-pane').classList.contains('hidden'), 'switching back restores convert mode');
ok($('title-from').textContent === 'Aniyomi' && $('title-to').textContent === 'Anikku', 'and the convert route is where it was left');
ok(!$('log-wrapper').classList.contains('visible'), 'the merge log is cleared on mode change');

/* ---- 8. a file that is not a backup is reported, not swallowed ---- */
click($('mode-seg').querySelector('[data-mode=merge]'));
await drop([mkFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'notes.txt')]);
ok($('merge-list').children.length === 1, 'the bad file is still listed');
ok($('merge-list').children[0].classList.contains('bad'), 'and flagged');
ok($('btn-merge').disabled, 'merge stays disabled with nothing usable');
ok(errs.length === 0, 'a bad file does not throw into the page' + (errs.length ? ': ' + errs.join('; ') : ''));

console.log(fail ? `\n${fail} FAILURES` : '\nmerge UI flow passed');
process.exit(fail ? 1 : 0);
