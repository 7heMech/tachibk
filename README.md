# tachibk converter

Convert manga and anime backups between the Mihon, Aniyomi and Kotatsu families of Android readers — entirely in the browser.

Live at **<https://tachibk.7he.dev>**

The whole tool is one static `index.html`. No build step, no dependencies, no server.

---

## Supported apps

| Family | Apps | Format |
|---|---|---|
| Mihon | Mihon, Komikku, TachiyomiSY, Yōkai / J2K, Neko | gzipped protobuf `.tachibk` |
| Aniyomi | Aniyomi, Animetail (manga + anime), Anikku (**anime only**) | gzipped protobuf `.tachibk` |
| Kotatsu | Kotatsu, Usagi | ZIP of JSON |

Usagi is a Kotatsu fork, so it shares Kotatsu's format — those two convert by straight passthrough.

## Routes

**Mihon family ↔ Mihon family (manga)** — Keeps exactly the root fields the *target* app declares, verified against each project's `Backup.kt`. These are not uniform:

| App | Root manga fields |
|---|---|
| Mihon | 1, 2, 101, 104, 105, 106 |
| Komikku | + 600 saved searches, 610 feeds |
| TachiyomiSY | + 600 saved searches (no 610) |
| Yōkai / J2K | 1, 2, 101, 104, 105 (no 106) |
| Neko | 1, 2 only |

Chapters, read state and history survive intact. Converting away from an Aniyomi fork also strips fork-only fields ≥500 nested inside manga and chapters.

**Aniyomi family → Aniyomi family (anime)** — Renumbers the anime blocks. The source layout is auto-detected rather than assumed. Aniyomi's current `Backup` uses the 5xx numbers; its `LegacyBackup` — and Anikku — use the low ones:

| | Aniyomi / Animetail | Anikku |
|---|---|---|
| `backupAnime` | 501 | 3 |
| `backupAnimeCategories` | 502 | 4 |
| `backupAnimeSources` | 503 | 103 |
| `backupAnimeExtensionRepo` | 505 | 107 |
| `backupExtensions` | 504 | 106 |
| `backupCustomButton` | 506 | 109 |

Anikku's root message has **no manga fields at all**, so pairs with nothing in common — Anikku → Mihon, say — are refused with an explanation rather than silently producing an empty backup. To split an Aniyomi or Animetail library across both apps, convert from that original backup twice: once as Manga, once as Anime.

Note that field 106 is `backupExtensionRepo` in Mihon but `backupExtensions` in Anikku and legacy Aniyomi — same number, different message. The kind guard is what keeps those from ever meeting.

**Mihon family → Kotatsu** — Rebuilds the library as Kotatsu `favourites`, `categories`, `history` and `bookmarks`. Manga IDs use Kotatsu's own hash so entries link up correctly.

**Kotatsu → Mihon family** — Rebuilds library, categories and reading position, and adds the Keiyoushi extension repo so extensions install without trust prompts.

## Source matching

The two ecosystems have completely separate source implementations, so entries only cross over when a counterpart exists on the other side. Matching runs in this order:

1. Curated name map (from `mk-bkconv`)
2. Mihon source name against Kotatsu parser names and titles — works offline
3. Website domain, via the Keiyoushi extension index — optional, needs one network request

Measured against the full Keiyoushi index (2,018 Mihon sources) and the bundled 1,256 Kotatsu parsers: **625 match by name, another 104 by domain, and 1,289 have no Kotatsu equivalent at all.** That last number is an ecosystem fact, not a bug — unmatched entries are listed in the log and skipped.

Many sources publish one entry per language (MangaDex alone has 60), so `Kotatsu → Mihon` has a preferred-language picker; it falls back to `all`, then English.

## Privacy

Your backup is read with `FileReader` and processed in memory. It is never uploaded.

The one optional network request is the public [Keiyoushi extension index](https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json) (~460 KB), fetched only when the "Use the Keiyoushi source index" box is ticked, and only for Kotatsu routes. It's a plain GET for a public file — nothing about your library is sent with it. Untick it to stay fully offline at the cost of some source matches.

## Known limitations

- **Kotatsu backups don't store chapter lists.** Anything imported from Kotatsu arrives with no chapters — refresh each entry once after restoring.
- **Per-chapter read state doesn't survive the trip to Kotatsu.** Kotatsu tracks a single reading position per manga, so the highest-numbered read chapter becomes that position. Bookmarked chapters do carry across.
- **Tracking (MyAnimeList, AniList, …) and source preferences are not carried** across ecosystems. They're preserved on Mihon ↔ Mihon routes.
- **Same-site sources can still differ in URL shape.** `nekotatsu` maintains per-parser correction scripts for this; this tool doesn't, so a minority of entries may need manual migration in-app.
- The anime route only knows the two field layouts documented above.

