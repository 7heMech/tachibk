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
/* The conversion routes filter bytes, so every field a fork declares survives them
   whether or not this file knows what it is. The merge engine rebuilds entries, so
   it cannot rely on that: decoders here record each field they do not understand as
   a raw slice in `_raw`, and the encoders re-emit those verbatim. Without it a merge
   would silently drop tracking (18), notes (110), excludedScanlators (108),
   chapterFlags (101), updateStrategy (105), memo (112) and every fork-specific
   field — data a plain conversion keeps. See AGENTS.md §2. */
function rawPush(o, msg, tagStart, end) { (o._raw || (o._raw = [])).push(msg.subarray(tagStart, end)); }
function rawFieldNum(slice) { const [tag] = readVarint(slice, 0); return Number(tag >> 3n); }
function rawBytes(o, min) {
  if (!o._raw || !o._raw.length) return null;
  const keep = min === undefined ? o._raw : o._raw.filter(s => rawFieldNum(s) < min);
  return keep.length ? concat(keep) : null;
}
function rawDropped(o, min) {
  if (min === undefined || !o._raw) return [];
  return o._raw.filter(s => rawFieldNum(s) >= min).map(rawFieldNum);
}

/* BackupChapter 1-13; BackupEpisode adds 16 totalSeconds and 501 fillermark.
   Every branch pins the wire type as well as the number — a mismatch means the
   fork reused the number for something else, and raw passthrough is the safe
   answer there, not a misread value. */
function decodeChapter(b, isEpisode) {
  const c = {};
  for (const { f, w, val, tagStart, end } of pbFields(b)) {
    if (f === 1 && w === 2) c.url = readStr(val);
    else if (f === 2 && w === 2) c.name = readStr(val);
    else if (f === 3 && w === 2) c.scanlator = readStr(val);
    else if (f === 4 && w === 0) c.read = val !== 0n;
    else if (f === 5 && w === 0) c.bookmark = val !== 0n;
    else if (f === 6 && w === 0) c.lastPageRead = asNum(val);
    else if (f === 7 && w === 0) c.dateFetch = s64(val);
    else if (f === 8 && w === 0) c.dateUpload = s64(val);
    else if (f === 9 && w === 5) c.chapterNumber = readF32(val);
    else if (f === 10 && w === 0) c.sourceOrder = asNum(val);
    else if (f === 11 && w === 0) c.lastModifiedAt = s64(val);
    else if (f === 12 && w === 0) c.version = s64(val);
    else if (isEpisode && f === 16 && w === 0) c.totalSeconds = s64(val);
    else if (isEpisode && f === 501 && w === 0) c.fillermark = val !== 0n;
    else rawPush(c, b, tagStart, end);
  }
  return c;
}
function encodeChapter(c, isEpisode, dropHigh) {
  const w = new PW();
  w.str(1, c.url).str(2, c.name).str(3, c.scanlator)
   .bool(4, c.read).bool(5, c.bookmark).vint(6, c.lastPageRead)
   .vint(7, c.dateFetch).vint(8, c.dateUpload);
  if (c.chapterNumber !== undefined) w.f32(9, c.chapterNumber);
  w.vint(10, c.sourceOrder).vint(11, c.lastModifiedAt).vint(12, c.version);
  if (isEpisode) { w.vint(16, c.totalSeconds); if (!dropHigh) w.bool(501, c.fillermark); }
  const r = rawBytes(c, dropHigh ? 500 : undefined);
  if (r) w.raw(r);
  return w.done();
}

/* BackupManga / BackupAnime. 502 parentId and 503 id are decoded for anime only,
   because they are device-local season identifiers the merge engine has to
   renumber; 500/504/505/506/507 ride along in `_raw` untouched. */
function decodeManga(b, isAnime) {
  const m = { genre: [], chapters: [], categories: [], history: [] };
  for (const { f, w, val, tagStart, end } of pbFields(b)) {
    if (f === 1 && w === 0) m.source = s64(val);
    else if (f === 2 && w === 2) m.url = readStr(val);
    else if (f === 3 && w === 2) m.title = readStr(val);
    else if (f === 4 && w === 2) m.artist = readStr(val);
    else if (f === 5 && w === 2) m.author = readStr(val);
    else if (f === 6 && w === 2) m.description = readStr(val);
    else if (f === 7 && w === 2) m.genre.push(readStr(val));
    else if (f === 8 && w === 0) m.status = asNum(val);
    else if (f === 9 && w === 2) m.thumbnailUrl = readStr(val);
    else if (f === 13 && w === 0) m.dateAdded = s64(val);
    else if (f === 16 && w === 2) m.chapters.push(decodeChapter(val, isAnime));
    else if (f === 17 && w === 0) m.categories.push(asNum(val));
    else if (f === 17 && w === 2) { let o = 0; while (o < val.length) { let v; [v, o] = readVarint(val, o); m.categories.push(asNum(v)); } }
    else if (f === 100 && w === 0) m.favorite = val !== 0n;
    else if (f === 104 && w === 2) {
      const h = {};
      for (const q of pbFields(val)) {
        if (q.f === 1 && q.w === 2) h.url = readStr(q.val);
        else if (q.f === 2 && q.w === 0) h.lastRead = s64(q.val);
        else if (q.f === 3 && q.w === 0) h.readDuration = s64(q.val);
        else rawPush(h, val, q.tagStart, q.end);
      }
      m.history.push(h);
    }
    else if (f === 106 && w === 0) m.lastModifiedAt = s64(val);
    else if (f === 107 && w === 0) m.favoriteModifiedAt = s64(val);
    else if (f === 109 && w === 0) m.version = s64(val);
    else if (isAnime && f === 502 && w === 0) m.seasonParentId = s64(val);
    else if (isAnime && f === 503 && w === 0) m.seasonId = s64(val);
    else rawPush(m, b, tagStart, end);
  }
  return m;
}
function encodeManga(m, isAnime, dropHigh) {
  const w = new PW();
  w.vint(1, m.source).str(2, m.url).str(3, m.title).str(4, m.artist)
   .str(5, m.author).str(6, m.description);
  for (const g of m.genre) w.str(7, g);
  w.vint(8, m.status).str(9, m.thumbnailUrl).vint(13, m.dateAdded);
  for (const c of m.chapters) w.msg(16, encodeChapter(c, isAnime, dropHigh));
  for (const c of m.categories) w.vint(17, c);
  w.bool(100, m.favorite);
  for (const h of m.history) {
    const hw = new PW();
    hw.str(1, h.url).vint(2, h.lastRead).vint(3, h.readDuration);
    const hr = rawBytes(h); if (hr) hw.raw(hr);
    w.msg(104, hw.done());
  }
  w.vint(106, m.lastModifiedAt).vint(107, m.favoriteModifiedAt).vint(109, m.version);
  if (isAnime && !dropHigh) w.vint(502, m.seasonParentId).vint(503, m.seasonId);
  const r = rawBytes(m, dropHigh ? 500 : undefined);
  if (r) w.raw(r);
  return w.done();
}

