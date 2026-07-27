import fs from 'fs';
const ROOT = new URL('../', import.meta.url).pathname;
const core = [...fs.readFileSync(ROOT + 'public/index.html', 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
fs.writeFileSync('/tmp/cat-mod.mjs', core + '\nexport {runConversion,PW,gzip,gunzip,zipRead,zipWrite,jsonDump,jsonParseBig,mihonSourceId,decodeBackup};');
const M = await import('/tmp/cat-mod.mjs?v=' + Date.now());
const TD = new TextDecoder();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : 'FAIL  ') + m); if (!c) fail++; };
const log = () => {};
const { PW, mihonSourceId } = M;

/*
 * Mihon's CategoriesRestorer discards BackupCategory.id on restore and matches
 * BackupManga.categories (field 17) against BackupCategory.order instead. id and
 * order only coincide for a category list that was never reordered — the bug this
 * suite targets only shows up once they diverge, e.g. after a user drags a category
 * to a new position (order changes, id — assigned once at creation — does not).
 *
 * Every fixture below deliberately sets id != order to make sure the fix is judged
 * on the real failure mode, not on data where the bug would stay invisible.
 */

// ---------------------------------------------------------------------------
// 1. Mihon -> Kotatsu: category "Action" was created first (id=1) but dragged
//    to the second position (order=1). "RomCom" was created second (id=2) but
//    sits first (order=0). A manga tagged into "Action" must land in the
//    Kotatsu category actually titled "Action" — not whichever one has id=1.
// ---------------------------------------------------------------------------
{
  const mdId = mihonSourceId('MangaDex', 'en', 1);
  const root = new PW();
  const m = new PW();
  m.vint(1, mdId).str(2, '/manga/reordered').str(3, 'Reordered Manga').vint(13, 1700000000000n);
  m.vint(17, 1); // order=1 -> "Action", per the category list below
  m.bool(100, true);
  root.msg(1, m.done());

  // Chosen so the ORIGINAL bug (category_id = c.id + OFFSET, manga ref = field17 + OFFSET)
  // lands the manga in an EXISTING category — RomCom — not a dangling reference: with
  // id=1/2, buggy RomCom catId = 1+3=4 and buggy manga ref = field17(1)+3=4. Match.
  // That is precisely the reported shape: content silently reassigned to a real,
  // wrong category, not merely orphaned.
  const romcom = new PW(); romcom.str(1, 'RomCom').vint(2, 0).vint(3, 1); root.msg(2, romcom.done()); // order=0, id=1
  const action = new PW(); action.str(1, 'Action').vint(2, 1).vint(3, 2); root.msg(2, action.done()); // order=1, id=2
  const src = new PW(); src.str(1, 'MangaDex').vint(2, mdId); root.msg(101, src.done());

  const bk = await M.gzip(root.done());
  const out = await M.runConversion(bk, 'mihon', 'kotatsu', 'manga', { useKeiyoushi: false, libraryName: 'Library' }, log);
  const z = await M.zipRead(out);
  const fav = M.jsonParseBig(TD.decode(z.find(e => e.name === 'favourites').data));
  const cat = M.jsonParseBig(TD.decode(z.find(e => e.name === 'categories').data));

  const actionCat = cat.find(c => c.title === 'Action');
  const romcomCat = cat.find(c => c.title === 'RomCom');
  ok(!!actionCat && !!romcomCat, 'both categories present in Kotatsu output');
  const actionId = actionCat && String(actionCat.category_id);
  const inAction = fav.filter(f => String(f.category_id) === actionId).map(f => f.manga.title);
  const inRomcom = fav.filter(f => String(f.category_id) === String(romcomCat.category_id)).map(f => f.manga.title);
  ok(inAction.includes('Reordered Manga'), `manga lands in Action (order-based): got [${inAction}]`);
  ok(!inRomcom.includes('Reordered Manga'), `manga does NOT leak into RomCom (the id=1 category): got [${inRomcom}]`);
}