## Development

See **[AGENTS.md](AGENTS.md)** for architecture, how source matching works, how to refresh the bundled tables, and the failure modes worth knowing about before changing anything.

Tooling runs on [Bun](https://bun.sh); the build has no runtime dependencies.

```bash
bun install
bun run build      # tools/* -> public/index.html
bun run test       # builds, then runs all 8 suites — no shell script, works on Windows too
bun run coverage   # re-measure source match rates
```

## Deploying

Single file, so either Cloudflare option works. Put `index.html` in a `public/` directory.

`bun run deploy` runs the full test suite, then ships — it stops before deploying if anything fails.

### Building on Cloudflare

If you connect the repo to Cloudflare instead of deploying from your machine, the
build settings must be:

| Setting | Value |
|---|---|
| Build command | `bun tools/build.ts` |
| Build output directory | `public` |
| Root directory | *(leave empty — the repo root)* |

`public/index.html` is generated, so it is not committed. The build needs no
dependencies; `bun install` only pulls jsdom for the test suite.

If you would rather not build on Cloudflare at all, commit `public/index.html`,
drop it from `.gitignore`, and leave the build command empty — it is a single
static file with nothing to compile.

**Workers with static assets** — `wrangler.toml`:

```toml
name = "tachibk"
compatibility_date = "2026-07-26"
assets = { directory = "./public", not_found_handling = "single-page-application" }
```

Then `npx wrangler deploy`.

**Pages** — `npx wrangler pages deploy public`, or point Pages at the repo with an empty build command and `public` as the output directory.

Add `tachibk.7he.dev` as a custom domain in the dashboard either way.

### Browser requirements

Uses `CompressionStream`/`DecompressionStream` with `gzip` and `deflate-raw`. That means Chrome/Edge 103+, Firefox 113+, Safari 16.4+. ZIP writing falls back to stored (uncompressed) entries if `deflate-raw` is unavailable.

---

## Credits

This tool stands on work by several other projects. It reimplements their formats and algorithms in JavaScript rather than vendoring code, but the knowledge is entirely theirs.

**[galpt/mk-bkconv](https://github.com/galpt/mk-bkconv)** — MIT
The Mihon ⇄ Kotatsu conversion approach, the reconstructed Mihon backup `.proto` schema, the curated source-name map, and the idea of injecting the Keiyoushi repo so extensions auto-trust on restore.

**[PhantomShift/nekotatsu](https://github.com/PhantomShift/nekotatsu)** — GPL-3.0
By far the most complete Tachiyomi → Kotatsu converter. The exact shape of Kotatsu's backup JSON, its seeded 31× manga/chapter ID hash, the category ID offset, and the history/bookmark mapping rules all came from reading it.

**[KotatsuApp/kotatsu-parsers](https://github.com/KotatsuApp/kotatsu-parsers)** — Apache-2.0
Source of the bundled table of 1,256 parser names, titles and domains, extracted from the `@MangaSourceParser` annotations.

**[keiyoushi/extensions](https://github.com/keiyoushi/extensions)**
The public extension index used to resolve Mihon source IDs and base URLs.

**[Mihon](https://github.com/mihonapp/mihon)**, **[Aniyomi](https://github.com/aniyomiorg/aniyomi)**, **[Komikku](https://github.com/komikku-app/komikku)**, **[TachiyomiSY](https://github.com/jobobby04/TachiyomiSY)**, **[Kotatsu](https://github.com/KotatsuApp/Kotatsu)**, **[Usagi](https://github.com/UsagiApp/Usagi)**
The apps and formats being converted between. This project is not affiliated with, endorsed by, or supported by any of them — **please don't file issues about this tool on their trackers.**

The Animetail → Anikku protobuf scripts this tool grew out of are my own.

### A note on licensing

`mk-bkconv` is MIT and `kotatsu-parsers` is Apache-2.0, both permissive. `nekotatsu` is GPL-3.0 — no code was copied from it, only file-format and algorithm details, which generally aren't themselves copyrightable. Still worth a look of your own before settling on a license for this repo, since the derivation is real even if the code isn't shared.

## Disclaimer

For moving **your own** library data between readers you already use. It hosts no content and links to no content. Back up your original file before restoring anything — conversions between ecosystems are lossy by nature.
