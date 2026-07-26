#!/usr/bin/env bun
/** Assemble public/index.html from tools/{data.js,core.js,template.html}. */
const root = new URL("../", import.meta.url);
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
await Bun.write(new URL("public/index.html", root), out);
// out.length is UTF-16 units, not bytes — the page contains astral emoji.
const bytes = new TextEncoder().encode(out).length;
console.log(`built public/index.html — ${bytes.toLocaleString()} bytes`);