// ---------------------------------------------------------------------------
// 2. Kotatsu -> Mihon, decoded back with this tool's own reader: two Kotatsu
//    categories whose sort_key ordering does not match their category_id
//    ordering. The manga must end up under the category it actually belongs
//    to once Mihon resolves field 17 against order.
// ---------------------------------------------------------------------------
{
  const favourites = [
    { manga_id: 111n, category_id: 50n, sort_key: 0, created_at: 0, deleted_at: 0,
      manga: { id: 111n, title: 'Kotatsu Manga', url: '/m/1', public_url: 'https://mangadex.org/m/1',
        cover_url: '', state: '', author: '', source: 'MANGADEX', tags: [] } },
  ];
  // sort_key says Horror comes first (0) then SliceOfLife (1); category_id numbering
  // disagrees (50 vs 20). The manga belongs to category_id=50 (SliceOfLife).
  const categories = [
    { category_id: 50n, sort_key: 1, title: 'SliceOfLife', created_at: 0, deleted_at: 0 },
    { category_id: 20n, sort_key: 0, title: 'Horror', created_at: 0, deleted_at: 0 },
  ];
  const files = [
    { name: 'favourites', data: new TextEncoder().encode(M.jsonDump(favourites)) },
    { name: 'categories', data: new TextEncoder().encode(M.jsonDump(categories)) },
    { name: 'index', data: new TextEncoder().encode(M.jsonDump([{ app_id: 'test', app_version: 1, created_at: 0 }])) },
  ];
  const zip = await M.zipWrite(files);
  const out = await M.runConversion(zip, 'kotatsu', 'mihon', 'manga', { useKeiyoushi: false }, log);
  const bk = M.decodeBackup(await M.gunzip(out));

  const sliceCat = bk.categories.find(c => c.name === 'SliceOfLife');
  const horrorCat = bk.categories.find(c => c.name === 'Horror');
  ok(!!sliceCat && !!horrorCat, 'both categories decoded from Mihon output: ' + bk.categories.map(c => c.name).join(','));
  ok(horrorCat.order === 0 && sliceCat.order === 1, `order follows sort_key (Horror=0, SliceOfLife=1): got Horror=${horrorCat.order} SliceOfLife=${sliceCat.order}`);
  const manga = bk.manga.find(m => m.title === 'Kotatsu Manga');
  ok(!!manga, 'manga decoded');
  ok(manga.categories.includes(sliceCat.order), `manga references SliceOfLife's order (${sliceCat.order}), not its category_id (50): got [${manga.categories}]`);
  ok(!manga.categories.includes(50), 'field 17 does not contain the raw Kotatsu category_id');
}

// ---------------------------------------------------------------------------
// 3. Round trip: Mihon (reordered categories) -> Kotatsu -> Mihon. The category
//    *name* a manga ends up under must survive the full trip even though every
//    numeric id changes twice along the way.
// ---------------------------------------------------------------------------
{
  const mdId = mihonSourceId('MangaDex', 'en', 1);
  const root = new PW();
  const m = new PW();
  m.vint(1, mdId).str(2, '/manga/roundtrip').str(3, 'Round Trip Manga').vint(13, 1700000000000n);
  m.vint(17, 1); // order=1 -> "Seinen" below
  m.bool(100, true);
  root.msg(1, m.done());
  // Same collision-with-a-real-category setup as case 1, carried through both hops.
  const shoujo = new PW(); shoujo.str(1, 'Shoujo').vint(2, 0).vint(3, 1); root.msg(2, shoujo.done()); // order=0, id=1
  const seinen = new PW(); seinen.str(1, 'Seinen').vint(2, 1).vint(3, 2); root.msg(2, seinen.done()); // order=1, id=2
  const src = new PW(); src.str(1, 'MangaDex').vint(2, mdId); root.msg(101, src.done());

  const bk1 = await M.gzip(root.done());
  const toKotatsu = await M.runConversion(bk1, 'mihon', 'kotatsu', 'manga', { useKeiyoushi: false, libraryName: 'Library' }, log);
  const backToMihon = await M.runConversion(toKotatsu, 'kotatsu', 'mihon', 'manga', { useKeiyoushi: false }, log);
  const final = M.decodeBackup(await M.gunzip(backToMihon));

  const seinenCat = final.categories.find(c => c.name === 'Seinen');
  ok(!!seinenCat, 'Seinen category survived the round trip: ' + final.categories.map(c => c.name).join(','));
  const manga = final.manga.find(m => m.title === 'Round Trip Manga');
  ok(!!manga, 'manga survived the round trip');
  ok(manga.categories.includes(seinenCat.order), `manga still in Seinen after Mihon->Kotatsu->Mihon: manga refs [${manga.categories}], Seinen order=${seinenCat.order}`);
}

console.log(fail ? `\n${fail} FAILURES` : '\ncategory order/id regression tests passed');
process.exit(fail ? 1 : 0);
