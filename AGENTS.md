# AGENTS.md

Working notes for this repo. Written for someone — human or agent — picking it up with no prior context.

Read this before changing anything in `public/index.html`. Several things here are counter-intuitive and were learned by getting them wrong first.

---

## 1. What this is

One static HTML file that converts manga/anime backups between three app families, entirely client-side. No build step, no runtime dependencies, no server. `wrangler deploy` puts it on Cloudflare.

The file is assembled from three sources kept in the repo for development:

```
tools/data.js       generated  — embedded lookup tables (~43 KB)
tools/core.js       hand-written — conversion engine, no DOM access
tools/template.html hand-written — markup, CSS, UI wiring; has two placeholders
        ↓ bun tools/build.ts
public/index.html   the deployable artifact (~116 KB, ~38 KB gzipped)
```

`build.ts` and `lib.ts` locate the repo root by walking **up from their own file**
until they find `tools/template.html`. Do not reintroduce `new URL("../", import.meta.url)`
— that assumes the script sits exactly one level below the root, and it broke a
Cloudflare build when `build.ts` was invoked from the repo root instead of `tools/`.
The build must work from any working directory and from any depth.

Tooling is Bun (`tools/*.ts`), with no runtime dependencies — the ZIP reader and table
extraction are hand-rolled in `tools/lib.ts`. `bun run build` substitutes `/*__DATA__*/` and `/*__CORE__*/` in the template. **Edit the sources, never `index.html` directly** — the next build overwrites it.

The split exists so `core.js` can be imported into Node for testing without a DOM. Keep DOM access out of `core.js`.

The page has two modes. **Convert** takes one backup between two named apps. **Merge**
takes any number of backups from any number of devices, in any mix of formats, and
produces one file for a chosen target — see §10, which is where the sharp edges are.

## 1a. Read this before changing the model

`AGENTS.md` is written in an order that no longer matches the code's risk profile. The
conversion routes filter bytes and therefore keep fields they have never heard of. The
merge engine **rebuilds** entries from a decoded model, so every field the decoder does
not know about is a field the user loses. `decodeManga`/`decodeChapter`/`decodeCategory`
keep unrecognised fields as raw slices in `_raw` and the encoders re-emit them; do not
"simplify" that away. `tests/merge.mjs` opens with a decode → encode round trip over
every field Mihon declares plus invented fork numbers, and nothing else in that suite
is worth trusting if it fails.

## 2. The rule that matters most

**Never assume two forks share a field number. Go read their `Backup.kt`.**

Every serious bug in this project came from assuming uniformity across forks. The root `Backup` message differs per app, and the same number can carry a *different message type*:

| App | Root manga fields |
|---|---|
| Mihon | 1, 2, 101, 104, 105, 106 |
| Komikku | 1, 2, 101, 104, 105, 106, 600, 610 |
| TachiyomiSY | 1, 2, 101, 104, 105, 106, 600 — no 610 |
| Yōkai / J2K | 1, 2, 101, 104, 105 — no 106 |
| Neko | 1, 2 — that's all |
| Aniyomi / Animetail | 1, 2, 101, 104, 105, 106 (+ anime at 5xx) |
| Anikku | none — anime only |

And the trap that motivated the `kinds` guard:

> Field **106** is `backupExtensionStores` in Mihon/Komikku/SY, `backupMangaExtensionRepo`
> (a `BackupExtensionRepos`) in current Aniyomi, and `backupExtensions` in Anikku and
> legacy Aniyomi. One number, three incompatible messages.

Field **107** repeats the trick inside the legacy anime layout: `backupAnimeExtensionStores`
(a `BackupExtensionStore`) in Aniyomi's `LegacyBackup`, but `backupExtensionRepo` (a
`BackupExtensionRepos`) in Anikku's. The two shapes are close enough to deserialize into
each other without an error and mean different things. This is why the merge engine never
carries 106 or 107 across and emits the Keiyoushi store fresh instead, for the three forks
whose shape is confirmed (`EXT_STORE_APPS`).

