#!/usr/bin/env bun
/**
 * Build, then run every suite. Replaces run-tests.sh — no bash/shell dependency,
 * so this works the same on Windows as on Linux/macOS.
 *
 * Logic suites run on Bun. The three DOM suites (guard/uitest/e2e) run on Node,
 * because jsdom's runScripts:"dangerously" fails under Bun's node:vm — see
 * AGENTS.md for the exact error and what's been ruled out as the cause.
 */
async function findRoot(start: string): Promise<URL> {
  let dir = new URL("./", start);
  for (let i = 0; i < 8; i++) {
    if (await Bun.file(new URL("tools/template.html", dir)).exists()) return dir;
    const up = new URL("../", dir);
    if (up.pathname === dir.pathname) break;
    dir = up;
  }
  console.error("ERROR: could not locate the repo root (no tools/template.html found).");
  process.exit(1);
}
const root = await findRoot(import.meta.url);
const path = (p: string) => new URL(p, root).pathname;

// --- build first ---
const build = Bun.spawnSync({ cmd: ["bun", path("tools/build.ts")], stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

// --- suites ---
type Suite = { name: string; runner: "bun" | "node"; file: string };
const suites: Suite[] = [
  { name: "test", runner: "bun", file: "test.mjs" },
  { name: "test2", runner: "bun", file: "test2.mjs" },
  { name: "test3", runner: "bun", file: "test3.mjs" },
  { name: "rootcheck", runner: "bun", file: "rootcheck.mjs" },
  { name: "categories", runner: "bun", file: "categories.mjs" },
  { name: "merge", runner: "bun", file: "merge.mjs" },
  { name: "domcheck", runner: "bun", file: "domcheck.ts" },
  { name: "guard", runner: "node", file: "guard.mjs" },
  { name: "uitest", runner: "node", file: "uitest.mjs" },
  { name: "e2e", runner: "node", file: "e2e.mjs" },
  { name: "mergeui", runner: "node", file: "mergeui.mjs" },
];

let anyFail = false;
for (const s of suites) {
  const label = `  ${s.name.padEnd(10)} ${s.runner.padEnd(5)} `;
  const proc = Bun.spawnSync({ cmd: [s.runner, path(`tests/${s.file}`)], stdout: "pipe", stderr: "pipe" });
  const out = (proc.stdout?.toString() ?? "") + (proc.stderr?.toString() ?? "");
  const lastLine = out.trim().split("\n").pop() ?? "";
  const pass = proc.exitCode === 0 && /passed|verified/i.test(lastLine);
  console.log(label + (pass ? "pass" : "FAIL"));
  if (!pass) {
    anyFail = true;
    const interesting = out.split("\n").filter(l => /^FAIL|Error|error:/i.test(l)).slice(0, 5);
    for (const line of interesting) console.log("      " + line);
  }
}

console.log(anyFail ? "\n  FAILURES" : "\n  all suites passed");
process.exit(anyFail ? 1 : 0);
