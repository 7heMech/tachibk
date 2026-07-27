/* ============================================================
   tachibk.7he.dev — conversion core (no DOM access in here)
   ============================================================ */

/* ---------- bytes ---------- */
const TE = new TextEncoder(), TD = new TextDecoder();
function concat(arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}

/* ---------- gzip ---------- */
async function pipe(data, stream) {
  /* Write and read concurrently — awaiting the write first can deadlock on the
     stream's internal queue for large backups. Avoids Blob so it works in any realm. */
  const writer = stream.writable.getWriter();
  const written = writer.write(data).then(() => writer.close()).catch(() => {});
  const reader = stream.readable.getReader();
  const chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  await written;
  return concat(chunks);
}
const isGzip = b => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const isZip = b => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
const gunzip = d => pipe(d, new DecompressionStream('gzip'));
const gzip = d => pipe(d, new CompressionStream('gzip'));
const inflateRaw = d => pipe(d, new DecompressionStream('deflate-raw'));
const deflateRaw = d => pipe(d, new CompressionStream('deflate-raw'));

/* ---------- protobuf: read ---------- */
function readVarint(buf, off) {
  let v = 0n, shift = 0n;
  for (;;) {
    if (off >= buf.length) throw new Error('Unexpected EOF reading varint');
    const b = buf[off++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  return [v, off];
}
function* pbFields(buf) {
  let off = 0;
  while (off < buf.length) {
    const tagStart = off;
    let tag; [tag, off] = readVarint(buf, off);
    const f = Number(tag >> 3n), w = Number(tag & 7n);
    let val;
    if (w === 0) { [val, off] = readVarint(buf, off); }
    else if (w === 1) { val = buf.subarray(off, off + 8); off += 8; }
    else if (w === 2) {
      let len; [len, off] = readVarint(buf, off);
      const n = Number(len); val = buf.subarray(off, off + n); off += n;
    }
    else if (w === 5) { val = buf.subarray(off, off + 4); off += 4; }
    else throw new Error('Unknown wire type ' + w + ' for field ' + f);
    yield { f, w, val, tagStart, end: off };
  }
}
const s64 = v => BigInt.asIntN(64, v);
const asNum = v => Number(BigInt.asIntN(64, v));
const readStr = b => TD.decode(b);
const readF32 = b => new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);

/* ---------- protobuf: write ---------- */
function varintBytes(v) {
  v = BigInt.asUintN(64, BigInt(v));
  const out = [];
  for (;;) {
    const b = Number(v & 0x7fn); v >>= 7n;
    if (v) out.push(b | 0x80); else { out.push(b); break; }
  }
  return new Uint8Array(out);
}
class PW {
  constructor() { this.p = []; }
  _tag(f, w) { this.p.push(varintBytes((f << 3) | w)); }
  _len(b) { this.p.push(varintBytes(b.length)); this.p.push(b); }
  vint(f, v) { if (v === undefined || v === null) return this; this._tag(f, 0); this.p.push(varintBytes(v)); return this; }
  bool(f, v) { if (v === undefined || v === null) return this; return this.vint(f, v ? 1 : 0); }
  str(f, s) { if (s === undefined || s === null) return this; this._tag(f, 2); this._len(TE.encode(s)); return this; }
  msg(f, b) { if (!b) return this; this._tag(f, 2); this._len(b); return this; }
  f32(f, v) { if (v === undefined || v === null) return this; this._tag(f, 5); const a = new Uint8Array(4); new DataView(a.buffer).setFloat32(0, v, true); this.p.push(a); return this; }
  raw(b) { this.p.push(b); return this; }
  done() { return concat(this.p); }
}

/* ---------- crc32 ---------- */
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- md5 (for Mihon source IDs) ---------- */
function md5(bytes) {
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22, 5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23, 6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const ml = bytes.length;
  const withPad = new Uint8Array(((ml + 8) >> 6 << 6) + 64);
  withPad.set(bytes); withPad[ml] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, (ml << 3) >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(ml / 536870912) >>> 0, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rol = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
  for (let off = 0; off < withPad.length; off += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + dv.getUint32(off + g * 4, true)) >>> 0;
      A = D; D = C; C = B; B = (B + rol(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), o = new DataView(out.buffer);
  o.setUint32(0, a0, true); o.setUint32(4, b0, true); o.setUint32(8, c0, true); o.setUint32(12, d0, true);
  return out;
}
/* Mihon/Tachiyomi HttpSource.id — md5("name.lowercase()/lang/versionId")[0..8] BE, sign bit cleared */
function mihonSourceId(name, lang, versionId) {
  const h = md5(TE.encode(`${name.toLowerCase()}/${lang}/${versionId == null ? 1 : versionId}`));
  let id = 0n;
  for (let i = 0; i < 8; i++) id |= BigInt(h[i]) << BigInt(8 * (7 - i));
  return id & 0x7FFFFFFFFFFFFFFFn;
}
/* Kotatsu id — seeded 31x rolling hash over source name then url, wrapping i64 */
function kotatsuId(sourceName, url) {
  let id = 1125899906842597n;
  const step = s => { for (const ch of s) id = BigInt.asIntN(64, id * 31n + BigInt(ch.codePointAt(0))); };
  step(sourceName); step(url);
  return id;
}

/* ---------- zip ---------- */
async function zipRead(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record)');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = TD.decode(buf.subarray(p + 46, p + 46 + nlen));
    entries.push({ name, method, csize, lho });
    p += 46 + nlen + elen + clen;
  }
  const out = [];
  for (const e of entries) {
    const ln = dv.getUint16(e.lho + 26, true), le = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + ln + le;
    const raw = buf.subarray(start, start + e.csize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = await inflateRaw(raw);
    else throw new Error(`Unsupported ZIP compression method ${e.method} for "${e.name}"`);
    out.push({ name: e.name, data });
  }
  return out;
}
async function zipWrite(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameB = TE.encode(f.name);
    const crc = crc32(f.data);
    let method = 8, payload;
    try { payload = await deflateRaw(f.data); if (payload.length >= f.data.length) { method = 0; payload = f.data; } }
    catch { method = 0; payload = f.data; }
    const lh = new Uint8Array(30); const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
    dv.setUint16(8, method, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, payload.length, true); dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nameB.length, true); dv.setUint16(28, 0, true);
    locals.push(lh, nameB, payload);
    const ch = new Uint8Array(46); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, method, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, payload.length, true); cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true);
    central.push(ch, nameB);
    offset += lh.length + nameB.length + payload.length;
  }
  const cd = concat(central);
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cd.length, true); ev.setUint32(16, offset, true);
  return concat([...locals, cd, eocd]);
}