This is why `convertTachiManga` filters against **`APPS[target].root`**, a per-app whitelist — not a shared constant and not a denylist. A denylist ("drop 500–599, pass the rest") looks more future-proof and is actively wrong here: it would have written 610 into TachiyomiSY and 106 into Yōkai.

The cost of the whitelist is that a genuinely new field in some future Mihon release gets dropped until someone updates the table. That is the correct trade — see §6 for the refresh procedure.

### Verify a fork's schema

```bash
P="app/src/main/java/eu/kanade/tachiyomi/data/backup/models/Backup.kt"
curl -sL "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/$P" \
  | grep -E "@ProtoNumber|data class"
```

Branches vary: Mihon and Neko use `main`; Komikku, SY, Yōkai, Anikku, and kotatsu-parsers use `master`. Aniyomi is `main` and declares **two** messages — `LegacyBackup` (anime at 3/4/103/107) and the current `Backup` (anime at 501–506).

### Field 500 `isLegacy`, and why `APPS.anikku.anime = 'low'` is a choice

Anikku is **not** legacy-only any more. Current Anikku declares both a `LegacyBackup`
(3/4/103/…) and a current `Backup` with anime at 501–506 and, critically:

```kotlin
@Required @ProtoNumber(500) val isLegacy: Boolean = false
```

Each app picks its deserializer from that field, and the two rules differ:

| App | `isLegacyBackup(bytes)` |
|---|---|
| Aniyomi | `isLegacy` (500, **defaults true**) `&& backupAnimeSources(103).isNotEmpty()` |
| Anikku | `isLegacy` (500, **defaults true**) alone |

Three consequences, all load-bearing:

- The tool writes Anikku in the low layout and omits 500, so `isLegacy` defaults to
  `true` and Anikku takes the legacy path. That is correct — but correct on a
  one-field margin, which is why it is written down here.
- Any **x5** output must write `500 = false`. Anikku marks the field `@Required`, so an
  x5 file without it throws `SerializationException` and the user sees nothing but
  "invalid backup file". `buildMergedTachi` writes it; `tests/merge.mjs` asserts it.
- A file that mixed the layouts — anime at 501 alongside sources at 103 — would make
  Aniyomi decode a current backup with the *legacy* serializer: garbage, silently, rather
  than a rejection. `verifyTachiRoots()` asserts on every merge that the output carries
  exactly one layout, and the merge path must never lose that check.

`ANIME_LAYOUT` keeps Anikku on `low` because that is what ships today and what the whole
existing route matrix is tested against. `opts.anikkuModern` switches the merge output to
x5 with `500 = false` for whenever that stops being true; it is deliberately not exposed
in the UI.

### BackupAnime fields ≥ 500 are not fork noise

```
500 backgroundUrl   502 parentId   503 id   504 seasonFlags   505 seasonNumber
506 seasonSourceOrder   507 fetchType
```

502 and 503 are **season linkage** — `id` associates a season with its `parentId`. So
`stripHighFields(val, 500)` on an Aniyomi → Anikku conversion destroys the season
hierarchy, and 503 being a device-local row id is why the merge engine renumbers them
(§10). Both paths now say so in the log rather than dropping it quietly.

## 3. How source matching works

This is the part with real subtlety, and the part most likely to need attention later.

### The problem

Mihon and Kotatsu identify sources completely differently:

- **Mihon** uses a numeric ID: `md5("<name.lowercase()>/<lang>/<versionId>")`, first 8 bytes big-endian into an int64, sign bit cleared. Implemented as `mihonSourceId()`.
- **Kotatsu** uses a string parser name from an enum: `MANGADEX`, `TOONILY`, …

There is no formula between them. It's a lookup problem, and only a minority of sources exist in both ecosystems at all.

### Mihon → Kotatsu, in priority order

`resolveKotatsuParser()` tries:

