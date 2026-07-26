#!/usr/bin/env bun
/**
 * Static structural checks on the built page, using HTMLRewriter.
 *
 * HTMLRewriter does NOT execute scripts and has no DOM — it cannot replace the
 * jsdom suites (guard/uitest/e2e), which test behaviour. What it does cheaply, on
 * Bun, with no dependencies, is verify that the markup and the script agree:
 * every id the JS reaches for exists, every id in the markup is used, and the
 * build actually substituted its placeholders.
 */
const root = new URL("../", import.meta.url);
const html = await Bun.file(new URL("public/index.html", root)).text();

let fail = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${msg}`);
  if (!cond) fail++;
};

/* ---- collect ids and tag names from the markup ---- */
const markup = new Map<string, string>(); // id -> tagName
const withDataKind = new Set<string>();
await new HTMLRewriter()
  .on("[id]", {
    element(e) {
      const id = e.getAttribute("id");
      if (id) markup.set(id, e.tagName.toLowerCase());
    },
  })
  .on("[data-kind]", {
    element(e) {
      const k = e.getAttribute("data-kind");
      if (k) withDataKind.add(k);
    },
  })
  .transform(new Response(html))
  .text();

/* ---- collect the ids the script reaches for ---- */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(blocks.length === 2, `two inline script blocks (found ${blocks.length})`);

const ui = blocks[1] ?? "";
const referenced = new Set<string>();
for (const m of ui.matchAll(/(?:\$\(|getElementById\()\s*['"]([\w-]+)['"]\s*\)/g)) {
  referenced.add(m[1]);
}
ok(referenced.size > 20, `script references ${referenced.size} ids`);

/* ---- the checks that matter ---- */
const missing = [...referenced].filter((id) => !markup.has(id));
ok(missing.length === 0, `every referenced id exists in the markup${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);

const unused = [...markup.keys()].filter((id) => !referenced.has(id));
ok(unused.length === 0, `every id in the markup is used${unused.length ? ` — unused: ${unused.join(", ")}` : ""}`);

/* elements the UI treats as form controls must actually be form controls */
const asValue = new Set<string>();
for (const m of ui.matchAll(/els\.(\w+)\.value/g)) asValue.add(m[1]);
const elsMap = new Map<string, string>();
for (const m of ui.matchAll(/(\w+):\s*\$\(['"]([\w-]+)['"]\)/g)) elsMap.set(m[1], m[2]);
const badControls = [...asValue]
  .map((k) => elsMap.get(k))
  .filter((id): id is string => !!id && !["input", "select", "textarea"].includes(markup.get(id) ?? ""));
ok(badControls.length === 0, `.value is only read from form controls${badControls.length ? ` — bad: ${badControls.join(", ")}` : ""}`);

/* kind values used in JS must exist as buttons in the markup */
const kindsInJs = new Set<string>();
for (const m of ui.matchAll(/data-kind=(\w+)|dataset\.kind === ['"](\w+)['"]/g)) {
  const v = m[1] ?? m[2];
  if (v) kindsInJs.add(v);
}
const kindGap = [...kindsInJs].filter((k) => !withDataKind.has(k));
ok(kindGap.length === 0, `data-kind values agree${kindGap.length ? ` — missing in markup: ${kindGap.join(", ")}` : ""}`);

/* ---- build integrity ---- */
ok(!html.includes("/*__DATA__*/") && !html.includes("/*__CORE__*/"), "build placeholders were substituted");
ok(!/<script[^>]+src=/.test(html), "no external script tags (single-file artifact)");
for (const [i, b] of blocks.entries()) {
  let parses = true;
  try { new Function(b); } catch { parses = false; }
  ok(parses, `script block ${i} parses`);
}

console.log(fail ? `\n${fail} FAILURES` : "\nstatic structure verified");
process.exit(fail ? 1 : 0);
