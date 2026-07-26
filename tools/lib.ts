/** Shared helpers for the tools. See AGENTS.md. */
/** Repo root, found by walking up from this file — independent of the working directory. */
export const root = await (async () => {
  let dir = new URL("./", import.meta.url);
  for (let i = 0; i < 8; i++) {
    if (await Bun.file(new URL("tools/template.html", dir)).exists()) return dir;
    const up = new URL("../", dir);
    if (up.pathname === dir.pathname) break;
    dir = up;
  }
  throw new Error("could not locate the repo root (no tools/template.html found)");
})();

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const host = (u: string) =>
  (u || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase().replace(/^www\./, "");

/** data.js is a plain script, not a module — evaluate it to read its consts. */
export async function loadTables(): Promise<{
  KP_TABLE: string; CURATED_K2M: Record<string, string>; CURATED_M2K: Record<string, string>;
}> {
  const src = await Bun.file(new URL("tools/data.js", root)).text();
  return new Function(`${src}; return { KP_TABLE, CURATED_K2M, CURATED_M2K };`)();
}

/** Minimal ZIP reader: central-directory scan, stored + deflate. No zip64. */
export async function unzip(buf: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = td.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) {
      out.set(name, new Uint8Array(await new Response(
        new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
      ).arrayBuffer()));
    } else throw new Error(`unsupported ZIP compression method ${method} for "${name}"`);
  }
  return out;
}

export async function download(url: string, label: string): Promise<Uint8Array> {
  console.log(`downloading ${label} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
