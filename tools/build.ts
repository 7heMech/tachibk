#!/usr/bin/env bun
/**
 * Assemble public/index.html from tools/{data.js,core.js,template.html}.
 *
 * Self-contained on purpose (no local imports) so it still works if it is copied
 * elsewhere in the tree. Locates the repo root by walking up from its own location
 * until it finds tools/template.html, so it does not care about the working
 * directory or where in the repo it is invoked from.
 */
async function findRoot(start: string): Promise<URL> {
  let dir = new URL("./", start);
  for (let i = 0; i < 8; i++) {
    if (await Bun.file(new URL("tools/template.html", dir)).exists()) return dir;
    const up = new URL("../", dir);
    if (up.pathname === dir.pathname) break;
    dir = up;
  }
  console.error(
    "ERROR: could not locate the repo root (no tools/template.html found).\n" +
    `  searched upward from: ${new URL("./", start).pathname}\n` +
    "  run this from a checkout, e.g.  bun tools/build.ts",
  );
  process.exit(1);
}

const root = await findRoot(import.meta.url);
const read = (p: string) => Bun.file(new URL(p, root)).text();

const [tpl, data, core] = await Promise.all([
  read("tools/template.html"), read("tools/data.js"), read("tools/core.js"),
]);

for (const [blob, name] of [[data, "data.js"], [core, "core.js"]] as const) {
  if (blob.toLowerCase().includes("</script")) {
    console.error(`ERROR: ${name} contains a closing script tag; it would break the inline block.`);
    process.exit(1);
  }
}
for (const tag of ["/*__DATA__*/", "/*__CORE__*/"]) {
  if (!tpl.includes(tag)) {
    console.error(`ERROR: template.html is missing the ${tag} placeholder.`);
    process.exit(1);
  }
}

const out = tpl.replace("/*__DATA__*/", () => data).replace("/*__CORE__*/", () => core);
const dest = new URL("public/index.html", root);
await Bun.write(dest, out);
// out.length is UTF-16 units, not bytes — the page contains astral emoji.
console.log(`built ${dest.pathname} — ${new TextEncoder().encode(out).length.toLocaleString()} bytes`);