1. **Curated map** — `CURATED_M2K`, 60 pairs inherited from `mk-bkconv`. Highest confidence, hand-checked.
2. **Name match** — normalise (lowercase, strip non-alphanumerics) the Mihon source name from the backup's own `backupSources`, match against Kotatsu parser names and titles. Works fully offline. Carries most of the load.
3. **Domain match** — needs the Keiyoushi index: source ID → `baseUrl` → host → Kotatsu parser domain. Only fires when the network fetch is enabled.

No match means the manga is skipped and its source is named in the log. That's deliberate: emitting a made-up parser name produces entries that restore but silently fail to load.

### Kotatsu → Mihon

Runs the same idea backwards in `resolveMihon()`: curated map → Keiyoushi lookup by name → parser domain → Keiyoushi lookup by host. Falls back to computing an ID from the curated name (flagged `weak` in the log), or skips entirely unless "keep unmatched" is ticked.

### Measured coverage

Against 2,018 Keiyoushi sources and 1,256 Kotatsu parsers:

| | Sources |
|---|---|
| Match by name (offline) | 625 |
| Additional matches by domain (needs fetch) | 104 |
| No Kotatsu equivalent exists | 1,289 |

That last row is an ecosystem fact, not a defect. Don't "fix" it by loosening the matcher — false matches are worse than skips. Regenerate the coverage numbers with `tools/coverage.py` after any table refresh and update the README if they move.

### The language trap

**Many sources publish one entry per language.** MangaDex alone has 60, all sharing name `MangaDex` and host `mangadex.org`, each with a different ID. A naive "first match wins" map picks whichever the index happens to list first — Afrikaans, in practice — and stamps every entry with the wrong source ID.

So `loadKeiyoushi()` stores **arrays** per key, and `pickLang(list, prefLang)` resolves them: caller's language → its base tag → `all` → `en` → first. Never take `[0]` from those maps.

Regression check: `mihonSourceId('MangaDex','en',1)` must equal `2499283573021220255`.

## 4. Numeric hazards

Two ways to silently corrupt a conversion. Both are covered by tests; don't undo them.

**int64 through JSON.** Kotatsu manga IDs come from a wrapping 31× rolling hash and routinely exceed `Number.MAX_SAFE_INTEGER`. `JSON.stringify`/`JSON.parse` round them, which unlinks every entry from its own history. Use `jsonDump()` (BigInt-aware serialiser) and `jsonParseBig()` (quotes bare integers ≥16 digits before parsing). Never plain `JSON.stringify` on Kotatsu structures.

**Negative varints.** A negative int64 must encode as 10-byte two's complement. `PW.vint()` handles it via `BigInt.asUintN(64, v)`. Don't "simplify" that.

Kotatsu's ID hash, for reference:

```js
id = 1125899906842597n
for (const ch of sourceName + url) id = BigInt.asIntN(64, id * 31n + BigInt(ch.codePointAt(0)))
```

Iterate with `for…of` (code points), not `for(i…)` (UTF-16 units) — they differ for non-BMP characters and Rust's `.chars()` matches the former.

## 5. Testing

```bash
bun install        # jsdom, for the three DOM suites only
bun tools/test.ts  # builds, then runs everything — no shell dependency
```

`tools/test.ts` replaced an earlier `run-tests.sh`. Keep it a pure Bun script —
no `Bun.$`, no shelling out to anything but the `bun`/`node` binaries themselves —
so it runs the same on Windows as on Linux/macOS.

**HTMLRewriter is not a DOM.** It's a streaming HTML transformer: element and text
callbacks, no tree, no event loop, and it never executes `<script>`. It cannot stand in
for jsdom, because the DOM suites test that the UI wiring *runs* — selects populating,
clicks flipping the route, a full select→convert→download pass. `domcheck.ts` uses it for
what it is good at: statically confirming that every id the script reaches for exists in
the markup, that no id is dead, that `.value` is only read from form controls, and that
the build substituted its placeholders. Zero dependencies, runs on Bun, and it catches id
typos that would otherwise only show up as a runtime `null` in the browser.

