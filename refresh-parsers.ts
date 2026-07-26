#!/usr/bin/env bun
/** Regenerate tools/data.js from the kotatsu-parsers repo. See AGENTS.md section 6. */
import { root, loadTables, unzip, download } from "./lib.ts";

const URL_ZIP = "https://codeload.github.com/KotatsuApp/kotatsu-parsers/zip/refs/heads/master";

// NOTE: JS \w is ASCII-only (Python's is Unicode-aware). Titles include Cyrillic,
// Vietnamese and Thai, so the title class must use Unicode property escapes.
const PARSER = /@MangaSourceParser\(.(?<name>\w*)., .(?<title>[\p{L}\p{N}_\s().'!&-]+)./gu;
const DOM_MULTI = /ConfigKey\.Domain\((?<domains>.+?)\)/s;
const DOM_ALT = [
  /\w+\(\s*context,\s*\w+Source\.\w+,\s*"(?<domain>[\w.\-/]+)"/,
  /\(\s*context,\s*MangaSource\.\w+,\s*.(?<domain>[\w.\-/]+)./,
  /\w+\(\s*context = context,\s*source = \w+.\w+,\s*(?:siteId = \d+,\s*)?(?:site)?Domain = "(?<domain>[\w.\-/]+)"/i,
];

const files = await unzip(await download(URL_ZIP, "kotatsu-parsers"));
const td = new TextDecoder();
const parsers = new Map<string, { title: string; domains: string[] }>();

for (const [path, bytes] of files) {
  if (!path.endsWith(".kt") || !path.includes("/parsers/site/")) continue;
  const src = td.decode(bytes);
  const caps = [...src.matchAll(PARSER)];
  if (!caps.length) continue;

  let domains: string[] = [];
  const multi = DOM_MULTI.exec(src);
  if (multi?.groups?.domains) {
    domains = multi.groups.domains.split(",").map(d => d.replace(/"/g, "").trim()).filter(d => d.includes("."));
  }
  if (!domains.length) {
    for (const rx of DOM_ALT) {
      const hit = rx.exec(src);
      if (hit?.groups?.domain) { domains = [hit.groups.domain]; break; }
    }
  }
  for (const c of caps) {
    const name = c.groups?.name;
    if (name) parsers.set(name, { title: (c.groups?.title ?? "").trim(), domains: domains.slice(0, 3) });
  }
}

if (parsers.size < 900) {
  console.error(`ERROR: only ${parsers.size} parsers found — extraction regexes likely stale, refusing to write.`);
  process.exit(1);
}
if (!parsers.get("MANGADEX")?.domains.includes("mangadex.org")) {
  console.error("ERROR: MANGADEX sanity check failed — refusing to write.");
  process.exit(1);
}

const rows = [...parsers.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([n, { title, domains }]) => `${n}|${title.toUpperCase() === n ? "" : title}|${domains.join(",")}`);

const { KP_TABLE: prev, CURATED_K2M, CURATED_M2K } = await loadTables();
const before = prev.split(";").length;
if (parsers.size < before * 0.98) {
  console.error(`ERROR: parser count fell from ${before} to ${parsers.size} (>2%). ` +
    `Upstream restructured, or an extraction regex broke. Refusing to write.`);
  const old = new Set(prev.split(";").map(r => r.split("|")[0]));
  const lost = [...old].filter(n => !parsers.has(n)).slice(0, 12);
  console.error(`  no longer matched: ${lost.join(", ")}`);
  process.exit(1);
}
await Bun.write(new URL("tools/data.js", root),
  `const KP_TABLE = ${JSON.stringify(rows.join(";"))};\n` +
  `const CURATED_K2M = ${JSON.stringify(CURATED_K2M)};\n` +
  `const CURATED_M2K = ${JSON.stringify(CURATED_M2K)};\n`);

console.log(`wrote tools/data.js — ${rows.length.toLocaleString()} parsers (was ${before.toLocaleString()})`);
console.log("next: bun tools/build.ts && ./run-tests.sh && bun tools/coverage.ts");