/* ---------- BigInt-safe JSON ---------- */
function jsonDump(v, indent = 0, pad = '  ') {
  const sp = pad.repeat(indent), sp2 = pad.repeat(indent + 1);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '[\n' + v.map(x => sp2 + jsonDump(x, indent + 1, pad)).join(',\n') + '\n' + sp + ']';
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return '{\n' + keys.map(k => sp2 + JSON.stringify(k) + ': ' + jsonDump(v[k], indent + 1, pad)).join(',\n') + '\n' + sp + '}';
}
/* Quote long bare integers so JSON.parse can't silently round them */
function jsonParseBig(text) {
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}
const bigOf = v => { try { return BigInt(typeof v === 'string' ? v.trim() : Math.trunc(v || 0)); } catch { return 0n; } };

/* ---------- source tables ---------- */
/* KP_TABLE / CURATED are injected at build time */
const KOTATSU_PARSERS = (() => {
  const byName = new Map(), byTitleKey = new Map(), byNameKey = new Map(), byDomain = new Map();
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const row of KP_TABLE.split(';')) {
    const [name, title, doms] = row.split('|');
    if (!name) continue;
    const rec = { name, title: title || name, domains: doms ? doms.split(',').filter(Boolean) : [] };
    byName.set(name, rec);
    if (!byNameKey.has(norm(name))) byNameKey.set(norm(name), rec);
    if (rec.title && !byTitleKey.has(norm(rec.title))) byTitleKey.set(norm(rec.title), rec);
    for (const d of rec.domains) {
      const host = d.replace(/^www\./, '');
      if (!byDomain.has(host)) byDomain.set(host, rec);
    }
  }
  return { byName, byTitleKey, byNameKey, byDomain, norm, size: byName.size };
})();