**Why the runner uses two runtimes.** The logic suites run on Bun. The DOM suites
(`guard`, `uitest`, `e2e`) need Node, because jsdom's `runScripts: 'dangerously'`
evaluates via `vm.runInContext` with a Proxy-based global and Bun rejects that
(`Proxy is not allowed in the global prototype chain`). happy-dom was evaluated as a
Bun-native replacement and does not execute inline `<script>` content injected through
`document.write`, so it can't test this page. If Bun's `vm` gains Proxy-global support,
move all seven to Bun and delete the split in `tools/test.ts`.

| Suite | Covers |
|---|---|
| `test` | md5, source IDs, Kotatsu hash, zip round-trip, BigInt JSON |
| `test2` | all five routes against a synthetic backup |
| `test3` | name matching, live Keiyoushi resolution, error handling |
| `guard` | kind validation, anime field remapping |
| `uitest` | jsdom DOM wiring, option visibility, mapping table |
| `e2e` | full click-through: select file → convert → download |
| `rootcheck` | per-target root filtering for every Mihon-family app |
| `categories` | category order/id bug regression — see below |
| `domcheck` | static: markup and script agree on ids, build integrity |
| `merge` | decode/encode round-trip fidelity, dedup, season renumbering, per-target roots |
| `mergeui` | jsdom: mode switch, multi-file add, priority reorder, full merge click-through |

Every suite builds its own module from `public/index.html`, so they test **the shipped artifact** and can run in any order. Don't reintroduce a shared temp module — an earlier version had suites clobbering each other's exports.

### Two failure modes that bit us

**Tests passing vacuously.** A `ReferenceError` in `refresh()` killed the function partway, *after* it set the element a test inspected. The test read a stale-but-correct value and went green on broken code. `guard.mjs` now registers a `window.onerror` handler that fails the run. Keep it, and add the same to any new jsdom suite.

**Stale assertions.** Three times, a "failure" was a test asserting old behaviour after a deliberate change. Each time the right move was editing the test — but confirm the *product* is correct first. "I changed the test until it passed" is the standard way to ship a bug.

## 6. Refreshing the data tables

### Kotatsu parsers — manual, roughly annually

`KP_TABLE` is a snapshot of 1,256 parsers. Kotatsu itself is shut down (its maintainers cited Kakao Entertainment legal threats and Google's sideloading policy), so upstream is largely static; drift will come mainly from Usagi adding parsers.

```bash
bun run refresh    # downloads the repo zip, regenerates tools/data.js
bun run test       # build + full suite
bun run coverage   # re-measure match rates
```

`refresh-parsers.ts` refuses to write if the parser count drops more than 2%, or if
`MANGADEX → mangadex.org` stops resolving — both indicate upstream restructured or an
extraction regex broke.

**A JS/Python difference that bit us during the port:** JavaScript's `\w` is ASCII-only,
while Python's is Unicode-aware. Six parsers have non-Latin titles (`Хентай-тян`,
`Ổ Truyện`, `สดใสเมะ`, …) and were silently dropped until the title class was switched to
`[\p{L}\p{N}…]` with the `u` flag. If you touch these regexes, check the count is still
1,256 — that's exactly what the 2% guard is for.

The script extracts `@MangaSourceParser("NAME", "Title", "locale")` annotations and `ConfigKey.Domain(...)` declarations. Locale extraction is unreliable (it sometimes captures `ContentType` fragments) — it's unused, so don't chase it.

### Keiyoushi index — automatic

Fetched at runtime from `keiyoushi/extensions@repo/index.min.json` (~460 KB, CORS-enabled), so new Mihon sources start matching with no code change. If it 404s the tool degrades to offline matching with a warning — check `KEIYOUSHI_URL` first if match rates suddenly collapse.

### App schemas — manual, when a fork ships a backup change