/* BackupCategory — field 100 is `flags` (per-category sort and display mode).
   It was previously dropped on decode, which is invisible to the byte-filtering
   routes and would have been a real loss through the merge engine. */
function decodeCategory(b) {
  const c = {};
  for (const { f, w, val, tagStart, end } of pbFields(b)) {
    if (f === 1 && w === 2) c.name = readStr(val);
    else if (f === 2 && w === 0) c.order = asNum(val);
    else if (f === 3 && w === 0) c.id = s64(val);
    else if (f === 100 && w === 0) c.flags = s64(val);
    else rawPush(c, b, tagStart, end);
  }
  return c;
}
function encodeCategory(c) {
  const w = new PW();
  w.str(1, c.name).vint(2, c.order).vint(3, c.id).vint(100, c.flags === undefined ? 0n : c.flags);
  const r = rawBytes(c); if (r) w.raw(r);
  return w.done();
}
function decodeSource(b) {
  const s = {};
  for (const { f, w, val, tagStart, end } of pbFields(b)) {
    if (f === 1 && w === 2) s.name = readStr(val);
    else if (f === 2 && w === 0) s.sourceId = s64(val);
    else rawPush(s, b, tagStart, end);
  }
  return s;
}
function encodeSource(s) {
  const w = new PW();
  w.str(1, s.name).vint(2, s.sourceId);
  const r = rawBytes(s); if (r) w.raw(r);
  return w.done();
}

/* Decodes manga AND, when the file carries one, the anime half at whichever root
   layout it uses. Everything not decoded is kept per-field in `rootRaw` so a
   caller can make its own decision about carrying it. */
