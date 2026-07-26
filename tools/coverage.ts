#!/usr/bin/env bun
/** Re-measure Mihon <-> Kotatsu source match rates. See AGENTS.md section 3. */
import { loadTables, norm, host, download } from "./lib.ts";

const KEI = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json";

const { KP_TABLE } = await loadTables();
const byName = new Map<string, string>(), byTitle = new Map<string, string>(), byDom = new Map<string, string>();
for (const row of KP_TABLE.split(";")) {
  const [name, title, doms] = row.split("|");
  if (!byName.has(norm(name))) byName.set(norm(name), name);
  if (title && !byTitle.has(norm(title))) byTitle.set(norm(title), name);
  for (const d of doms.split(",").filter(Boolean)) {
    const h = d.replace(/^www\./, "");
    if (!byDom.has(h)) byDom.set(h, name);
  }
}

type Ext = { sources?: { name: string; lang: string; id: string; baseUrl?: string }[] };
const kei: Ext[] = JSON.parse(new TextDecoder().decode(await download(KEI, "keiyoushi index")));

let total = 0, byNameHits = 0, byDomHits = 0;
for (const ext of kei) for (const s of ext.sources ?? []) {
  total++;
  const k = norm(s.name);
  if (byTitle.has(k) || byName.has(k)) byNameHits++;
  else if (byDom.has(host(s.baseUrl ?? ""))) byDomHits++;
}

const pad = (n: number) => n.toLocaleString().padStart(6);
console.log(`\nKotatsu parsers : ${pad(KP_TABLE.split(";").length)}`);
console.log(`Mihon sources   : ${pad(total)}`);
console.log(`  by name       : ${pad(byNameHits)}   (offline)`);
console.log(`  by domain     : ${pad(byDomHits)}   (needs the Keiyoushi fetch)`);
console.log(`  unmatched     : ${pad(total - byNameHits - byDomHits)}\n`);