Re-run the §2 command for each app and reconcile `APPS[*].root`. Symptom that this is overdue: users reporting a setting that doesn't survive a same-family conversion.

## 7. Things deliberately not done

Don't implement these without a reason; each was considered and rejected.

- **Per-parser URL correction.** `nekotatsu` maintains Lua scripts fixing URL shapes per source. Real value, large ongoing maintenance burden. We accept that a minority of entries need in-app migration.
- **Chapter reconstruction from Kotatsu.** Kotatsu backups store no chapter lists. Nothing to reconstruct from; the log tells users to refresh.
- **Fuzzy/substring source matching.** Tempting for the 1,289 unmatched, but a wrong source is worse than a skipped one.
- **Bundling the Keiyoushi index.** 460 KB embedded, stale immediately, and the runtime fetch already degrades gracefully.

## 8. Categories link by order, not id — a bug that shipped and got fixed

`BackupManga.categories` (field 17) is `List<Long>`. It is tempting to assume those
longs are `BackupCategory.id` — they are not. Confirmed straight from Mihon's own
restorer:

```kotlin
// CategoriesRestorer.kt — the backup's category id is never used for anything
val order = nextOrder++
database.categoriesQueries.insert(it.name, order, it.flags)   // fresh local id assigned here
    .let { id -> it.toCategory(id).copy(order = order) }

// MangaRestorer.kt — manga are linked by ORDER, not id
val backupCategoriesByOrder = backupCategories.associateBy { it.order }
categories.mapNotNull { backupCategoryOrder ->
    backupCategoriesByOrder[backupCategoryOrder]?.let { ... dbCategoriesByName[it.name] ... }
}
```

`id` is written to the backup and then completely ignored on restore. Categories are
re-created by **name**, given a fresh local id, and manga are re-attached by matching
field 17 against `order` — the category's position in the backup's own category list.

Both `convertToKotatsu` and `convertFromKotatsu` originally joined on `id`. This is
invisible on any backup where categories were never reordered, because a freshly
created, never-reordered list has `id == order` by coincidence — every synthetic test
fixture up to that point had this property too, so the bug shipped with the test suite
apparently green. It surfaces the moment a real user drags a category to a new
position: `id` stays fixed, `order` changes, and every manga in that category gets
silently reassigned to whichever category the *stale* id now collides with. Reported
symptom: manga stayed grouped together (they all carried the same, now-wrong,
identifier) but the whole group showed up under a different, unrelated category name —
exactly what "join on the wrong key" produces, and indistinguishable from random
corruption without knowing the mechanism.

Fixed in both directions by using **array position** as the join key — sorted by
`order`/`sort_key` for a sensible default ordering, but the actual linkage no longer
depends on the source data's `id` or `sort_key` being unique or gap-free.

**`tests/categories.mjs` exists because of this bug specifically**, and every fixture
in it is deliberately constructed so `id` and `order` disagree in a way that collides
with a *different real category* — not just a dangling reference — because a dangling
reference would have failed loudly (or been silently dropped) rather than reproducing
the actual reported behavior. Before trusting a new regression test here, revert the
fix and confirm the test fails for the *right reason* — a first attempt at this test
used fixtures where `id` and `order` accidentally coincided for the category being
checked, which meant the test passed against both the buggy and fixed code and proved
nothing. If you add a category-related fixture anywhere in this repo, default to
`id != order`; equal values silently return this class of bug to being invisible.

## 9. Provenance and licensing

Format and algorithm knowledge came from `galpt/mk-bkconv` (MIT) and `PhantomShift/nekotatsu` (GPL-3.0); the parser table is extracted from `KotatsuApp/kotatsu-parsers` (Apache-2.0). No code was copied from nekotatsu, but the derivation is real — worth your own look before changing the repo's license. Full credits in `README.md` and on the page itself.

Two corrections to `mk-bkconv` worth knowing, since it's the closest reference and it's wrong in both places:

- Its hardcoded `lang` values are frequently incorrect — it has MangaDex as `all`, yielding `6404943692147160087` instead of the real `2499283573021220255`. The *algorithm* is right; validated at 1,795/2,018 exact matches, the remainder being sources with `versionId != 1`. Prefer real IDs from the backup or the Keiyoushi index over recomputing from a name.
- Its field 106 shape (`BackupExtensionRepos`) predates Mihon's current `BackupExtensionStore`. We write the current shape with `isLegacy = true`, which is the one item here inferred rather than confirmed against a real restore — **verify it if you touch that path.**

## 10. The merge engine

`runMerge(inputs, target, opts, log)` takes any number of `inspectBackup()` results and
writes one file. Inputs are identified from their bytes, not from a dropdown: ZIP means
Kotatsu, gzip/protobuf gets its anime layout sniffed by `detectAnimeLayout`. The same
target matrix as conversion applies — Aniyomi and Animetail get a hybrid manga+anime
file, Mihon-family targets get manga, Anikku gets anime, Kotatsu gets a zip.

### Priority is list order, and it only decides conflicts

The first file wins metadata ties. Everything that can be unioned *is* unioned, in both
directions, so no device's progress is lost to another's: `read = a || b`,
`lastPageRead = max`, `bookmark = a || b`, `readDuration = sum`, category membership is a
set union, `dateAdded = min`, `lastModifiedAt = max`. This is why the UI has explicit
↑/↓ buttons rather than an implicit "newest device wins" — a rule the user can see beats
one inferred from timestamps they cannot.

### Four things that are easy to get wrong here

**Category membership travels as names, never indices.** Field 17 holds each category's
*order* — its position in that backup's own list — so the same integer means different
things in different files. Entries are resolved to names on the way in and back to fresh
positions on the way out. This is §8 all over again, with N files instead of one.

**Season ids are device-local.** `BackupAnime.id` (503) and `parentId` (502) are row ids.
Union two devices and device B's `id = 1` collides with device A's, silently re-parenting
a season under the wrong show — §8 in anime form. `renumberSeasons()` assigns every id
from scratch and drops a parent link whose target did not survive the merge rather than
leaving it pointing at whatever now holds that number. `tests/merge.mjs` has a fixture
where both devices number from 1.

**`sourceOrder` is the source site's listing order, not a sort key.** Most sites list
newest first, so recomputing it from chapter numbers inverts the library. Chapters only
one device knew about are appended past the highest existing `sourceOrder`, and the log
tells the user an in-app refresh restores the real ordering. Do not "fix" this by
sorting.

**Kotatsu has no chapters.** `mergeChapters` returns early on an empty incoming list and
never assigns over a populated one — the regression test for this asserts a Mihon entry
keeps its chapters after a Kotatsu entry merges into it. Kotatsu entries also carry
`_derivedSource`, because their Mihon source id was *computed* rather than read; that
flag is the only thing that unlocks the title-matching fallback, and it must stay that
way. Matching on title across sources merges unrelated series.

### Matching tiers

Exact `(source, url)`, then `(source, normalisedUrl)`, then — only for `_derivedSource`
entries — `(source, normalisedTitle)`. Each tier is counted and the last one is logged as
a warning. Cross-family dedup is genuinely best-effort: a Kotatsu url shape need not match
the Mihon one for the same site (§7 explains why per-parser url correction was rejected),
and a weakly resolved source id may not match the real one at all.

### What a merge does not carry

Preferences (104/105) come from the highest-priority input that has them; they are opaque
key/value blobs with no merge semantics, and the log names both the file they came from
and how many were discarded. Extension repo lists (106/107) are never carried — see §2.
Saved searches (600) and feeds (610) are dropped. Kotatsu → Kotatsu skips the Mihon-shaped
model entirely (`mergeKotatsuSections`) because that model has no room for tags, rating,
nsfw, alt_title or a bookmark's scroll/percent.