const hostOf = u => (u || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase().replace(/^www\./, '');

/* Keiyoushi index (optional network fetch) — sourceId -> {name, lang, baseUrl} */
const KEIYOUSHI_URL = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json';
let keiyoushi = null;
async function loadKeiyoushi(log) {
  if (keiyoushi) return keiyoushi;
  const res = await fetch(KEIYOUSHI_URL);
  if (!res.ok) throw new Error('Keiyoushi index HTTP ' + res.status);
  const list = jsonParseBig(await res.text());
  const byId = new Map(), byHost = new Map(), byNameKey = new Map();
  const push = (map, k, rec) => { if (!k) return; const a = map.get(k); if (a) a.push(rec); else map.set(k, [rec]); };
  for (const ext of list) for (const s of (ext.sources || [])) {
    const rec = { id: bigOf(s.id), name: s.name, lang: s.lang || '', baseUrl: s.baseUrl || '', pkg: ext.pkg };
    byId.set(rec.id.toString(), rec);
    push(byHost, hostOf(rec.baseUrl), rec);
    push(byNameKey, KOTATSU_PARSERS.norm(rec.name), rec);
  }
  keiyoushi = { byId, byHost, byNameKey, count: byId.size };
  log && log(`Keiyoushi index loaded — ${keiyoushi.count} sources`, 'info');
  return keiyoushi;
}
/* Many sources publish one entry per language (MangaDex alone has 60).
   Pick the caller's preferred language, then 'all', then English, then whatever's first. */
function pickLang(list, prefLang) {
  if (!list || !list.length) return null;
  const want = (prefLang || 'en').toLowerCase();
  const order = [want, want.split('-')[0], 'all', 'en'];
  for (const w of order) { const hit = list.find(r => (r.lang || '').toLowerCase() === w); if (hit) return hit; }
  return list[0];
}

/* ---------- Mihon protobuf model ---------- */
function decodeChapter(b) {
  const c = {};
  for (const { f, w, val } of pbFields(b)) {
    if (f === 1 && w === 2) c.url = readStr(val);
    else if (f === 2 && w === 2) c.name = readStr(val);
    else if (f === 3 && w === 2) c.scanlator = readStr(val);
    else if (f === 4) c.read = val !== 0n;
    else if (f === 5) c.bookmark = val !== 0n;
    else if (f === 6) c.lastPageRead = asNum(val);
    else if (f === 8) c.dateUpload = s64(val);
    else if (f === 9 && w === 5) c.chapterNumber = readF32(val);
    else if (f === 10) c.sourceOrder = asNum(val);
  }
  return c;
}
function decodeManga(b) {
  const m = { genre: [], chapters: [], categories: [], history: [] };
  for (const { f, w, val } of pbFields(b)) {
    if (f === 1) m.source = s64(val);
    else if (f === 2 && w === 2) m.url = readStr(val);
    else if (f === 3 && w === 2) m.title = readStr(val);
    else if (f === 4 && w === 2) m.artist = readStr(val);
    else if (f === 5 && w === 2) m.author = readStr(val);
    else if (f === 6 && w === 2) m.description = readStr(val);
    else if (f === 7 && w === 2) m.genre.push(readStr(val));
    else if (f === 8) m.status = asNum(val);
    else if (f === 9 && w === 2) m.thumbnailUrl = readStr(val);
    else if (f === 13) m.dateAdded = s64(val);
    else if (f === 16 && w === 2) m.chapters.push(decodeChapter(val));
    else if (f === 17) {
      if (w === 0) m.categories.push(asNum(val));
      else if (w === 2) { let o = 0; while (o < val.length) { let v; [v, o] = readVarint(val, o); m.categories.push(asNum(v)); } }
    }
    else if (f === 100) m.favorite = val !== 0n;
    else if (f === 104 && w === 2) {
      const h = {};
      for (const q of pbFields(val)) {
        if (q.f === 1 && q.w === 2) h.url = readStr(q.val);
        else if (q.f === 2) h.lastRead = s64(q.val);
      }
      m.history.push(h);
    }
    else if (f === 106) m.lastModifiedAt = s64(val);
  }
  return m;
}
function decodeBackup(buf) {
  const bk = { manga: [], categories: [], sources: [], rootFields: new Set() };
  for (const { f, w, val } of pbFields(buf)) {
    bk.rootFields.add(f);
    if (f === 1 && w === 2) bk.manga.push(decodeManga(val));
    else if (f === 2 && w === 2) {
      const c = {};
      for (const q of pbFields(val)) {
        if (q.f === 1 && q.w === 2) c.name = readStr(q.val);
        else if (q.f === 2) c.order = asNum(q.val);
        else if (q.f === 3) c.id = s64(q.val);
      }
      bk.categories.push(c);
    }
    else if (f === 101 && w === 2) {
      const s = {};
      for (const q of pbFields(val)) {
        if (q.f === 1 && q.w === 2) s.name = readStr(q.val);
        else if (q.f === 2) s.sourceId = s64(q.val);
      }
      bk.sources.push(s);
    }
  }
  return bk;
}

/* ---------- app registry ---------- */
/* `root` = the manga-side root field numbers each app's Backup actually declares.
   Verified from each project's data/backup/models/Backup.kt — they are NOT uniform.
   Writing a field the target doesn't declare is at best ignored and at worst
   misread, since the same number can mean a different message (see field 106). */
const APPS = {
  mihon:     { label: 'Mihon',            fam: 'tachi',   kinds: ['manga'], ext: '.tachibk', root: [1, 2, 101, 104, 105, 106] },
  komikku:   { label: 'Komikku',          fam: 'tachi',   kinds: ['manga'], ext: '.tachibk', root: [1, 2, 101, 104, 105, 106, 600, 610] },
  sy:        { label: 'TachiyomiSY',      fam: 'tachi',   kinds: ['manga'], ext: '.tachibk', root: [1, 2, 101, 104, 105, 106, 600] },
  yokai:     { label: 'Yōkai / J2K',      fam: 'tachi',   kinds: ['manga'], ext: '.tachibk', root: [1, 2, 101, 104, 105] },
  neko:      { label: 'Neko',             fam: 'tachi',   kinds: ['manga'], ext: '.tachibk', root: [1, 2] },
  aniyomi:   { label: 'Aniyomi',          fam: 'tachi',   kinds: ['manga', 'anime'], ext: '.tachibk', root: [1, 2, 101, 104, 105, 106], anime: 'x5' },
  animetail: { label: 'Animetail',        fam: 'tachi',   kinds: ['manga', 'anime'], ext: '.tachibk', root: [1, 2, 101, 104, 105, 106], anime: 'x5' },
  anikku:    { label: 'Anikku',           fam: 'tachi',   kinds: ['anime'], ext: '.tachibk', anime: 'low' },
  kotatsu:   { label: 'Kotatsu',          fam: 'kotatsu', kinds: ['manga'], ext: '.zip' },
  usagi:     { label: 'Usagi',            fam: 'kotatsu', kinds: ['manga'], ext: '.zip' },
};
const ROOT_NAMES = { 1: 'manga', 2: 'categories', 101: 'sources', 104: 'preferences',
  105: 'source preferences', 106: 'extension stores', 600: 'saved searches', 610: 'feeds' };
/* anime root layouts: 'x5' = Aniyomi/Animetail 501/502/503/505, 'low' = Anikku 3/4/103/107 */
/* Verified against aniyomiorg/aniyomi Backup.kt and komikku-app/anikku Backup.kt.
   Aniyomi's current Backup uses 5xx; its LegacyBackup — and Anikku — use the low numbers. */
const ANIME_LAYOUT = {
  x5:  { anime: 501, cats: 502, sources: 503, repo: 505, exts: 504, buttons: 506 },
  low: { anime: 3,   cats: 4,   sources: 103, repo: 107, exts: 106, buttons: 109 },
};
function sharedKinds(from, to) { return APPS[from].kinds.filter(k => APPS[to].kinds.includes(k)); }
function validateRoute(from, to, kind) {
  if (from === to) return { ok: false, code: 'same', shared: [] };
  const shared = sharedKinds(from, to);
  if (!shared.length) return { ok: false, code: 'nokind', shared };
  if (!shared.includes(kind)) return { ok: false, code: 'wrongkind', shared };
  return { ok: true, shared };
}

function routeOf(from, to, kind) {
  const a = APPS[from], b = APPS[to];
  if (a.fam === 'tachi' && b.fam === 'tachi') return kind === 'anime' ? 'anime' : 'tachi2tachi';
  if (a.fam === 'tachi' && b.fam === 'kotatsu') return 'tachi2kotatsu';
  if (a.fam === 'kotatsu' && b.fam === 'tachi') return 'kotatsu2tachi';
  return 'kotatsu2kotatsu';
}

/* ---------- route: tachibk -> tachibk (manga) ---------- */
function detectAnimeLayout(buf) {
  const seen = new Set();
  for (const { f, w } of pbFields(buf)) if (w === 2) seen.add(f);
  if (seen.has(501) || seen.has(502) || seen.has(503)) return 'x5';
  if (seen.has(3) || seen.has(4) || seen.has(103)) return 'low';
  return null;
}
function stripHighFields(msg, min = 500) {
  const parts = [];
  for (const { f, w, val, tagStart, end } of pbFields(msg)) {
    if (f >= min) continue;
    if (f === 16 && w === 2) { const inner = stripHighFields(val, min); parts.push(varintBytes((16 << 3) | 2), varintBytes(inner.length), inner); }
    else parts.push(msg.subarray(tagStart, end));
  }
  return concat(parts);
}
function convertTachiManga(buf, fromApp, toApp, log) {
  const keep = new Set(APPS[toApp].root || []);
  const stripNested = APPS[fromApp].kinds.includes('anime') && !APPS[toApp].kinds.includes('anime');
  const parts = []; const counts = {};
  for (const { f, w, val, tagStart, end } of pbFields(buf)) {
    if (!keep.has(f)) { counts['drop:' + f] = (counts['drop:' + f] || 0) + 1; continue; }
    counts[f] = (counts[f] || 0) + 1;
    if (stripNested && f === 1 && w === 2) {
      const inner = stripHighFields(val, 500);
      parts.push(varintBytes((1 << 3) | 2), varintBytes(inner.length), inner);
    } else parts.push(buf.subarray(tagStart, end));
  }
  for (const f of [...keep].sort((x, y) => x - y)) if (counts[f]) log(`kept ${counts[f]} × ${ROOT_NAMES[f] || 'field ' + f}`, 'info');
  const dropped = Object.keys(counts).filter(k => k.startsWith('drop:')).map(k => k.slice(5)).sort((a, b) => a - b);
  if (dropped.length) log(`dropped ${dropped.map(f => ROOT_NAMES[f] ? `${ROOT_NAMES[f]} (${f})` : f).join(', ')} — not in ${APPS[toApp].label}'s backup`, 'warn');
  if (stripNested) log('stripped fork-specific fields ≥500 inside manga/chapters', 'warn');
  return concat(parts);
}

/* ---------- route: tachibk -> tachibk (anime) ---------- */
function convertTachiAnime(buf, toApp, log) {
  const src = detectAnimeLayout(buf);
  if (!src) throw new Error('No anime data found in this backup — pick a manga target instead.');
  const dst = APPS[toApp].anime;
  if (!dst) throw new Error(`${APPS[toApp].label} does not store anime.`);
  const S = ANIME_LAYOUT[src], D = ANIME_LAYOUT[dst];
  log(`detected ${src === 'x5' ? 'Aniyomi/Animetail (5xx)' : 'Anikku'} anime layout`, 'info');
  if (src === dst) log('source and target use the same layout — filtering only', 'info');
  const remap = { [S.anime]: D.anime, [S.cats]: D.cats, [S.sources]: D.sources,
                  [S.repo]: D.repo, [S.exts]: D.exts, [S.buttons]: D.buttons };
  const parts = [];
  for (const { f, w, val } of pbFields(buf)) {
    const to = remap[f];
    if (to === undefined) continue;
    let payload = val;
    if (f === S.anime && w === 2) payload = stripHighFields(val, 500);
    parts.push(varintBytes((to << 3) | w), varintBytes(payload.length), payload);
  }
  if (!parts.length) throw new Error('Nothing to convert — no anime fields matched.');
  return concat(parts);
}

/* ---------- source resolution: Mihon source -> Kotatsu parser ---------- */
function resolveKotatsuParser(srcId, srcName, kei) {
  const N = KOTATSU_PARSERS.norm;
  const ck = CURATED_M2K[srcName ? srcName.toUpperCase() : ''];
  if (ck && KOTATSU_PARSERS.byName.has(ck)) return { rec: KOTATSU_PARSERS.byName.get(ck), how: 'curated' };
  if (srcName) {
    const k = N(srcName);
    if (KOTATSU_PARSERS.byTitleKey.has(k)) return { rec: KOTATSU_PARSERS.byTitleKey.get(k), how: 'name' };
    if (KOTATSU_PARSERS.byNameKey.has(k)) return { rec: KOTATSU_PARSERS.byNameKey.get(k), how: 'name' };
  }
  if (kei) {
    const e = kei.byId.get(srcId.toString());
    if (e) {
      const h = hostOf(e.baseUrl);
      if (h && KOTATSU_PARSERS.byDomain.has(h)) return { rec: KOTATSU_PARSERS.byDomain.get(h), how: 'domain', baseUrl: e.baseUrl };
      const k = N(e.name);
      if (KOTATSU_PARSERS.byTitleKey.has(k)) return { rec: KOTATSU_PARSERS.byTitleKey.get(k), how: 'name', baseUrl: e.baseUrl };
      if (KOTATSU_PARSERS.byNameKey.has(k)) return { rec: KOTATSU_PARSERS.byNameKey.get(k), how: 'name', baseUrl: e.baseUrl };
    }
  }
  return null;
}

/* ---------- route: tachibk -> Kotatsu zip ---------- */
const CAT_DEFAULT = 2n, CAT_OFFSET = 3n;
const MIHON_STATE = { 1: 'ONGOING', 2: 'FINISHED', 4: 'FINISHED', 5: 'ABANDONED', 6: 'PAUSED' };

async function convertToKotatsu(buf, opts, log) {
  const bk = decodeBackup(buf);
  log(`parsed ${bk.manga.length} manga, ${bk.categories.length} categories, ${bk.sources.length} sources`, 'info');
  const kei = opts.useKeiyoushi ? await loadKeiyoushi(log).catch(e => { log('Keiyoushi fetch failed (' + e.message + ') — offline matching only', 'warn'); return null; }) : null;

  const srcNameById = new Map();
  for (const s of bk.sources) if (s.sourceId !== undefined) srcNameById.set(s.sourceId.toString(), s.name || '');

  const categories = [{
    category_id: CAT_DEFAULT, created_at: 0, sort_key: 0, title: opts.libraryName || 'Library',
    order: 'ALPHABETIC', track: true, show_in_lib: true, deleted_at: 0,
  }];
  /* Mihon's own restorer matches BackupManga.categories against BackupCategory.order,
     never .id — id is discarded on restore (categories are matched by name and given a
     fresh local id). So the join key here must be `order`, not `id`. Assign the Kotatsu
     category_id from array position (not from `order`'s numeric value) so it stays
     collision-free even if the source data has duplicate or non-sequential order values. */
  const orderToCatId = new Map();
  for (const c of bk.categories) {
    const ord = BigInt(c.order || 0);
    if (orderToCatId.has(ord)) continue; // duplicate order value in source data — keep the first
    const catId = CAT_OFFSET + BigInt(orderToCatId.size);
    orderToCatId.set(ord, catId);
    categories.push({
      category_id: catId, created_at: 0, sort_key: c.order || 0, title: c.name || 'Category',
      order: 'NEWEST', track: null, show_in_lib: true, deleted_at: 0,
    });
  }

  const favourites = [], history = [], bookmarks = [];
  const unmatched = new Map(); let skipped = 0, guessed = 0;
  const how = { curated: 0, name: 0, domain: 0 };

  for (const m of bk.manga) {
    if (m.source === undefined || m.source === 0n) { skipped++; continue; }
    const sName = srcNameById.get(m.source.toString()) || '';
    const hit = resolveKotatsuParser(m.source, sName, kei);
    if (!hit) {
      const key = sName || ('source ' + m.source);
      unmatched.set(key, (unmatched.get(key) || 0) + 1);
      skipped++; continue;
    }
    how[hit.how]++;
    const parser = hit.rec.name;
    const url = m.url || '';
    let baseUrl = hit.baseUrl || (hit.rec.domains[0] ? 'https://' + hit.rec.domains[0] : '');
    let publicUrl = /^https?:\/\//i.test(url) ? url : (baseUrl ? baseUrl.replace(/\/$/, '') + (url.startsWith('/') ? '' : '/') + url : url);
    if (!hit.baseUrl && hit.how !== 'domain') guessed++;

    const id = kotatsuId(parser, url);
    const kmanga = {
      id, title: m.title || '', alt_title: null, url, public_url: publicUrl,
      rating: -1.0, nsfw: false, cover_url: m.thumbnailUrl || '',
      large_cover_url: m.thumbnailUrl || null, state: MIHON_STATE[m.status] || '',
      author: m.author || m.artist || '', source: parser, tags: [],
    };

    const cats = m.categories.map(o => orderToCatId.get(BigInt(o))).filter(cid => cid !== undefined);
    for (const cid of [...cats, CAT_DEFAULT]) {
      favourites.push({ manga_id: id, category_id: cid, sort_key: 0, created_at: m.dateAdded || 0n, deleted_at: 0, manga: kmanga });
    }

    const chId = u => kotatsuId(parser, u || '');
    const bms = m.chapters.filter(c => c.bookmark).map(c => ({
      manga_id: id, page_id: 0, chapter_id: chId(c.url), page: c.lastPageRead || 0,
      scroll: 0, image_url: kmanga.cover_url, created_at: 0, percent: 0.0,
    }));
    if (bms.length) bookmarks.push({ manga: kmanga, tags: [], bookmarks: bms });

    let latest = null, newest = null;
    for (const c of m.chapters) {
      if (c.read && (!latest || (c.chapterNumber || 0) > (latest.chapterNumber || 0))) latest = c;
      if (!newest || (c.chapterNumber || 0) > (newest.chapterNumber || 0)) newest = c;
    }
    let lastRead = 0n;
    for (const h of m.history) if (h.lastRead && h.lastRead > lastRead) lastRead = h.lastRead;
    if (!lastRead) lastRead = m.lastModifiedAt || 0n;
    const pct = latest && newest && latest.chapterNumber > 0 && newest.chapterNumber > 0
      ? Math.min(1, Math.max(0, latest.chapterNumber / newest.chapterNumber)) : 0;
    history.push({
      manga_id: id, created_at: m.dateAdded || 0n, updated_at: lastRead,
      chapter_id: latest ? chId(latest.url) : 0, page: latest ? (latest.lastPageRead || 0) : 0,
      scroll: 0.0, percent: pct, manga: kmanga,
    });
  }

  log(`matched sources — ${how.curated} curated, ${how.name} by name, ${how.domain} by domain`, 'info');
  if (guessed) log(`${guessed} entries used a parser default domain for public_url`, 'warn');
  if (unmatched.size) {
    log(`${skipped} manga skipped — no Kotatsu parser for: ${[...unmatched.keys()].slice(0, 8).join(', ')}${unmatched.size > 8 ? ` (+${unmatched.size - 8} more)` : ''}`, 'warn');
  }
  if (!favourites.length) throw new Error('No manga could be mapped to a Kotatsu source.');

  const index = [{ app_id: 'dev.7he.tachibk', app_version: 1, created_at: Date.now() }];
  const files = [];
  const add = (name, arr) => { if (arr.length) files.push({ name, data: TE.encode(jsonDump(arr)) }); };
  add('history', history); add('categories', categories); add('favourites', favourites); add('bookmarks', bookmarks);
  files.push({ name: 'index', data: TE.encode(jsonDump(index)) });
  log(`built ${favourites.length} favourites, ${history.length} history, ${bookmarks.length} bookmark sets`, 'success');
  return zipWrite(files);
}

/* ---------- route: Kotatsu zip -> tachibk ---------- */
/* Mihon/Komikku field 106 is BackupExtensionStore (was BackupExtensionRepos):
   1 indexUrl, 2 name, 3 badgeLabel, 4 contactWebsite, 5 signingKey, 6 contactDiscord,
   7 isLegacy, 8 extensionListUrl. Keiyoushi's repo branch is the index.min.json
   style, so isLegacy = true. */
const KEIYOUSHI_STORE = {
  indexUrl: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo',
  name: 'Keiyoushi', badgeLabel: 'keiyoushi',
  contactWebsite: 'https://keiyoushi.github.io',
  signingKey: '9add655a78e96c4ec7a53ef89dccb557cb5d767489fac5e785d671a5a75d4da2',
};
async function convertFromKotatsu(buf, opts, log) {
  const entries = await zipRead(buf);
  log(`zip sections: ${entries.map(e => e.name).join(', ')}`, 'info');
  const get = n => { const e = entries.find(x => x.name === n); return e ? jsonParseBig(TD.decode(e.data)) : null; };
  const favourites = get('favourites') || [], histories = get('history') || [], cats = get('categories') || [];
  if (!favourites.length && !histories.length) throw new Error('No favourites or history found in this Kotatsu backup.');

  const kei = opts.useKeiyoushi ? await loadKeiyoushi(log).catch(e => { log('Keiyoushi fetch failed (' + e.message + ') — curated map only', 'warn'); return null; }) : null;

  const resolved = new Map(); const misses = new Map();
  function resolveMihon(parserName) {
    if (resolved.has(parserName)) return resolved.get(parserName);
    let out = null;
    const mihonName = CURATED_K2M[parserName ? parserName.toUpperCase() : ''];
    const L = opts.lang;
    if (kei) {
      if (mihonName) {
        const r = pickLang(kei.byNameKey.get(KOTATSU_PARSERS.norm(mihonName)), L);
        if (r) out = { id: r.id, name: r.name, lang: r.lang };
      }
      if (!out) {
        const p = KOTATSU_PARSERS.byName.get(parserName);
        if (p) {
          for (const d of p.domains) { const r = pickLang(kei.byHost.get(d.replace(/^www\./, '')), L); if (r) { out = { id: r.id, name: r.name, lang: r.lang }; break; } }
          if (!out) { const r = pickLang(kei.byNameKey.get(KOTATSU_PARSERS.norm(p.title)), L); if (r) out = { id: r.id, name: r.name, lang: r.lang }; }
        }
      }
    }
    if (!out && mihonName) out = { id: mihonSourceId(mihonName, opts.lang || 'en', 1), name: mihonName, weak: true };
    resolved.set(parserName, out);
    return out;
  }

  const byManga = new Map();
  const take = km => {
    const key = String(km.id);
    if (!byManga.has(key)) byManga.set(key, { km, cats: new Set(), lastRead: 0n, dateAdded: 0n });
    return byManga.get(key);
  };
  for (const f of favourites) { const e = take(f.manga || {}); if (f.category_id != null) e.cats.add(bigOf(f.category_id)); if (f.created_at) e.dateAdded = bigOf(f.created_at); }
  for (const h of histories) { const e = take(h.manga || {}); const t = bigOf(h.updated_at); if (t > e.lastRead) e.lastRead = t; if (!e.dateAdded && h.created_at) e.dateAdded = bigOf(h.created_at); }

  const targetRootPre = new Set(APPS[opts.to] ? APPS[opts.to].root || [] : [1, 2, 101, 104, 105, 106]);
  const emitCats = targetRootPre.has(2), emitSources = targetRootPre.has(101);
  /* Mihon's restorer matches BackupManga.categories (field 17) against BackupCategory.order
     (list position) and discards the backup's category id entirely — see CategoriesRestorer.kt.
     So field 17 must hold each category's assigned order, not its Kotatsu category_id. Sort by
     Kotatsu's sort_key for a sensible default order, then assign order = array index — that's
     guaranteed unique even if sort_key has gaps or duplicates in the source data, which a raw
     copy of sort_key would not be. This map must exist before the manga loop below, since each
     manga's field 17 is written from it. */
  const sortedCats = [...(emitCats ? cats : [])].sort((a, b) => Number(bigOf(a.sort_key) - bigOf(b.sort_key)));
  const catIdToOrder = new Map();
  sortedCats.forEach((c, i) => catIdToOrder.set(String(bigOf(c.category_id)), i));

  const root = new PW(); let kept = 0, dropped = 0, weak = 0;
  const usedSources = new Map();
  for (const { km, cats: mcats, lastRead, dateAdded } of byManga.values()) {
    const hit = resolveMihon(km.source || '');
    if (!hit) { misses.set(km.source || '?', (misses.get(km.source || '?') || 0) + 1); if (!opts.keepUnmatched) { dropped++; continue; } }
    const sid = hit ? hit.id : mihonSourceId(km.source || 'unknown', opts.lang || 'en', 1);
    const sname = hit ? hit.name : (km.source || 'unknown');
    if (hit && hit.weak) weak++;
    usedSources.set(sid.toString(), sname);

    const m = new PW();
    m.vint(1, sid).str(2, km.url || '').str(3, km.title || '');
    if (km.author) m.str(5, km.author);
    if (km.cover_url) m.str(9, km.cover_url);
    m.vint(13, dateAdded || 0n);
    for (const cid of mcats) {
      const ord = catIdToOrder.get(String(cid));
      if (ord !== undefined) m.vint(17, ord);
    }
    m.bool(100, true);
    m.vint(106, lastRead || dateAdded || 0n);
    m.vint(109, 1);
    root.msg(1, m.done());
    kept++;
  }
  for (const c of sortedCats) {
    const cm = new PW();
    cm.str(1, c.title || 'Category').vint(2, catIdToOrder.get(String(bigOf(c.category_id)))).vint(3, bigOf(c.category_id)).vint(100, 0);
    root.msg(2, cm.done());
  }
  for (const [id, name] of (emitSources ? usedSources : [])) {
    const sm = new PW(); sm.str(1, name).vint(2, BigInt(id));
    root.msg(101, sm.done());
  }
  const targetRoot = new Set(APPS[opts.to] ? APPS[opts.to].root || [] : [1, 2, 101, 104, 105, 106]);
  if (targetRoot.has(106)) {
    const store = new PW();
    store.str(1, KEIYOUSHI_STORE.indexUrl).str(2, KEIYOUSHI_STORE.name).str(3, KEIYOUSHI_STORE.badgeLabel)
         .str(4, KEIYOUSHI_STORE.contactWebsite).str(5, KEIYOUSHI_STORE.signingKey).bool(7, true);
    root.msg(106, store.done());
    log('added the Keiyoushi extension store so extensions install without trust prompts', 'info');
  } else {
    log(`${APPS[opts.to] ? APPS[opts.to].label : 'target'} has no extension-store field — install extensions manually`, 'warn');
  }

  log(`converted ${kept} manga across ${usedSources.size} sources`, 'success');
  if (weak) log(`${weak} sources resolved from the curated map only — verify them after import`, 'warn');
  if (misses.size) log(`${dropped} manga skipped — no Mihon source for: ${[...misses.keys()].slice(0, 8).join(', ')}${misses.size > 8 ? ` (+${misses.size - 8} more)` : ''}`, 'warn');
  log('chapters are not stored in Kotatsu backups — refresh each entry after restoring', 'warn');
  return root.done();
}

/* ---------- route: Kotatsu <-> Usagi ---------- */
async function repackKotatsu(buf, log) {
  const entries = await zipRead(buf);
  log(`repacking ${entries.length} sections: ${entries.map(e => e.name).join(', ')}`, 'info');
  log('Kotatsu and Usagi share a backup format — contents pass through unchanged', 'info');
  return zipWrite(entries.map(e => ({ name: e.name, data: e.data })));
}

/* ---------- driver ---------- */
async function runConversion(inputBytes, from, to, kind, opts, log) {
  const v = validateRoute(from, to, kind);
  if (!v.ok) {
    if (v.code === 'same') throw new Error('Pick two different apps.');
    if (v.code === 'nokind') throw new Error(
      `${APPS[from].label} stores ${APPS[from].kinds.join(' + ')} and ${APPS[to].label} stores ${APPS[to].kinds.join(' + ')} — there is nothing in common to convert.`);
    throw new Error(`This pair can only convert ${v.shared.join(' or ')}.`);
  }
  const route = routeOf(from, to, kind);
  const fromFam = APPS[from].fam;
  let data = inputBytes;
  if (fromFam === 'tachi') {
    if (isZip(inputBytes)) throw new Error(`That's a ZIP file — pick Kotatsu or Usagi as the "From" app.`);
    if (isGzip(inputBytes)) { data = await gunzip(inputBytes); log(`decompressed: ${fmtBytes(data.length)}`, 'info'); }
    else log('not gzipped — reading as raw protobuf', 'warn');
  } else if (!isZip(inputBytes)) {
    throw new Error(isGzip(inputBytes)
      ? `That's a gzipped .tachibk — pick a Mihon or Aniyomi app as the "From" app.`
      : 'This does not look like a Kotatsu .zip backup.');
  }
  let out, needGzip = APPS[to].fam === 'tachi';
  if (route === 'tachi2tachi') out = convertTachiManga(data, from, to, log);
  else if (route === 'anime') out = convertTachiAnime(data, to, log);
  else if (route === 'tachi2kotatsu') out = await convertToKotatsu(data, opts, log);
  else if (route === 'kotatsu2tachi') out = await convertFromKotatsu(data, { ...opts, to }, log);
  else out = await repackKotatsu(data, log);
  if (needGzip) { log(`protobuf: ${fmtBytes(out.length)} — compressing`, 'info'); out = await gzip(out); }
  log(`output: ${fmtBytes(out.length)}`, 'success');
  return out;
}
