/*
 * Merge engine.
 *
 * The first block is the one that gates the rest: the conversion routes filter bytes
 * and so keep every field a fork declares for free, but merging rebuilds entries from
 * a decoded model. If decode -> encode is not lossless, merging two Mihon backups
 * quietly costs the user their tracking links, notes and excluded scanlators — data a
 * plain conversion keeps. Nothing below is worth trusting until that round trip holds.
 */
import fs from 'fs';
const ROOT = new URL('../', import.meta.url).pathname;
const core = [...fs.readFileSync(ROOT + 'public/index.html', 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
fs.writeFileSync('/tmp/merge-mod.mjs', core + '\nexport {runMerge,inspectBackup,decodeBackup,decodeManga,encodeManga,PW,gzip,gunzip,zipRead,zipWrite,jsonDump,jsonParseBig,mihonSourceId,kotatsuId,pbFields,readVarint,APPS,ANIME_LAYOUT};');
const M = await import('/tmp/merge-mod.mjs?v=' + Date.now());
const TD = new TextDecoder(), TE = new TextEncoder();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const log = () => {};
const logs = [];
const cap = (m, t) => logs.push(`[${t || 'info'}] ${m}`);
const { PW, mihonSourceId } = M;

/* Field numbers whose payload is itself a message, per nesting depth. Used only to
   normalise for comparison — protobuf does not order fields, so a raw byte compare
   would fail on a reordering that changes nothing. */
const MSG_AT = [new Set([1, 2, 3, 4, 101, 501, 502, 503]), new Set([16, 104]), new Set()];
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
function norm(buf, depth = 0) {
  const out = [];
  for (const { f, w, val } of M.pbFields(buf)) {
    if (w === 2 && (MSG_AT[depth] || new Set()).has(f)) out.push([f, 'msg', norm(val, depth + 1)]);
    else if (depth === 1 && f === 17 && w === 2) {
      let o = 0;
      while (o < val.length) { let v; [v, o] = M.readVarint(val, o); out.push([17, 0, String(v)]); }
    } else out.push([f, w, w === 0 ? String(val) : hex(val)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const md = mihonSourceId('MangaDex', 'en', 1);
const tn = mihonSourceId('Toonily', 'en', 1);

/* ===========================================================================
 * 1. Lossless round trip. Every field Mihon's BackupManga/BackupChapter declare
 *    today, including the ones the model does not interpret, plus a couple of
 *    invented fork-specific numbers standing in for whatever ships next.
 * ======================================================================== */
{
  const ch = new PW();
  ch.str(1, '/c/1').str(2, 'Chapter 1').str(3, 'ScanGroup')
    .bool(4, true).bool(5, false).vint(6, 42).vint(7, 1600000000000n).vint(8, 1610000000000n)
    .f32(9, 1.5).vint(10, 7).vint(11, 1620000000000n).vint(12, 3);
  ch.msg(13, TE.encode('{}'));           // memo — never interpreted
  ch.str(777, 'fork chapter field');

  const tracking = new PW(); tracking.vint(1, 2).str(4, 'https://anilist.co/manga/1').vint(6, 12);
  const hist = new PW(); hist.str(1, '/c/1').vint(2, 1712000000000n).vint(3, 90000n);

  const m = new PW();
  m.vint(1, md).str(2, '/manga/a').str(3, 'Title').str(4, 'Artist').str(5, 'Author')
   .str(6, 'Description').str(7, 'Action').str(7, 'Drama').vint(8, 1).str(9, 'https://cdn/x.jpg')
   .vint(13, 1700000000000n).vint(14, 2);
  m.msg(16, ch.done());
  m.vint(17, 0).vint(17, 2);
  m.msg(18, tracking.done());
  m.bool(100, true).vint(101, 1024).vint(103, 3);
  m.msg(104, hist.done());
  m.vint(105, 1).vint(106, 1710000000000n).vint(107, 1705000000000n)
   .str(108, 'BadScans').vint(109, 4).str(110, 'my notes').bool(111, true);
  m.msg(112, TE.encode('{}'));
  m.str(600, 'fork manga field');

  const bytes = m.done();
  const round = M.encodeManga(M.decodeManga(bytes, false), false);
  ok(same(norm(bytes, 1), norm(round, 1)), 'BackupManga survives decode -> encode with every field intact');

  const dec = M.decodeManga(bytes, false);
  ok(dec.history[0].readDuration === 90000n, 'BackupHistory.readDuration is decoded (field 3)');
  ok(dec.chapters[0].dateFetch === 1600000000000n, 'BackupChapter.dateFetch is decoded (field 7)');
  const raw = M.encodeManga(dec, false);
  ok(TD.decode(raw).includes('my notes'), 'notes (110) survive a rebuild');
  ok(TD.decode(raw).includes('BadScans'), 'excludedScanlators (108) survive a rebuild');
  ok(TD.decode(raw).includes('anilist.co'), 'tracking (18) survives a rebuild');
  ok(TD.decode(raw).includes('fork manga field'), 'an unknown fork field survives a rebuild');
}

/* BackupAnime: season fields 502/503 are decoded, 500/504/505/506/507 ride along raw. */
{
  const ep = new PW();
  ep.str(1, '/e/1').str(2, 'Episode 1').bool(4, true).vint(6, 300).vint(16, 1440).bool(501, true).str(502, 'summary');
  const a = new PW();
  a.vint(1, 999n).str(2, '/anime/x').str(3, 'Anime X');
  a.msg(16, ep.done());
  a.str(500, 'https://cdn/bg.jpg').vint(502, 11n).vint(503, 12n).vint(504, 5n).f32(505, 2).vint(506, 1n);
  const bytes = a.done();
  const dec = M.decodeManga(bytes, true);
  ok(dec.seasonParentId === 11n && dec.seasonId === 12n, 'anime season parentId/id decoded');
  ok(dec.chapters[0].totalSeconds === 1440n && dec.chapters[0].fillermark === true, 'episode totalSeconds + fillermark decoded');
  ok(same(norm(bytes, 1), norm(M.encodeManga(dec, true), 1)), 'BackupAnime survives decode -> encode, seasons included');
  const stripped = M.encodeManga(M.decodeManga(bytes, true), true, true);
  const highs = [...M.pbFields(stripped)].map(x => x.f).filter(f => f >= 500);
  ok(highs.length === 0, 'encodeManga can strip fields >= 500 on request: left ' + highs.join(','));
  const epHigh = [...M.pbFields([...M.pbFields(stripped)].find(x => x.f === 16).val)].map(x => x.f).filter(f => f >= 500);
  ok(epHigh.length === 0, 'and the strip recurses into episodes, as stripHighFields does: left ' + epHigh.join(','));
}

/* Nested >= 500 stripping, on the two cases that differ.
 *
 * Into a manga-only target it must happen: Mihon's BackupChapter stops at 13, so a
 * fork field nested inside a chapter has nowhere to land.
 *
 * Into Anikku it must NOT happen, which is where the layout tables mislead. ANIME_LAYOUT
 * describes root numbering only; Anikku's own BackupManga declares 500 and 502-507 and
 * its BackupChapter declares 501 fillermark, 502 summary and 503 previewUrl, exactly as
 * Aniyomi does. Stripping there would throw away season links and fillermarks the target
 * fully supports.
 */
{
  const forkChapter = new PW();
  forkChapter.str(1, '/c/1').str(2, 'Ch 1').f32(9, 1).str(540, 'fork chapter extra');
  const forkManga = new PW();
  forkManga.vint(1, md).str(2, '/manga/fork').str(3, 'Fork Series').bool(100, true)
    .msg(16, forkChapter.done()).str(530, 'fork manga extra');
  const animeSrc = new PW();
  animeSrc.msg(501, forkManga.done());   // an Aniyomi-layout file carrying manga too
  const r = new PW();
  r.msg(1, forkManga.done());
  r.vint(500, 0);
  const anime = new PW();
  const ep = new PW(); ep.str(1, '/e/1').str(2, 'Ep 1').bool(501, true).str(502, 'ep summary');
  anime.vint(1, 42n).str(2, '/anime/s2').str(3, 'Season 2').bool(100, true)
    .msg(16, ep.done()).str(500, 'https://cdn/bg.jpg').vint(503, 8n).f32(505, 2);
  r.msg(501, anime.done());
  const src2 = new PW(); src2.str(1, 'AnimeSrc').vint(2, 42n); r.msg(503, src2.done());

  const inp = await M.inspectBackup(await M.gzip(r.done()), 'aniyomi.tachibk');
  const nested = (bk, field) => {
    const e = [...M.pbFields(bk)].find(x => x.f === field);
    const top = [...M.pbFields(e.val)].map(x => x.f).filter(f => f >= 500);
    const ch = [...M.pbFields(e.val)].filter(x => x.f === 16)
      .flatMap(x => [...M.pbFields(x.val)].map(y => y.f)).filter(f => f >= 500);
    return { top, ch };
  };

  const toMihon = await M.gunzip(await M.runMerge([inp], 'mihon', {}, log));
  const mihon = nested(toMihon, 1);
  ok(mihon.top.length === 0, 'manga into Mihon: fork fields >= 500 stripped from the manga: left ' + mihon.top.join(','));
  ok(mihon.ch.length === 0, 'manga into Mihon: and from its chapters too: left ' + mihon.ch.join(','));

  const toAnikku = await M.gunzip(await M.runMerge([inp], 'anikku', {}, log));
  const anikku = nested(toAnikku, 3);
  ok(anikku.top.includes(500) && anikku.top.includes(503),
    'anime into Anikku: backgroundUrl and season id kept \u2014 Anikku declares them: ' + anikku.top.join(','));
  ok(anikku.ch.includes(501) && anikku.ch.includes(502),
    'anime into Anikku: episode fillermark and summary kept: ' + anikku.ch.join(','));
}

/* ===========================================================================
 * 2. Two Mihon phones, overlapping library and overlapping chapters.
 * ======================================================================== */
function chap(url, name, num, read, page, bm) {
  const c = new PW();
  c.str(1, url).str(2, name).bool(4, !!read).bool(5, !!bm).vint(6, page || 0).f32(9, num).vint(10, num - 1);
  return c.done();
}
function mkManga(sid, url, title, cats, chs, extra) {
  const m = new PW();
  m.vint(1, sid).str(2, url).str(3, title).vint(13, 1700000000000n);
  for (const c of chs) m.msg(16, c);
  for (const c of cats) m.vint(17, c);
  m.bool(100, true).vint(106, 1710000000000n);
  if (extra) extra(m);
  return m.done();
}
function cat(name, order, id, flags) {
  const c = new PW(); c.str(1, name).vint(2, order).vint(3, id);
  if (flags !== undefined) c.vint(100, flags);
  return c.done();
}
function src(name, id) { const s = new PW(); s.str(1, name).vint(2, id); return s.done(); }

const phone = (() => {
  const r = new PW();
  /* Categories deliberately have id != order — see AGENTS.md §8. Field 17 below
     references order, and "Reading" sits at order 1 while carrying id 9. */
  r.msg(2, cat('Later', 0, 4, 0n));
  r.msg(2, cat('Reading', 1, 9, 260n));
  r.msg(1, mkManga(md, '/manga/a', 'Shared Series', [1],
    [chap('/c/1', 'Ch 1', 1, true, 5), chap('/c/2', 'Ch 2', 2, false, 0)],
    m => m.str(110, 'phone note')));
  r.msg(1, mkManga(tn, '/only-phone', 'Phone Only', [0], [chap('/p/1', 'Ch 1', 1, true, 0)]));
  r.msg(101, src('MangaDex', md)); r.msg(101, src('Toonily', tn));
  const pref = new PW(); pref.str(1, 'phone_pref'); r.msg(104, pref.done());
  return r.done();
})();

const tablet = (() => {
  const r = new PW();
  r.msg(2, cat('Reading', 0, 2, 0n));
  r.msg(2, cat('Seinen', 1, 7, 0n));
  /* Same manga, url differs only by a trailing slash; chapter 2 was read further
     here, and chapter 3 does not exist on the phone at all. */
  r.msg(1, mkManga(md, '/manga/a/', 'Shared Series', [0, 1],
    [chap('/c/2', 'Ch 2', 2, true, 18, true), chap('/c/3', 'Ch 3', 3, false, 0)]));
  r.msg(1, mkManga(tn, '/only-tablet', 'Tablet Only', [1], []));
  r.msg(101, src('MangaDex', md)); r.msg(101, src('Toonily', tn));
  const pref = new PW(); pref.str(1, 'tablet_pref'); r.msg(104, pref.done());
  return r.done();
})();

{
  logs.length = 0;
  const a = await M.inspectBackup(await M.gzip(phone), 'phone.tachibk');
  const b = await M.inspectBackup(await M.gzip(tablet), 'tablet.tachibk');
  ok(a.label === 'Mihon family' && a.manga === 2, 'phone backup detected: ' + a.label + ', ' + a.manga + ' manga');
  const out = M.decodeBackup(await M.gunzip(await M.runMerge([a, b], 'mihon', {}, cap)));

  ok(out.manga.length === 3, 'three distinct manga after merge (one deduped): ' + out.manga.length);
  const shared = out.manga.find(m => m.title === 'Shared Series');
  ok(!!shared, 'the shared series is present once');
  ok(shared.url === '/manga/a', 'the higher-priority url wins: ' + shared.url);
  ok(shared.chapters.length === 3, 'chapters unioned across devices: ' + shared.chapters.length);
  const c2 = shared.chapters.find(c => c.url === '/c/2');
  ok(c2.read === true, 'chapter read on the tablet is read after the merge');
  ok(c2.lastPageRead === 18, 'reading position takes the furthest of the two: ' + c2.lastPageRead);
  ok(c2.bookmark === true, 'bookmark from either device survives');
  const c3 = shared.chapters.find(c => c.url === '/c/3');
  ok(!!c3, 'a chapter only the tablet knew about is carried over');
  ok(c3.sourceOrder > Math.max(...shared.chapters.filter(c => c.url !== '/c/3').map(c => c.sourceOrder ?? -1)),
    'a newly added chapter is appended past the existing source order, not interleaved');
  ok(TD.decode(M.encodeManga(shared, false)).includes('phone note'),
    'a field the merge engine does not interpret survives the merge');

  const names = out.categories.map(c => c.name);
  ok(names.join(',') === 'Later,Reading,Seinen', 'categories unioned by name in priority order: ' + names.join(','));
  ok(out.categories.every((c, i) => c.order === i), 'category order reassigned from array position');
  const reading = out.categories.find(c => c.name === 'Reading');
  ok(reading.flags === 260n, 'category flags (field 100) survive the merge: ' + reading.flags);
  ok(shared.categories.includes(reading.order), 'the shared series keeps its Reading membership by name, not index');
  ok(shared.categories.includes(out.categories.find(c => c.name === 'Seinen').order), 'and picks up Seinen from the tablet');
  ok(!shared.categories.includes(out.categories.find(c => c.name === 'Later').order), 'without leaking into Later');

  ok(out.sources.length === 2, 'sources unioned by id: ' + out.sources.length);
  ok(out.rootFields.has(106), 'Keiyoushi extension store written for a Mihon target');
  const prefText = logs.join('\n');
  ok(/carried preferences from phone\.tachibk/.test(prefText), 'preferences taken from the priority input');
  ok(/1 other backup/.test(prefText), 'and the discarded ones are reported');
}

/* ===========================================================================
 * 3. Manga phone + anime phone -> Aniyomi, one hybrid file.
 * ======================================================================== */
const anikkuBk = (() => {
  const r = new PW();
  const ep = new PW(); ep.str(1, '/e/1').str(2, 'Ep 1').bool(4, true).vint(6, 600);
  const a = new PW(); a.vint(1, 42n).str(2, '/anime/x').str(3, 'Anime X').msg(16, ep.done()).vint(17, 0).bool(100, true);
  r.msg(3, a.done());
  r.msg(4, cat('Watching', 0, 5, 0n));
  r.msg(103, src('AnimeSrc', 42n));
  return r.done();
})();

{
  logs.length = 0;
  const a = await M.inspectBackup(await M.gzip(phone), 'phone.tachibk');
  const b = await M.inspectBackup(await M.gzip(anikkuBk), 'anikku.tachibk');
  ok(b.label === 'Anikku / legacy Aniyomi' && b.anime === 1, 'anime backup detected: ' + b.label);
  const gz = await M.runMerge([a, b], 'aniyomi', {}, cap);
  const raw = await M.gunzip(gz);
  const out = M.decodeBackup(raw);
  ok(out.manga.length === 2 && out.anime.length === 1, `hybrid output: ${out.manga.length} manga + ${out.anime.length} anime`);
  ok(out.animeLayout === 'x5', 'anime written in the 501-506 layout: ' + out.animeLayout);
  const roots = [...out.rootFields].sort((x, y) => x - y);
  ok(roots.includes(500), 'isLegacy (500) is written — Anikku marks it @Required and Aniyomi keys its serializer choice on it');
  ok(!roots.includes(3) && !roots.includes(4) && !roots.includes(103),
    'no legacy anime field leaks in beside the 5xx ones: ' + roots.join(','));
  ok(out.anime[0].chapters[0].read === true, 'episode watch state carried across the layout change');
  ok(out.animeCategories.length === 1 && out.animeCategories[0].name === 'Watching', 'anime categories kept separate from manga ones');
  ok(!roots.includes(106), 'no extension store written for Aniyomi, whose field 106 is a different message');
}

/* Same pair the other way: an anime-only target must drop the manga and say so. */
{
  logs.length = 0;
  const a = await M.inspectBackup(await M.gzip(phone), 'phone.tachibk');
  const b = await M.inspectBackup(await M.gzip(anikkuBk), 'anikku.tachibk');
  const out = M.decodeBackup(await M.gunzip(await M.runMerge([a, b], 'anikku', {}, cap)));
  ok(out.manga.length === 0 && out.anime.length === 1, 'Anikku output is anime only');
  ok(out.animeLayout === 'low', 'and uses the legacy 3/4/103 layout it detects on');
  ok(![...out.rootFields].includes(500), 'field 500 absent, so Anikku decodes it as a legacy backup');
  ok(/skipped 2 manga/.test(logs.join('\n')), 'the dropped manga are reported: ' + logs.filter(l => /skipped/.test(l)).join(' '));
}

/* A manga-only target must refuse rather than emit an empty file. */
{
  const b = await M.inspectBackup(await M.gzip(anikkuBk), 'anikku.tachibk');
  let msg = '';
  await M.runMerge([b], 'mihon', {}, log).catch(e => { msg = e.message; });
  ok(/Nothing left to write/.test(msg), 'anime-only input into Mihon is refused: ' + msg);
}

/* ===========================================================================
 * 4. Season ids are device-local. Two devices whose season rows collide must not
 *    end up re-parenting each other's shows — the anime form of the category
 *    id-vs-order bug in AGENTS.md §8.
 * ======================================================================== */
{
  const mkAnime = (url, title, id, parent) => {
    const a = new PW(); a.vint(1, 42n).str(2, url).str(3, title).bool(100, true);
    if (id !== undefined) a.vint(503, id);
    if (parent !== undefined) a.vint(502, parent);
    return a.done();
  };
  /* Both devices number their rows from 1. On device A row 1 is "Show A" and row 2
     is its season; on device B row 1 is a different show entirely. A merge that kept
     the raw ids would hang device B's season off device A's show. */
  const devA = (() => { const r = new PW(); r.msg(501, mkAnime('/a', 'Show A', 1n)); r.msg(501, mkAnime('/a/s2', 'Show A S2', 2n, 1n)); r.vint(500, 0); return r.done(); })();
  const devB = (() => { const r = new PW(); r.msg(501, mkAnime('/b', 'Show B', 1n)); r.msg(501, mkAnime('/b/s2', 'Show B S2', 3n, 1n)); r.vint(500, 0); return r.done(); })();

  const a = await M.inspectBackup(await M.gzip(devA), 'devA.tachibk');
  const b = await M.inspectBackup(await M.gzip(devB), 'devB.tachibk');
  const out = M.decodeBackup(await M.gunzip(await M.runMerge([a, b], 'aniyomi', {}, log)));
  ok(out.anime.length === 4, 'all four anime entries survive: ' + out.anime.length);
  const byTitle = Object.fromEntries(out.anime.map(x => [x.title, x]));
  ok(new Set(out.anime.map(x => String(x.seasonId))).size === 4, 'every season id is unique after renumbering');
  ok(byTitle['Show A S2'].seasonParentId === byTitle['Show A'].seasonId,
    'Show A S2 still points at Show A');
  ok(byTitle['Show B S2'].seasonParentId === byTitle['Show B'].seasonId,
    'Show B S2 points at Show B, not at whatever now holds id 1');
  ok(byTitle['Show A S2'].seasonParentId !== byTitle['Show B S2'].seasonParentId,
    'the two devices’ season 1 rows did not collapse into one parent');
}

/* ===========================================================================
 * 5. Kotatsu inputs. Chapter lists must never be cleared by a format that has none.
 * ======================================================================== */
function kotatsuZip(rows, cats) {
  const favourites = [], history = [];
  for (const r of rows) {
    const id = M.kotatsuId(r.source, r.url);
    const manga = { id, title: r.title, alt_title: null, url: r.url, public_url: 'https://mangadex.org' + r.url,
      rating: r.rating ?? -1.0, nsfw: false, cover_url: '', large_cover_url: null, state: '',
      author: r.author || '', source: r.source, tags: r.tags || [] };
    for (const c of (r.cats || [2n])) favourites.push({ manga_id: id, category_id: c, sort_key: 0, created_at: 1690000000000n, deleted_at: 0, manga });
    history.push({ manga_id: id, created_at: 1690000000000n, updated_at: r.updated || 1699000000000n, chapter_id: 0, page: 0, scroll: 0.0, percent: 0.5, manga });
  }
  const files = [
    { name: 'favourites', data: TE.encode(M.jsonDump(favourites)) },
    { name: 'history', data: TE.encode(M.jsonDump(history)) },
    { name: 'categories', data: TE.encode(M.jsonDump(cats)) },
    { name: 'index', data: TE.encode(M.jsonDump([{ app_id: 'test', app_version: 1, created_at: 0 }])) },
  ];
  return M.zipWrite(files);
}

{
  logs.length = 0;
  /* The same MangaDex series as the phone backup, under Kotatsu's own url shape. */
  const kz = await kotatsuZip(
    [{ source: 'MANGADEX', url: '/manga/a', title: 'Shared Series', cats: [7n] },
     { source: 'MANGADEX', url: '/manga/kotatsu-only', title: 'Kotatsu Only', cats: [7n] }],
    [{ category_id: 7n, sort_key: 3, title: 'Kotatsu Shelf', created_at: 0, deleted_at: 0 }]);

  const p = await M.inspectBackup(await M.gzip(phone), 'phone.tachibk');
  const k = await M.inspectBackup(kz, 'tab.zip');
  ok(k.fam === 'kotatsu' && k.manga === 2, 'Kotatsu zip detected: ' + k.label + ', ' + k.manga + ' manga');

  const out = M.decodeBackup(await M.gunzip(await M.runMerge([p, k], 'mihon', { useKeiyoushi: false }, cap)));
  const shared = out.manga.find(m => m.title === 'Shared Series');
  ok(out.manga.length === 3, 'Kotatsu entry merged into the matching Mihon one: ' + out.manga.length + ' total');
  ok(shared.chapters.length === 2, 'the Mihon chapter list is NOT cleared by a format that stores none: ' + shared.chapters.length);
  ok(shared.chapters.find(c => c.url === '/c/1').read === true, 'and its read state is intact');
  ok(out.categories.some(c => c.name === 'Kotatsu Shelf'), 'the Kotatsu category came across: ' + out.categories.map(c => c.name).join(','));
  ok(shared.categories.includes(out.categories.find(c => c.name === 'Kotatsu Shelf').order), 'and the shared entry belongs to it');
}

/* Kotatsu + Kotatsu stays in Kotatsu's own format — the Mihon-shaped model has no
   room for tags, rating or nsfw, and round-tripping through it would drop them. */
{
  logs.length = 0;
  const z1 = await kotatsuZip(
    [{ source: 'MANGADEX', url: '/m/1', title: 'One', tags: [{ id: 1n, title: 'Action', key: 'action', source: 'MANGADEX' }], rating: 0.8, cats: [3n] }],
    [{ category_id: 3n, sort_key: 0, title: 'Shelf', created_at: 0, deleted_at: 0 }]);
  const z2 = await kotatsuZip(
    [{ source: 'MANGADEX', url: '/m/1', title: 'One', updated: 1712000000000n, cats: [9n] },
     { source: 'TOONILY', url: '/m/2', title: 'Two', cats: [9n] }],
    [{ category_id: 9n, sort_key: 0, title: 'Shelf', created_at: 0, deleted_at: 0 },
     { category_id: 10n, sort_key: 1, title: 'Other', created_at: 0, deleted_at: 0 }]);

  const a = await M.inspectBackup(z1, 'a.zip'), b = await M.inspectBackup(z2, 'b.zip');
  const zip = await M.runMerge([a, b], 'kotatsu', {}, cap);
  const files = Object.fromEntries((await M.zipRead(zip)).map(e => [e.name, M.jsonParseBig(TD.decode(e.data))]));
  ok(files.favourites.length === 2, 'the duplicate favourite collapsed: ' + files.favourites.length);
  ok(files.categories.length === 2, 'categories deduped by title across zips: ' + files.categories.map(c => c.title).join(','));
  ok(new Set(files.favourites.map(f => String(f.category_id))).size === 1, 'both entries landed in the single merged Shelf');
  const one = files.favourites.find(f => f.manga.title === 'One');
  ok(one.manga.tags.length === 1 && one.manga.rating === 0.8, 'Kotatsu-only fields (tags, rating) survive a Kotatsu -> Kotatsu merge');
  ok(files.history.length === 2, 'history deduped by manga id: ' + files.history.length);
  ok(String(files.history.find(h => h.manga.title === 'One').updated_at) === '1712000000000', 'and keeps the most recent read time');
}

/* A Mihon backup merged into a Kotatsu target has to come back out through the
   Kotatsu builder, which joins categories on list position (AGENTS.md §8). */
{
  logs.length = 0;
  const kz = await kotatsuZip(
    [{ source: 'MANGADEX', url: '/m/9', title: 'Kotatsu Side', cats: [3n] }],
    [{ category_id: 3n, sort_key: 0, title: 'Shelf', created_at: 0, deleted_at: 0 }]);
  const p = await M.inspectBackup(await M.gzip(phone), 'phone.tachibk');
  const k = await M.inspectBackup(kz, 'tab.zip');
  const zip = await M.runMerge([p, k], 'kotatsu', { useKeiyoushi: false, libraryName: 'Library' }, cap);
  const files = Object.fromEntries((await M.zipRead(zip)).map(e => [e.name, M.jsonParseBig(TD.decode(e.data))]));
  const titles = new Set(files.favourites.map(f => f.manga.title));
  ok(titles.has('Shared Series') && titles.has('Kotatsu Side'), 'mixed inputs reach a Kotatsu target: ' + [...titles].join(', '));
  const cats = Object.fromEntries(files.categories.map(c => [c.title, String(c.category_id)]));
  ok(!!cats.Reading && !!cats.Shelf, 'both sides\u2019 categories present: ' + Object.keys(cats).join(','));
  const shared = files.favourites.filter(f => f.manga.title === 'Shared Series').map(f => String(f.category_id));
  ok(shared.includes(cats.Reading), 'the Mihon entry lands in Reading, not in whichever category holds that index');
  ok(!shared.includes(cats.Shelf), 'and does not leak into the Kotatsu-side category');
  ok(/skipped 0 anime/.test(logs.join('\n')) === false, 'no spurious anime warning for a manga-only merge');
}

/* ===========================================================================
 * 5b. One source, several ids.
 *
 * Reported from real use: merging a TachiyomiSY backup with a Komikku one produced
 * two copies of every E-Hentai gallery. SY keeps E-Hentai on its own internal id
 * (LEWD_SOURCE_SERIES + 1 = 6901) while Komikku moved it onto the `all.ehentai`
 * extension ids and registers its built-in source under each of them, so the same
 * url under two ids never matched.
 * ======================================================================== */
{
  const EH_SY = 6901n;
  const EH_EXT_ALL = mihonSourceId('E-Hentai', 'all', 1);
  const EH_EXT_EN = mihonSourceId('E-Hentai', 'en', 1);
  ok(EH_EXT_ALL === 1713178126840476467n, 'computed E-Hentai (all) id matches Komikku EH_SOURCE_ID: ' + EH_EXT_ALL);
  ok(EH_EXT_EN === 57122881048805941n, 'computed E-Hentai (en) id matches Komikku\u2019s table: ' + EH_EXT_EN);
  ok(mihonSourceId('ExHentai', 'all', 1) === 6225928719850211219n, 'and ExHentai matches EXH_SOURCE_ID');

  const sy = (() => {
    const r = new PW();
    r.msg(1, mkManga(EH_SY, '/g/123/abc/', 'Shared Gallery', [], [chap('/g/123/abc/1', 'p1', 1, true, 4)]));
    r.msg(101, src('E-Hentai', EH_SY));
    return r.done();
  })();
  const komikku = (() => {
    const r = new PW();
    r.msg(1, mkManga(EH_EXT_EN, '/g/123/abc/', 'Shared Gallery', [], [chap('/g/123/abc/2', 'p2', 2, true, 9)]));
    r.msg(1, mkManga(EH_EXT_ALL, '/g/999/zzz/', 'Other Gallery', [], []));
    r.msg(101, src('E-Hentai (En)', EH_EXT_EN));
    return r.done();
  })();

  logs.length = 0;
  const a = await M.inspectBackup(await M.gzip(sy), 'sy.tachibk');
  const b = await M.inspectBackup(await M.gzip(komikku), 'komikku.tachibk');
  const out = M.decodeBackup(await M.gunzip(await M.runMerge([a, b], 'komikku', {}, cap)));

  ok(out.manga.length === 2, 'the SY and Komikku copies collapse into one entry: ' + out.manga.length + ' total');
  const shared = out.manga.find(m => m.title === 'Shared Gallery');
  ok(shared.chapters.length === 2, 'and their read progress is unioned rather than split: ' + shared.chapters.length);
  ok(String(shared.source) === String(EH_EXT_ALL), 'written with the extension id Komikku resolves: ' + shared.source);
  ok(out.sources.length === 1, 'the source list collapses too: ' + out.sources.map(x => x.name + '=' + x.sourceId).join(', '));
  ok(/appeared under 3 different source ids/.test(logs.join('\n')), 'the log names the ids it unified: '
    + (logs.find(l => /different source ids/.test(l)) || '(none)'));

  /* ...but TachiyomiSY's built-in source only answers to 6901, so a backup aimed at
     SY has to carry that id rather than the canonical one. */
  const toSy = M.decodeBackup(await M.gunzip(await M.runMerge([a, b], 'sy', {}, log)));
  const sharedSy = toSy.manga.find(m => m.title === 'Shared Gallery');
  ok(String(sharedSy.source) === '6901', 'targeting TachiyomiSY writes its internal id back: ' + sharedSy.source);
  ok(toSy.sources.every(x => String(x.sourceId) === '6901'), 'and the source list agrees: ' + toSy.sources.map(x => x.sourceId).join(','));
  ok(String(toSy.manga.find(m => m.title === 'Other Gallery').source) === '6901', 'including entries that only ever had the extension id');

  /* Legacy pre-migration ids Komikku still rewrites on restore. */
  const oldBk = (() => { const r = new PW(); r.msg(1, mkManga(6907n, '/g/1/', 'Old NHentai', [], [])); return r.done(); })();
  const c = await M.inspectBackup(await M.gzip(oldBk), 'old.tachibk');
  const migrated = M.decodeBackup(await M.gunzip(await M.runMerge([c], 'mihon', {}, log)));
  ok(String(migrated.manga[0].source) === '7309872737163460316', 'legacy NHentai id 6907 migrated: ' + migrated.manga[0].source);

  /* Ambiguous upstream value: Komikku lists 7151438547982231541 under both E-Hentai
     and ExHentai for pt-BR, and it matches neither computed id. Left alone on
     purpose \u2014 a wrong match is worse than a missed one (AGENTS.md §7). */
  const amb = (() => { const r = new PW(); r.msg(1, mkManga(7151438547982231541n, '/g/7/', 'Ambiguous', [], [])); return r.done(); })();
  const dz = await M.inspectBackup(await M.gzip(amb), 'amb.tachibk');
  const left = M.decodeBackup(await M.gunzip(await M.runMerge([dz], 'mihon', {}, log)));
  ok(String(left.manga[0].source) === '7151438547982231541', 'the ambiguous pt-BR id is passed through untouched: ' + left.manga[0].source);
}

/* ===========================================================================
 * 6. Per-target root filtering, on the merge path as well as the convert one.
 * ======================================================================== */
{
  const rootsFor = async target => {
    const a = await M.inspectBackup(await M.gzip(phone), 'phone.tachibk');
    const b = await M.inspectBackup(await M.gzip(anikkuBk), 'anikku.tachibk');
    const raw = await M.gunzip(await M.runMerge([a, b], target, {}, log));
    return [...new Set([...M.pbFields(raw)].map(x => x.f))].sort((x, y) => x - y).join(',');
  };
  ok(await rootsFor('mihon') === '1,2,101,104,106', 'merge -> Mihon: ' + await rootsFor('mihon'));
  ok(await rootsFor('yokai') === '1,2,101,104', 'merge -> Yokai has no 106: ' + await rootsFor('yokai'));
  ok(await rootsFor('neko') === '1,2', 'merge -> Neko keeps only manga + categories: ' + await rootsFor('neko'));
  ok(await rootsFor('aniyomi') === '1,2,101,104,500,501,502,503', 'merge -> Aniyomi: ' + await rootsFor('aniyomi'));
  ok(await rootsFor('anikku') === '3,4,103', 'merge -> Anikku: ' + await rootsFor('anikku'));
}

/* Anikku's current Backup marks isLegacy @Required, so the opt-in modern layout must
   write it or the file will not deserialize at all. */
{
  const b = await M.inspectBackup(await M.gzip(anikkuBk), 'anikku.tachibk');
  const raw = await M.gunzip(await M.runMerge([b], 'anikku', { anikkuModern: true }, log));
  const roots = [...new Set([...M.pbFields(raw)].map(x => x.f))].sort((x, y) => x - y);
  ok(roots.join(',') === '500,501,502,503', 'opt-in Anikku modern layout writes 500 + 501-506: ' + roots.join(','));
}

/* A single input is a valid merge — it is how you convert while normalising
   categories and re-deriving ids. */
{
  const a = await M.inspectBackup(await M.gzip(phone), 'phone.tachibk');
  const out = M.decodeBackup(await M.gunzip(await M.runMerge([a], 'mihon', {}, log)));
  ok(out.manga.length === 2 && out.categories.length === 2, 'merging a single backup is a no-op pass through');
}

/* ===========================================================================
 * Slug urls must not collapse into one entry.
 *
 * Reported from real use: Anikku + Komikku into Animetail lost most of the library —
 * 216 anime came out as 63. The loose match tier normalised urls with an
 * unconditional `^[^/]*` host strip, which only strips a host on a string that
 * contains a `/`. Sources that store an opaque id or slug — AllAnime's
 * `<id><&sep><&sep><slug>`, a bare `115`, `65543-mutiny` — normalised to the empty
 * string, so every entry from such a source shared the key `<source>~` and merged
 * into the first one. Nothing about these entries is a duplicate.
 * ======================================================================== */
{
  logs.length = 0;
  const slugs = ['CoDCuQcqrKk7eWQDc<&sep><&sep>hitoribocchi', '115', '68', '65543-mutiny',
                 '278-1917', 'remnants-of-gold', 'series/one-piece', 'anime.site.example/x/y'];
  const one = (() => {
    const r = new PW();
    slugs.forEach((u, i) => r.msg(1, mkManga(md, u, 'Series ' + i, [], [chap('/e/1', 'Ep 1', 1, false, 0)])));
    r.msg(101, src('MangaDex', md));
    return r.done();
  })();
  const a = await M.inspectBackup(await M.gzip(one), 'slugs.tachibk');
  const out = M.decodeBackup(await M.gunzip(await M.runMerge([a, a], 'mihon', {}, cap)));
  ok(out.manga.length === slugs.length,
    `slug-only urls stay distinct: ${out.manga.length} of ${slugs.length}`);
  ok(!logs.some(l => l.includes('matched on a normalised url')),
    'and none of them matched on the loose url tier');

  /* The host strip still has to work, which is the whole reason the tier exists:
     an absolute url and the relative one for the same entry are one manga. */
  const abs = (() => {
    const r = new PW();
    r.msg(1, mkManga(md, 'https://mangadex.org/manga/a/', 'Shared Series', [], []));
    r.msg(101, src('MangaDex', md));
    return r.done();
  })();
  const rel = (() => {
    const r = new PW();
    r.msg(1, mkManga(md, '/manga/a', 'Shared Series', [], []));
    r.msg(101, src('MangaDex', md));
    return r.done();
  })();
  const m2 = M.decodeBackup(await M.gunzip(await M.runMerge([
    await M.inspectBackup(await M.gzip(abs), 'abs.tachibk'),
    await M.inspectBackup(await M.gzip(rel), 'rel.tachibk'),
  ], 'mihon', {}, log)));
  ok(m2.manga.length === 1, 'an absolute url still matches the relative one: ' + m2.manga.length);

  /* Entries with no url at all are not evidence of a match either. */
  const blank = (() => {
    const r = new PW();
    r.msg(1, mkManga(md, '', 'First', [], []));
    r.msg(101, src('MangaDex', md));
    return r.done();
  })();
  const blank2 = (() => {
    const r = new PW();
    r.msg(1, mkManga(md, '', 'Second', [], []));
    r.msg(101, src('MangaDex', md));
    return r.done();
  })();
  const m3 = M.decodeBackup(await M.gunzip(await M.runMerge([
    await M.inspectBackup(await M.gzip(blank), 'b1.tachibk'),
    await M.inspectBackup(await M.gzip(blank2), 'b2.tachibk'),
  ], 'mihon', {}, log)));
  ok(m3.manga.length === 1, 'blank urls still collapse on the exact tier, not the loose one: ' + m3.manga.length);
}

console.log(fail ? `\n${fail} FAILURES` : '\nmerge engine verified');
process.exit(fail ? 1 : 0);