function decodeBackup(buf) {
  const bk = { manga: [], categories: [], sources: [], rootFields: new Set(), rootRaw: new Map(),
               anime: [], animeCategories: [], animeSources: [], animeLayout: null };
  bk.animeLayout = detectAnimeLayout(buf);
  const A = bk.animeLayout ? ANIME_LAYOUT[bk.animeLayout] : null;
  for (const { f, w, val, tagStart, end } of pbFields(buf)) {
    bk.rootFields.add(f);
    if (f === 1 && w === 2) bk.manga.push(decodeManga(val, false));
    else if (f === 2 && w === 2) bk.categories.push(decodeCategory(val));
    else if (f === 101 && w === 2) bk.sources.push(decodeSource(val));
    else if (A && f === A.anime && w === 2) bk.anime.push(decodeManga(val, true));
    else if (A && f === A.cats && w === 2) bk.animeCategories.push(decodeCategory(val));
    else if (A && f === A.sources && w === 2) bk.animeSources.push(decodeSource(val));
    else { const a = bk.rootRaw.get(f); if (a) a.push(buf.subarray(tagStart, end)); else bk.rootRaw.set(f, [buf.subarray(tagStart, end)]); }
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
/* Counts fields >= min in a message and its nested chapters/episodes, for logging
   what a conversion carries. Mirrors stripHighFields' recursion into field 16. */
function countHighFields(msg, min) {
  let n = 0;
  for (const { f, w, val } of pbFields(msg)) {
    if (f >= min) n++;
    else if (f === 16 && w === 2) n += countHighFields(val, min);
  }
  return n;
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
  /* Aniyomi and Animetail both declare isLegacy at root 500 and pick their
     deserializer from it. Neither marks it @Required, so this is belt-and-braces —
     but Anikku's current Backup does, and stating it costs two bytes. Never write it
     for a low-layout target: Anikku's detector is `isLegacy` alone, defaulting true,
     and that default is what routes the file to LegacyBackup. */
  if (dst === 'x5') parts.push(varintBytes((500 << 3) | 0), varintBytes(0));
  let carried = 0;
  for (const { f, w, val } of pbFields(buf)) {
    const to = remap[f];
    if (to === undefined || w !== 2) continue;
    /* Nothing nested is stripped. ANIME_LAYOUT renumbers the *root* only; the
       anime and episode messages are identical across the three forks that use
       these layouts, including every field ≥500 — see AGENTS.md §2 for the table.
       This route previously ran stripHighFields(val, 500) here, which recursed into
       field 16 and deleted season links, background art, fillermarks, episode
       summaries and preview urls that the target declares and restores. */
    if (f === S.anime) carried += countHighFields(val, 500);
    parts.push(varintBytes((to << 3) | w), varintBytes(val.length), val);
  }
  if (!parts.length) throw new Error('Nothing to convert — no anime fields matched.');
  if (carried) log(`carried ${carried} season/background/fillermark fields ≥500 — both layouts declare them identically`, 'info');
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
  return buildKotatsu(bk, opts, kei, log);
}

/* Split out of convertToKotatsu so the merge engine can hand it an already-merged
   library instead of a freshly decoded one. `bk` only needs .manga, .categories and
   .sources in the decoded shape. */
async function buildKotatsu(bk, opts, kei, log) {
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
/* Kotatsu parser name -> Mihon source. Curated map via the Keiyoushi index, then the
   parser's own domains, then its title; falls back to computing an id from the curated
   name, which is flagged `weak` because it assumes versionId 1 and the caller's language.
   Extracted from convertFromKotatsu so the merge engine resolves sources identically. */
function makeMihonResolver(kei, opts) {
  const resolved = new Map();
  return function resolveMihon(parserName) {
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
  };
}

/* Read a Kotatsu zip into its JSON sections, keeping the untouched entries around
   so a Kotatsu -> Kotatsu merge can work on them directly instead of round-tripping
   through the Mihon-shaped model, which has no room for tags, rating, nsfw,
   alt_title or bookmark scroll/percent. */
async function readKotatsu(buf) {
  const entries = await zipRead(buf);
  const get = n => { const e = entries.find(x => x.name === n); return e ? jsonParseBig(TD.decode(e.data)) : null; };
  return {
    entries,
    names: entries.map(e => e.name),
    favourites: get('favourites') || [], history: get('history') || [],
    categories: get('categories') || [], bookmarks: get('bookmarks') || [],
  };
}

async function convertFromKotatsu(buf, opts, log) {
  const sec = await readKotatsu(buf);
  log(`zip sections: ${sec.names.join(', ')}`, 'info');
  const favourites = sec.favourites, histories = sec.history, cats = sec.categories;
  if (!favourites.length && !histories.length) throw new Error('No favourites or history found in this Kotatsu backup.');

  const kei = opts.useKeiyoushi ? await loadKeiyoushi(log).catch(e => { log('Keiyoushi fetch failed (' + e.message + ') — curated map only', 'warn'); return null; }) : null;

  const misses = new Map();
  const resolveMihon = makeMihonResolver(kei, opts);

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

/* ============================================================
   Merge engine — N backups from N devices into one target format
   ============================================================ */

/* Entry matching. Tier 1 is the only exact one; the looser tiers exist for
   cross-family merges, where a Kotatsu entry's source id has been *derived* rather
   than read, and its url shape need not match the Mihon one for the same site.
   Title matching is only ever allowed within one already-agreed source id — matching
   on title alone across sources is how you silently merge two different series. */
const normUrl = u => String(u || '').replace(/^https?:\/\//i, '').replace(/^[^/]*/, '').replace(/\/+$/, '').toLowerCase();
const normTitle = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SEP = '';
const keyExact = e => `${e.source}${SEP}${e.url || ''}`;
const keyUrl = e => `${e.source}${SEP}~${normUrl(e.url)}`;
const keyTitle = e => `${e.source}${SEP}#${normTitle(e.title)}`;

const isBlank = v => v === undefined || v === null || v === '';
const maxB = (a, b) => (a === undefined ? b : b === undefined ? a : (BigInt(a) > BigInt(b) ? a : b));
const minPosB = (a, b) => {
  if (a === undefined || BigInt(a) <= 0n) return b === undefined ? a : b;
  if (b === undefined || BigInt(b) <= 0n) return a;
  return BigInt(a) < BigInt(b) ? a : b;
};
const orBool = (a, b) => (a === undefined && b === undefined ? undefined : !!a || !!b);
const maxN = (a, b) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
const sumB = (a, b) => (a === undefined ? b : b === undefined ? a : BigInt(a) + BigInt(b));

/* Chapter/episode identity, loosest last. Chapter numbers are float32 on the wire,
   so they are compared on a fixed grid rather than with ===. */
const chapKeys = c => {
  const k = [];
  if (!isBlank(c.url)) { k.push('u' + c.url); k.push('n' + normUrl(c.url)); }
  if (c.chapterNumber !== undefined) k.push('c' + (c.scanlator || '') + '@' + Math.round(c.chapterNumber * 1e4));
  return k;
};

function mergeChapterInto(a, b) {
  if (isBlank(a.name)) a.name = b.name;
  if (isBlank(a.scanlator)) a.scanlator = b.scanlator;
  if (isBlank(a.url)) a.url = b.url;
  if (a.chapterNumber === undefined) a.chapterNumber = b.chapterNumber;
  a.read = orBool(a.read, b.read);
  a.bookmark = orBool(a.bookmark, b.bookmark);
  a.fillermark = orBool(a.fillermark, b.fillermark);
  a.lastPageRead = maxN(a.lastPageRead, b.lastPageRead);   /* field 6 is lastSecondSeen for episodes */
  a.totalSeconds = maxB(a.totalSeconds, b.totalSeconds);
  a.dateFetch = minPosB(a.dateFetch, b.dateFetch);
  if (a.dateUpload === undefined) a.dateUpload = b.dateUpload;
  a.lastModifiedAt = maxB(a.lastModifiedAt, b.lastModifiedAt);
  a.version = maxB(a.version, b.version);
  if (!a._raw && b._raw) a._raw = b._raw;
}

/* Union two chapter lists. sourceOrder is the *source site's* listing order and is
   meaningless across devices, so it is never recomputed from chapter numbers — doing
   that inverts the ordering for every site that lists newest first. Chapters only one
   device knew about are appended past the highest existing sourceOrder; an in-app
   library refresh restores the site's real ordering. */
function mergeChapters(a, b, stats) {
  if (!b.chapters.length) return;
  if (!a.chapters.length) { a.chapters = b.chapters; return; }
  const idx = new Map();
  for (const c of a.chapters) for (const k of chapKeys(c)) if (!idx.has(k)) idx.set(k, c);
  let maxOrder = -1;
  for (const c of a.chapters) if (typeof c.sourceOrder === 'number' && c.sourceOrder > maxOrder) maxOrder = c.sourceOrder;
  for (const c of b.chapters) {
    let hit = null;
    for (const k of chapKeys(c)) { const h = idx.get(k); if (h) { hit = h; break; } }
    if (hit) { mergeChapterInto(hit, c); stats.chapMerged++; }
    else {
      const copy = { ...c };
      if (copy.sourceOrder !== undefined) copy.sourceOrder = ++maxOrder;
      a.chapters.push(copy);
      for (const k of chapKeys(copy)) if (!idx.has(k)) idx.set(k, copy);
      stats.chapAdded++;
    }
  }
}

function mergeHistory(a, b) {
  if (!b.history.length) return;
  if (!a.history.length) { a.history = b.history; return; }
  const idx = new Map();
  for (const h of a.history) idx.set(normUrl(h.url), h);
  for (const h of b.history) {
    const hit = idx.get(normUrl(h.url));
    if (hit) {
      hit.lastRead = maxB(hit.lastRead, h.lastRead);
      hit.readDuration = sumB(hit.readDuration, h.readDuration);
    } else { a.history.push(h); idx.set(normUrl(h.url), h); }
  }
}

/* `a` is the higher-priority entry (from a file the user placed earlier in the list)
   and keeps every field it actually has; `b` fills gaps and contributes progress.
   Read state is a union in both directions on purpose: a chapter read on any device
   is read. */
function mergeEntryInto(a, b, stats) {
  for (const k of ['url', 'title', 'artist', 'author', 'description', 'thumbnailUrl']) {
    if (isBlank(a[k]) && !isBlank(b[k])) a[k] = b[k];
  }
  if (a.status === undefined || a.status === 0) a.status = b.status;
  if (!a.genre.length && b.genre.length) a.genre = b.genre;
  a.favorite = orBool(a.favorite, b.favorite);
  a.dateAdded = minPosB(a.dateAdded, b.dateAdded);
  a.lastModifiedAt = maxB(a.lastModifiedAt, b.lastModifiedAt);
  a.favoriteModifiedAt = maxB(a.favoriteModifiedAt, b.favoriteModifiedAt);
  a.version = maxB(a.version, b.version);
  for (const n of b._cats) a._cats.add(n);
  if (!a._raw && b._raw) a._raw = b._raw;
  mergeChapters(a, b, stats);
  mergeHistory(a, b);
}

/* Merge one kind (manga or anime) across N already-normalised libraries.
   `libs` is in priority order: index 0 wins every metadata conflict. */
function mergeKind(libs, kindKey, log) {
  const out = [];
  const exact = new Map(), byUrl = new Map(), byTitle = new Map();
  const seasonOwner = new Map();
  const stats = { in: 0, merged: 0, chapMerged: 0, chapAdded: 0, byUrlHits: 0, byTitleHits: 0, noSource: 0 };

  for (const lib of libs) {
    for (const e of lib[kindKey]) {
      stats.in++;
      if (e.source === undefined) { stats.noSource++; continue; }
      let hit = exact.get(keyExact(e));
      if (!hit) { hit = byUrl.get(keyUrl(e)); if (hit) stats.byUrlHits++; }
      /* Title fallback is reserved for entries whose source id was derived rather
         than read out of a backup — i.e. anything that came from a Kotatsu zip. */
      if (!hit && e._derivedSource) { hit = byTitle.get(keyTitle(e)); if (hit) stats.byTitleHits++; }
      if (hit) {
        mergeEntryInto(hit, e, stats);
        stats.merged++;
        if (e.seasonId !== undefined) seasonOwner.set(e._ns + ':' + e.seasonId, hit);
        continue;
      }
      out.push(e);
      exact.set(keyExact(e), e);
      if (!byUrl.has(keyUrl(e))) byUrl.set(keyUrl(e), e);
      if (!byTitle.has(keyTitle(e))) byTitle.set(keyTitle(e), e);
      if (e.seasonId !== undefined) seasonOwner.set(e._ns + ':' + e.seasonId, e);
    }
  }
  if (stats.noSource) log(`${stats.noSource} ${kindKey} skipped — no source id, so nothing to match or restore against`, 'warn');
  if (stats.byUrlHits) log(`${stats.byUrlHits} ${kindKey} matched on a normalised url rather than an exact one`, 'info');
  if (stats.byTitleHits) log(`${stats.byTitleHits} ${kindKey} matched on title within the same source — verify these after restoring`, 'warn');
  return { entries: out, seasonOwner, stats };
}

/* Season ids (BackupAnime 502 parentId / 503 id) are device-local row ids. Unioning
   two devices' anime would otherwise let device B's id collide with device A's and
   silently re-parent a season under the wrong show — the same shape of bug as joining
   categories on id instead of order (AGENTS.md §8). Every id is renumbered from
   scratch here, and a parent that did not survive the merge is dropped rather than
   left pointing at whatever now holds that number. */
function renumberSeasons(entries, seasonOwner, log) {
  let next = 1n, orphan = 0;
  for (const e of entries) if (e.seasonId !== undefined) e._freshSeasonId = next++;
  for (const e of entries) {
    if (e.seasonParentId === undefined) continue;
    const owner = seasonOwner.get(e._ns + ':' + e.seasonParentId);
    if (owner && owner._freshSeasonId !== undefined) e._freshParentId = owner._freshSeasonId;
    else orphan++;
  }
  for (const e of entries) {
    if (e.seasonId !== undefined) e.seasonId = e._freshSeasonId;
    if (e.seasonParentId !== undefined) e.seasonParentId = e._freshParentId;
  }
  if (next > 1n) log(`renumbered ${next - 1n} season ids so entries from different devices cannot collide`, 'info');
  if (orphan) log(`${orphan} season links dropped — their parent entry is not in the merge`, 'warn');
}

/* Categories merge by name, because that is what Mihon's restorer matches on. Two
   categories differing only in case are distinct there, so they stay distinct here
   unless the caller opts in. Order is reassigned from array position — never carried
   across — and field 17 on every entry is rewritten from it. */
function mergeCategories(libs, listKey, caseFold, log) {
  const out = [], seen = new Map();
  const key = n => (caseFold ? String(n).toLowerCase() : String(n));
  for (const lib of libs) {
    for (const c of lib[listKey]) {
      const name = c.name || 'Category';
      const k = key(name);
      if (seen.has(k)) {
        const prev = seen.get(k);
        if (prev.flags === undefined && c.flags !== undefined) prev.flags = c.flags;
        continue;
      }
      const rec = { name, flags: c.flags, _raw: c._raw };
      seen.set(k, rec); out.push(rec);
    }
  }
  out.forEach((c, i) => { c.order = i; c.id = i + 1; });
  if (out.length) log(`${out.length} ${listKey === 'categories' ? '' : 'anime '}categories after merge: ${out.map(c => c.name).join(', ')}`, 'info');
  return out;
}

/* ---------- source id aliases ---------- */
/* One source, several ids. TachiyomiSY keeps E-Hentai and ExHentai on its own
   internal ids — `LEWD_SOURCE_SERIES + 1/+2`, i.e. 6901 and 6902 — while Komikku
   moved them onto the ids of the `all.ehentai` extension, one per language, and
   registers its built-in EHentai source under every one of them. Merging an SY
   library with a Komikku one therefore produced two of every gallery: same url,
   different source id, so nothing matched.

   Verified against each project's own source-api/.../exh/source/SourceIds.kt.
   SY and Komikku already agree on Pururin, Tsumino, 8Muses and HBrowse, so those
   need no alias; the three `*_OLD_ID` values below are pre-migration Tachiyomi ids
   that Komikku still rewrites on restore (EXHMigrations.kt) and that old backups
   can still carry.

   The per-language ids are computed rather than copied. 35 of the 36 in Komikku's
   tables are exactly `mihonSourceId(name, lang, 1)`; the 36th is 7151438547982231541,
   which Komikku lists under **both** E-Hentai and ExHentai for pt-BR and which
   matches neither computed value — an upstream copy-paste slip. It is deliberately
   left unaliased: which of the two it means is genuinely ambiguous, and per §7 a
   wrong match is worse than a missed one. */
const EH_LANGS = ['all', 'en', 'ja', 'zh', 'nl', 'fr', 'de', 'hu', 'it', 'ko',
                  'pl', 'pt-BR', 'ru', 'es', 'th', 'vi', 'none', 'other'];
const SOURCE_EQUIV = [
  { key: 'ehentai',  label: 'E-Hentai', ext: 'E-Hentai', sy: 6901n },
  { key: 'exhentai', label: 'ExHentai', ext: 'ExHentai', sy: 6902n },
  { key: 'nhentai',  label: 'NHentai',  canon: 7309872737163460316n, legacy: [6907n] },
  { key: 'tsumino',  label: 'Tsumino',  canon: 6707338697138388238n, legacy: [6909n] },
  { key: 'hbrowse',  label: 'HBrowse',  canon: 1401584337232758222n, legacy: [6912n] },
];
const SOURCE_ALIAS = (() => {
  const byId = new Map();
  for (const e of SOURCE_EQUIV) {
    if (!e.canon) e.canon = mihonSourceId(e.ext, 'all', 1);
    const ids = new Set([e.canon.toString()]);
    if (e.ext) for (const l of EH_LANGS) ids.add(mihonSourceId(e.ext, l, 1).toString());
    if (e.sy !== undefined) ids.add(e.sy.toString());
    for (const l of (e.legacy || [])) ids.add(l.toString());
    for (const id of ids) byId.set(id, e);
  }
  return byId;
})();
const aliasOf = id => (id === undefined || id === null ? null : SOURCE_ALIAS.get(id.toString()) || null);

/* Which id to actually write, which is app-specific: SY's built-in source only
   answers to 6901/6902, so writing the extension id into an SY backup would leave
   every one of those entries pointing at a source it does not have. Everyone else
   reaches E-Hentai through the extension, and Komikku migrates 6901/6902 anyway. */
function sourceIdFor(entry, target) {
  if (target === 'sy' && entry.sy !== undefined) return entry.sy;
  return entry.canon;
}

/* Collapse aliased ids to one canonical value before anything is matched on them.
   Runs across every library at once so the log can say how many ids a source
   actually turned up under. */
function canonicaliseSources(libs, log) {
  const hits = new Map();
  const touch = e => {
    const al = aliasOf(e.source);
    if (!al) return;
    let h = hits.get(al.key);
    if (!h) { h = { entry: al, ids: new Set(), n: 0 }; hits.set(al.key, h); }
    h.ids.add(e.source.toString());
    h.n++;
    e.source = al.canon;
  };
  for (const lib of libs) {
    for (const e of lib.manga) touch(e);
    for (const e of lib.anime) touch(e);
    for (const list of [lib.sources, lib.animeSources]) {
      for (const s of list) { const al = aliasOf(s.sourceId); if (al) { s.sourceId = al.canon; s.name = s.name || al.label; } }
    }
  }
  for (const h of hits.values()) {
    if (h.ids.size > 1) {
      log(`${h.entry.label} appeared under ${h.ids.size} different source ids (${[...h.ids].join(', ')}) — treated as one source`, 'info');
    }
  }
}

/* ---------- ingestion ---------- */

/* Category membership is carried as a set of *names* through the whole merge. Field
   17 holds each category's order — its position in that backup's own list — and
   those positions mean different things in different files, so they are resolved to
   names on the way in and back to fresh positions on the way out (AGENTS.md §8). */
function libFromBackup(bk, ns) {
  const orderToName = new Map(), aOrderToName = new Map();
  for (const c of bk.categories) if (!orderToName.has(c.order || 0)) orderToName.set(c.order || 0, c.name || 'Category');
  for (const c of bk.animeCategories) if (!aOrderToName.has(c.order || 0)) aOrderToName.set(c.order || 0, c.name || 'Category');
  const tag = (list, map, isAnime) => {
    for (const e of list) {
      e._ns = ns;
      e._cats = new Set(e.categories.map(o => map.get(o)).filter(Boolean));
      e._anime = !!isAnime;
      e._fromAnimeFile = !!bk.animeLayout;
    }
    return list;
  };
  return {
    manga: tag(bk.manga, orderToName, false),
    anime: tag(bk.anime, aOrderToName, true),
    categories: bk.categories, animeCategories: bk.animeCategories,
    sources: bk.sources, animeSources: bk.animeSources,
    rootRaw: bk.rootRaw, animeLayout: bk.animeLayout,
  };
}

/* A Kotatsu zip rendered into the Mihon-shaped model. Source ids are *derived* here
   (see makeMihonResolver), which is why every entry is flagged `_derivedSource`: the
   merge engine may fall back to title matching for these, and only these. Kotatsu
   stores no chapter lists, so these entries never contribute chapters — and
   mergeChapters is written so an empty list can never clear a populated one. */
function libFromKotatsu(sec, ns, opts, kei, log) {
  const resolveMihon = makeMihonResolver(kei, opts);
  const byManga = new Map(), misses = new Map();
  const take = km => {
    const k = String(km.id);
    if (!byManga.has(k)) byManga.set(k, { km, cats: new Set(), lastRead: 0n, dateAdded: 0n });
    return byManga.get(k);
  };
  for (const f of sec.favourites) { const e = take(f.manga || {}); if (f.category_id != null) e.cats.add(bigOf(f.category_id)); if (f.created_at) e.dateAdded = bigOf(f.created_at); }
  for (const h of sec.history) { const e = take(h.manga || {}); const t = bigOf(h.updated_at); if (t > e.lastRead) e.lastRead = t; if (!e.dateAdded && h.created_at) e.dateAdded = bigOf(h.created_at); }

  const sortedCats = [...sec.categories].sort((a, b) => Number(bigOf(a.sort_key) - bigOf(b.sort_key)));
  const catIdToName = new Map();
  for (const c of sortedCats) catIdToName.set(String(bigOf(c.category_id)), c.title || 'Category');

  const manga = [], sources = [], usedSources = new Map();
  let dropped = 0, weak = 0;
  for (const { km, cats, lastRead, dateAdded } of byManga.values()) {
    const hit = resolveMihon(km.source || '');
    if (!hit) {
      misses.set(km.source || '?', (misses.get(km.source || '?') || 0) + 1);
      if (!opts.keepUnmatched) { dropped++; continue; }
    }
    const sid = hit ? hit.id : mihonSourceId(km.source || 'unknown', opts.lang || 'en', 1);
    const sname = hit ? hit.name : (km.source || 'unknown');
    if (hit && hit.weak) weak++;
    usedSources.set(sid.toString(), sname);
    manga.push({
      source: sid, url: km.url || '', title: km.title || '',
      author: km.author || undefined, thumbnailUrl: km.cover_url || undefined,
      genre: [], chapters: [], categories: [], history: [],
      dateAdded: dateAdded || 0n, favorite: true, lastModifiedAt: lastRead || dateAdded || 0n, version: 1n,
      _ns: ns, _anime: false, _derivedSource: true, _fromAnimeFile: false,
      _cats: new Set([...cats].map(c => catIdToName.get(String(c))).filter(Boolean)),
    });
  }
  for (const [id, name] of usedSources) sources.push({ name, sourceId: BigInt(id) });
  if (weak) log(`${weak} Kotatsu sources resolved from the curated map only — verify them after import`, 'warn');
  if (misses.size) log(`${dropped} Kotatsu entries skipped — no Mihon source for: ${[...misses.keys()].slice(0, 8).join(', ')}${misses.size > 8 ? ` (+${misses.size - 8} more)` : ''}`, 'warn');
  return {
    manga, anime: [],
    categories: sortedCats.map((c, i) => ({ name: c.title || 'Category', order: i, id: i + 1 })),
    animeCategories: [], sources, animeSources: [], rootRaw: new Map(), animeLayout: null,
  };
}

/* Identify a dropped file without asking the user to name its app: the format, and
   for protobuf the anime layout, are both readable from the bytes. */
async function inspectBackup(bytes, name) {
  if (isZip(bytes)) {
    const sec = await readKotatsu(bytes);
    const ids = new Set(sec.favourites.map(f => String((f.manga || {}).id)));
    for (const h of sec.history) ids.add(String((h.manga || {}).id));
    return { name, fam: 'kotatsu', sec, manga: ids.size, anime: 0, animeLayout: null, label: 'Kotatsu / Usagi' };
  }
  let data = bytes;
  if (isGzip(bytes)) data = await gunzip(bytes);
  const bk = decodeBackup(data);
  if (!bk.manga.length && !bk.anime.length) throw new Error(`No manga or anime found in ${name} — is it a backup file?`);
  const label = bk.animeLayout === 'x5'
    ? (bk.manga.length ? 'Aniyomi / Animetail' : 'Anikku (501–506 layout)')
    : bk.animeLayout === 'low' ? 'Anikku / legacy Aniyomi' : 'Mihon family';
  return { name, fam: 'tachi', bk, manga: bk.manga.length, anime: bk.anime.length, animeLayout: bk.animeLayout, label };
}

/* ---------- output ---------- */

/* Root fields the merged output may contain, and the assertion that it does. Getting
   this wrong is not cosmetic: Aniyomi picks between its current and legacy
   serializers on `isLegacy && backupAnimeSources(103).isNotEmpty()`, so a file mixing
   the two anime layouts is decoded with the wrong serializer and read as garbage
   rather than rejected. */
function allowedRoots(target, layout) {
  const set = new Set(APPS[target].root || []);
  if (layout) {
    const L = ANIME_LAYOUT[layout];
    for (const k of ['anime', 'cats', 'sources']) set.add(L[k]);
    if (layout === 'x5') set.add(500);
  }
  return set;
}
function verifyTachiRoots(buf, target, layout) {
  const allow = allowedRoots(target, layout);
  const seen = new Set();
  for (const { f } of pbFields(buf)) seen.add(f);
  const bad = [...seen].filter(f => !allow.has(f));
  if (bad.length) throw new Error(`internal: merged output has root fields ${bad.join(', ')} that ${APPS[target].label} does not declare`);
  if (layout) {
    const other = layout === 'x5' ? ANIME_LAYOUT.low : ANIME_LAYOUT.x5;
    const leak = [other.anime, other.cats, other.sources].filter(f => seen.has(f) && !allow.has(f));
    if (leak.length) throw new Error(`internal: merged output mixes anime layouts (stray fields ${leak.join(', ')})`);
  }
  return seen;
}

/* Mihon, Komikku and TachiyomiSY declare field 106 as BackupExtensionStore. Aniyomi
   declares the same number as BackupExtensionRepos, and legacy Aniyomi as
   BackupExtensions — three incompatible messages on one number (AGENTS.md §2). A
   merge has no single "from" app to reason from, so 106 is never carried across; the
   Keiyoushi store is emitted fresh for the forks whose shape is confirmed. */
const EXT_STORE_APPS = new Set(['mihon', 'komikku', 'sy']);

function buildMergedTachi(merged, target, opts, log) {
  const app = APPS[target];
  const root = new PW();
  const rootSet = new Set(app.root || []);
  const wantManga = rootSet.has(1) && app.kinds.includes('manga');
  const wantAnime = !!app.anime && app.kinds.includes('anime');
  const layout = wantAnime ? (target === 'anikku' && opts.anikkuModern ? 'x5' : app.anime) : null;

  if (!wantManga && merged.manga.length) log(`skipped ${merged.manga.length} manga — ${app.label} does not store manga`, 'warn');
  if (!wantAnime && merged.anime.length) log(`skipped ${merged.anime.length} anime — ${app.label} does not store anime`, 'warn');
  if ((!wantManga || !merged.manga.length) && (!wantAnime || !merged.anime.length)) {
    throw new Error(`Nothing left to write: ${app.label} stores ${app.kinds.join(' + ')}, and the merged inputs have none of that.`);
  }

  /* Aniyomi's current Backup declares isLegacy at 500 and Anikku's marks it
     @Required — an x5 file without it fails to deserialize on Anikku outright. */
  if (layout === 'x5') root.bool(500, false);

  /* Canonical ids are an internal convention; each app gets the id it can actually
     resolve. Applied to entries and to the source list together so the two agree. */
  const outId = id => { const al = aliasOf(id); return al ? sourceIdFor(al, target) : id; };
  const retarget = list => {
    const out = new Map();
    for (const [id, name] of list) {
      const al = aliasOf(BigInt(id));
      const k = outId(BigInt(id)).toString();
      if (!out.get(k)) out.set(k, al ? al.label : name);
    }
    return out;
  };
  for (const e of merged.manga) e.source = outId(e.source);
  for (const e of merged.anime) e.source = outId(e.source);
  merged.sources = retarget(merged.sources);
  merged.animeSources = retarget(merged.animeSources);
  if (target === 'sy') log('E-Hentai and ExHentai written with TachiyomiSY\u2019s internal ids (6901/6902)', 'info');

  if (wantManga) {
    const catOrder = new Map(merged.categories.map((c, i) => [c.name, i]));
    let highStripped = 0;
    for (const m of merged.manga) {
      m.categories = [...m._cats].map(n => catOrder.get(n)).filter(o => o !== undefined).sort((a, b) => a - b);
      const dropHigh = !app.kinds.includes('anime') && m._fromAnimeFile;
      if (dropHigh && rawDropped(m, 500).length) highStripped++;
      root.msg(1, encodeManga(m, false, dropHigh));
    }
    log(`wrote ${merged.manga.length} manga`, 'success');
    if (highStripped) log(`stripped fork-specific fields ≥500 inside ${highStripped} manga`, 'warn');
    if (rootSet.has(2)) for (const c of merged.categories) root.msg(2, encodeCategory(c));
    if (rootSet.has(101)) for (const [id, name] of merged.sources) root.msg(101, encodeSource({ name, sourceId: BigInt(id) }));
    else if (merged.sources.size) log(`${app.label} has no source list — sources are not carried`, 'warn');
  }

  if (wantAnime && merged.anime.length) {
    const L = ANIME_LAYOUT[layout];
    const catOrder = new Map(merged.animeCategories.map((c, i) => [c.name, i]));
    /* ANIME_LAYOUT describes *root* numbering only. Anikku's nested BackupManga and
       BackupChapter declare 500 and 502–507 exactly as Aniyomi's BackupAnime and
       BackupEpisode do — backgroundUrl, season linkage, fillermark, summary,
       previewUrl — so nothing ≥500 is stripped on the way into the low layout.
       (convertTachiAnime does strip them, and is wrong to; see AGENTS.md §2.) */
    for (const a of merged.anime) {
      a.categories = [...a._cats].map(n => catOrder.get(n)).filter(o => o !== undefined).sort((x, y) => x - y);
      root.msg(L.anime, encodeManga(a, true, false));
    }
    log(`wrote ${merged.anime.length} anime in the ${layout === 'x5' ? '501–506' : '3/4/103'} layout`, 'success');
    for (const c of merged.animeCategories) root.msg(L.cats, encodeCategory(c));
    for (const [id, name] of merged.animeSources) root.msg(L.sources, encodeSource({ name, sourceId: BigInt(id) }));
  }

  /* Preferences are opaque key/value blobs with no merge semantics, so they come
     from the highest-priority input that has them rather than being interleaved. */
  for (const f of [104, 105]) {
    if (!rootSet.has(f)) continue;
    const src = merged.rootRaw.get(f);
    if (!src) continue;
    for (const slice of src.slices) root.raw(slice);
    log(`carried ${ROOT_NAMES[f]} from ${src.from}`, 'info');
    if (src.others) log(`${ROOT_NAMES[f]} from ${src.others} other backup${src.others > 1 ? 's' : ''} discarded — settings cannot be merged`, 'warn');
  }
  if (rootSet.has(106) && EXT_STORE_APPS.has(target)) {
    const store = new PW();
    store.str(1, KEIYOUSHI_STORE.indexUrl).str(2, KEIYOUSHI_STORE.name).str(3, KEIYOUSHI_STORE.badgeLabel)
         .str(4, KEIYOUSHI_STORE.contactWebsite).str(5, KEIYOUSHI_STORE.signingKey).bool(7, true);
    root.msg(106, store.done());
    log('added the Keiyoushi extension store so extensions install without trust prompts', 'info');
  } else if (merged.hadExtField) {
    log('extension repo lists are not carried through a merge — field 106 is a different message in each fork', 'warn');
  }

  const out = root.done();
  verifyTachiRoots(out, target, layout);
  return out;
}

/* Kotatsu into Kotatsu keeps the JSON sections rather than going through the
   Mihon-shaped model, which has no room for tags, rating, nsfw, alt_title or a
   bookmark's scroll/percent. Entries are keyed on Kotatsu's own manga id, a hash of
   (parser name, url) and therefore already stable across devices. */
async function mergeKotatsuSections(inputs, opts, log) {
  const favByKey = new Map(), histById = new Map(), catByTitle = new Map(), bmById = new Map();
  let nextCat = CAT_OFFSET;
  const catIdRemap = inputs.map(inp => {
    const map = new Map();
    for (const c of inp.sec.categories) {
      const title = c.title || 'Category';
      const k = opts.caseFoldCats ? title.toLowerCase() : title;
      if (!catByTitle.has(k)) catByTitle.set(k, { ...c, category_id: nextCat++, title, sort_key: catByTitle.size });
      map.set(String(bigOf(c.category_id)), catByTitle.get(k).category_id);
    }
    return map;
  });
  inputs.forEach((inp, i) => {
    const map = catIdRemap[i];
    for (const f of inp.sec.favourites) {
      /* A favourite can point at a category the zip never declared. Keeping its raw
         id risks colliding with one this merge just handed out, so it falls back to
         Kotatsu's always-present default category instead. */
      const cid = map.get(String(bigOf(f.category_id)));
      const resolved = cid === undefined ? CAT_DEFAULT : cid;
      const k = bigOf((f.manga || {}).id) + '|' + resolved;
      if (favByKey.has(k)) continue;
      favByKey.set(k, { ...f, category_id: resolved });
    }
    for (const h of inp.sec.history) {
      const id = String(bigOf((h.manga || {}).id));
      const prev = histById.get(id);
      if (!prev) { histById.set(id, { ...h }); continue; }
      const created = minPosB(bigOf(prev.created_at), bigOf(h.created_at));
      if (bigOf(h.updated_at) > bigOf(prev.updated_at)) histById.set(id, { ...h, created_at: created });
      else prev.created_at = created;
    }
    for (const b of inp.sec.bookmarks) {
      const id = String(bigOf((b.manga || {}).id));
      const prev = bmById.get(id);
      if (!prev) { bmById.set(id, { ...b, bookmarks: [...(b.bookmarks || [])] }); continue; }
      const seen = new Set(prev.bookmarks.map(x => String(bigOf(x.chapter_id)) + '/' + x.page));
      for (const x of (b.bookmarks || [])) {
        const k = String(bigOf(x.chapter_id)) + '/' + x.page;
        if (!seen.has(k)) { prev.bookmarks.push(x); seen.add(k); }
      }
    }
  });
  const categories = [...catByTitle.values()];
  const favourites = [...favByKey.values()], history = [...histById.values()], bookmarks = [...bmById.values()];
  if (!favourites.length && !history.length) throw new Error('Nothing to merge — no favourites or history in any input.');
  log(`merged ${favourites.length} favourites, ${history.length} history entries, ${categories.length} categories, ${bookmarks.length} bookmark sets`, 'success');
  const files = [];
  const add = (name, arr) => { if (arr.length) files.push({ name, data: TE.encode(jsonDump(arr)) }); };
  add('history', history); add('categories', categories); add('favourites', favourites); add('bookmarks', bookmarks);
  files.push({ name: 'index', data: TE.encode(jsonDump([{ app_id: 'dev.7he.tachibk', app_version: 1, created_at: Date.now() }])) });
  return zipWrite(files);
}

/* ---------- merge driver ---------- */

/* `inputs` are inspectBackup() results in priority order — the first file wins every
   metadata conflict. Everything else (read state, bookmarks, category membership,
   chapter lists) is a union, so no device's progress is lost to another's. */
async function runMerge(inputs, target, opts, log) {
  if (!inputs.length) throw new Error('Add at least one backup to merge.');
  const app = APPS[target];
  if (!app) throw new Error('Unknown target app.');
  log(`merging ${inputs.length} backup${inputs.length > 1 ? 's' : ''} into ${app.label}`, 'info');
  inputs.forEach((i, n) => log(`#${n + 1} ${i.name} — ${i.label}, ${i.manga} manga, ${i.anime} anime`, 'info'));

  if (app.fam === 'kotatsu' && inputs.every(i => i.fam === 'kotatsu')) return mergeKotatsuSections(inputs, opts, log);
  if (app.fam === 'kotatsu') log('some inputs are not Kotatsu backups — merging through the shared model', 'info');

  const needKei = opts.useKeiyoushi && (app.fam === 'kotatsu' || inputs.some(i => i.fam === 'kotatsu'));
  const kei = needKei
    ? await loadKeiyoushi(log).catch(e => { log('Keiyoushi fetch failed (' + e.message + ') — offline matching only', 'warn'); return null; })
    : null;

  const libs = inputs.map((inp, ns) => inp.fam === 'kotatsu'
    ? libFromKotatsu(inp.sec, ns, opts, kei, log)
    : libFromBackup(inp.bk, ns));

  canonicaliseSources(libs, log);

  const mangaMerge = mergeKind(libs, 'manga', log);
  const animeMerge = mergeKind(libs, 'anime', log);
  renumberSeasons(animeMerge.entries, animeMerge.seasonOwner, log);

  const dupM = mangaMerge.stats.in - mangaMerge.entries.length;
  const dupA = animeMerge.stats.in - animeMerge.entries.length;
  log(`manga: ${mangaMerge.stats.in} in, ${mangaMerge.entries.length} out (${dupM} duplicate${dupM === 1 ? '' : 's'} merged)`, 'info');
  if (animeMerge.stats.in) log(`anime: ${animeMerge.stats.in} in, ${animeMerge.entries.length} out (${dupA} duplicate${dupA === 1 ? '' : 's'} merged)`, 'info');
  if (mangaMerge.stats.chapMerged || mangaMerge.stats.chapAdded) log(`chapters: ${mangaMerge.stats.chapMerged} reconciled, ${mangaMerge.stats.chapAdded} added from another device`, 'info');
  if (animeMerge.stats.chapMerged || animeMerge.stats.chapAdded) log(`episodes: ${animeMerge.stats.chapMerged} reconciled, ${animeMerge.stats.chapAdded} added from another device`, 'info');
  if (mangaMerge.stats.chapAdded || animeMerge.stats.chapAdded) log('refresh your library in-app afterwards to restore each source’s own chapter ordering', 'warn');

  const sources = new Map(), animeSources = new Map();
  let hadExtField = false;
  const takeSrc = (map, s) => {
    if (s.sourceId === undefined) return;
    const k = s.sourceId.toString();
    if (!map.get(k)) map.set(k, s.name || '');
  };
  for (const lib of libs) {
    for (const s of lib.sources) takeSrc(sources, s);
    for (const s of lib.animeSources) takeSrc(animeSources, s);
    if (lib.rootRaw && (lib.rootRaw.has(106) || lib.rootRaw.has(108))) hadExtField = true;
  }

  const rootRaw = new Map();
  for (const f of [104, 105]) {
    let chosen = null, others = 0;
    libs.forEach((lib, i) => {
      const slices = lib.rootRaw && lib.rootRaw.get(f);
      if (!slices) return;
      if (chosen) others++; else chosen = { slices, from: inputs[i].name };
    });
    if (chosen) rootRaw.set(f, { ...chosen, others });
  }

  const merged = {
    manga: mangaMerge.entries, anime: animeMerge.entries,
    categories: mergeCategories(libs, 'categories', !!opts.caseFoldCats, log),
    animeCategories: mergeCategories(libs, 'animeCategories', !!opts.caseFoldCats, log),
    sources, animeSources, rootRaw, hadExtField,
  };

  if (app.fam === 'kotatsu') {
    if (merged.anime.length) log(`skipped ${merged.anime.length} anime — ${app.label} does not store anime`, 'warn');
    const catOrder = new Map(merged.categories.map((c, i) => [c.name, i]));
    const outId = id => { const al = aliasOf(id); return al ? sourceIdFor(al, target) : id; };
    const bk = {
      manga: merged.manga.map(m => ({ ...m, source: outId(m.source), categories: [...m._cats].map(n => catOrder.get(n)).filter(o => o !== undefined) })),
      categories: merged.categories,
      sources: [...merged.sources].map(([id, name]) => ({ name, sourceId: BigInt(id) })),
    };
    return buildKotatsu(bk, opts, kei, log);
  }

  const out = buildMergedTachi(merged, target, opts, log);
  log(`protobuf: ${fmtBytes(out.length)} — compressing`, 'info');
  const gz = await gzip(out);
  log(`output: ${fmtBytes(gz.length)}`, 'success');
  return gz;
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
