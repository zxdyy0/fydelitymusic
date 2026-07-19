// metadata.js
// Reads real embedded title/artist/album tags directly from audio file
// bytes — no server, no library, just parsing the same binary tag formats
// every media player reads. Only small slices of each file are read (not
// the whole file), so this stays fast even for large libraries.
//
// Formats covered: FLAC (Vorbis comments), MP3 (ID3v2.2/2.3/2.4), M4A/AAC
// (MP4 atom metadata — the iTunes-style ©nam/©ART/©alb boxes).
// Not covered (falls back to filename): WAV, APE, OGG. WAV/APE tagging is
// inconsistent enough across rippers that it wasn't worth the added
// complexity for v1; can be added later if it turns out to matter.

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('windows-1252');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

async function readSlice(file, start, end) {
  const blob = file.slice(start, Math.min(end, file.size));
  return blob.arrayBuffer();
}

function cleanTagValue(v) {
  if (!v) return '';
  return v.replace(/\u0000+$/, '').trim();
}

// --------------------------------------------------------------------------
// FLAC — Vorbis comments
// --------------------------------------------------------------------------
async function readFlacTags(file) {
  // Metadata blocks (including a possible cover-art PICTURE block) almost
  // always fit well within the first couple MB, even for large embedded
  // artwork. If they don't, we just return whatever we found before running
  // out of buffer — filename fallback covers the rest.
  const READ_WINDOW = Math.min(file.size, 2 * 1024 * 1024);
  const buf = await readSlice(file, 0, READ_WINDOW);
  const view = new DataView(buf);
  if (buf.byteLength < 4 || utf8.decode(buf.slice(0, 4)) !== 'fLaC') return null;

  let offset = 4;
  const tags = {};
  while (offset + 4 <= buf.byteLength) {
    const header = view.getUint8(offset);
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockLen = (view.getUint8(offset + 1) << 16) | (view.getUint8(offset + 2) << 8) | view.getUint8(offset + 3);
    const blockStart = offset + 4;
    if (blockType === 4 && blockStart + blockLen <= buf.byteLength) {
      // VORBIS_COMMENT block, all fields little-endian
      let p = blockStart;
      const vendorLen = view.getUint32(p, true); p += 4 + vendorLen;
      if (p + 4 <= buf.byteLength) {
        const count = view.getUint32(p, true); p += 4;
        for (let i = 0; i < count && p + 4 <= buf.byteLength; i++) {
          const len = view.getUint32(p, true); p += 4;
          if (p + len > buf.byteLength) break;
          const entry = utf8.decode(buf.slice(p, p + len));
          p += len;
          const eq = entry.indexOf('=');
          if (eq > 0) {
            const key = entry.slice(0, eq).toUpperCase();
            const value = entry.slice(eq + 1);
            if (key === 'TITLE' && !tags.title) tags.title = value;
            else if (key === 'ARTIST' && !tags.artist) tags.artist = value;
            else if (key === 'ALBUM' && !tags.album) tags.album = value;
          }
        }
      }
    }
    if (blockType === 6 && blockStart + blockLen > buf.byteLength) {
      // A cover-art PICTURE block extends past our read window — nothing
      // more to safely parse (comments could theoretically follow it, but
      // this is rare in practice; standard encoders put VORBIS_COMMENT
      // before PICTURE).
      break;
    }
    offset = blockStart + blockLen;
    if (isLast) break;
  }
  return Object.keys(tags).length ? tags : null;
}

// --------------------------------------------------------------------------
// MP3 — ID3v2 (v2.2 / v2.3 / v2.4)
// --------------------------------------------------------------------------
function decodeId3Text(bytes) {
  if (bytes.length === 0) return '';
  const enc = bytes[0];
  const rest = bytes.slice(1);
  try {
    if (enc === 0x00) return cleanTagValue(latin1.decode(rest));
    if (enc === 0x01) {
      // UTF-16 with BOM — detect endianness from the first two bytes
      if (rest.length >= 2 && rest[0] === 0xff && rest[1] === 0xfe) return cleanTagValue(utf16le.decode(rest.slice(2)));
      if (rest.length >= 2 && rest[0] === 0xfe && rest[1] === 0xff) return cleanTagValue(utf16be.decode(rest.slice(2)));
      return cleanTagValue(utf16le.decode(rest));
    }
    if (enc === 0x02) return cleanTagValue(utf16be.decode(rest));
    if (enc === 0x03) return cleanTagValue(utf8.decode(rest));
  } catch (_) { /* fall through to latin1 best-effort below */ }
  return cleanTagValue(latin1.decode(rest));
}

async function readId3Tags(file) {
  const headerBuf = await readSlice(file, 0, 10);
  if (headerBuf.byteLength < 10) return null;
  const h = new Uint8Array(headerBuf);
  if (h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return null; // "ID3"
  const majorVersion = h[3];
  // Syncsafe size: 4 bytes, 7 usable bits each
  const tagSize = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
  if (tagSize <= 0) return null;

  const buf = await readSlice(file, 10, 10 + tagSize);
  const bytes = new Uint8Array(buf);
  const tags = {};

  if (majorVersion === 2) {
    // ID3v2.2: 3-char frame IDs, 3-byte sizes, no frame flags
    const idMap = { TT2: 'title', TP1: 'artist', TAL: 'album' };
    let p = 0;
    while (p + 6 <= bytes.length) {
      const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2]);
      const size = (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5];
      p += 6;
      if (size <= 0 || p + size > bytes.length) break;
      const key = idMap[id];
      if (key && !tags[key]) tags[key] = decodeId3Text(bytes.slice(p, p + size));
      p += size;
    }
  } else {
    // ID3v2.3 / v2.4: 4-char frame IDs, 4-byte sizes (syncsafe in v2.4), 2 flag bytes
    const idMap = { TIT2: 'title', TPE1: 'artist', TALB: 'album' };
    let p = 0;
    while (p + 10 <= bytes.length) {
      const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      if (id === '\u0000\u0000\u0000\u0000') break; // padding reached
      let size;
      if (majorVersion >= 4) {
        size = ((bytes[p + 4] & 0x7f) << 21) | ((bytes[p + 5] & 0x7f) << 14) | ((bytes[p + 6] & 0x7f) << 7) | (bytes[p + 7] & 0x7f);
      } else {
        size = (bytes[p + 4] << 24) | (bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7];
      }
      p += 10;
      if (size <= 0 || p + size > bytes.length) break;
      const key = idMap[id];
      if (key && !tags[key]) tags[key] = decodeId3Text(bytes.slice(p, p + size));
      p += size;
    }
  }
  return Object.keys(tags).length ? tags : null;
}

// --------------------------------------------------------------------------
// MP4 / M4A / AAC — moov > udta > meta > ilst atom tree
// --------------------------------------------------------------------------
function findMp4Tags(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourCC = (off) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);

  function findChild(start, end, name, skipHeaderBytes = 0) {
    let p = start + skipHeaderBytes;
    while (p + 8 <= end) {
      let size = view.getUint32(p);
      const type = fourCC(p + 4);
      let headerLen = 8;
      if (size === 1) { // 64-bit extended size
        if (p + 16 > end) return null;
        const hi = view.getUint32(p + 8), lo = view.getUint32(p + 12);
        size = hi * 2 ** 32 + lo;
        headerLen = 16;
      } else if (size === 0) {
        size = end - p; // extends to end of parent
      }
      if (size < headerLen || p + size > end) return null;
      if (type === name) return { start: p + headerLen, end: p + size, boxStart: p };
      p += size;
    }
    return null;
  }

  const moov = findChild(0, bytes.length, 'moov');
  if (!moov) return null;
  const udta = findChild(moov.start, moov.end, 'udta');
  if (!udta) return null;
  const meta = findChild(udta.start, udta.end, 'meta');
  if (!meta) return null;
  // "meta" is a full box: 4 extra bytes (version+flags) before its children
  const ilst = findChild(meta.start, meta.end, 'ilst', 4) || findChild(meta.start, meta.end, 'ilst', 0);
  if (!ilst) return null;

  const wantedBoxes = { '\u00a9nam': 'title', '\u00a9ART': 'artist', '\u00a9alb': 'album' };
  const tags = {};
  for (const [boxName, key] of Object.entries(wantedBoxes)) {
    const box = findChild(ilst.start, ilst.end, boxName);
    if (!box) continue;
    const dataBox = findChild(box.start, box.end, 'data');
    if (!dataBox) continue;
    // "data" box payload: 4 bytes type indicator, 4 bytes locale, then the value
    const valueStart = dataBox.start + 8;
    if (valueStart >= dataBox.end) continue;
    const typeIndicator = view.getUint32(dataBox.start);
    const valueBytes = bytes.slice(valueStart, dataBox.end);
    let value = '';
    try {
      value = typeIndicator === 1 ? utf8.decode(valueBytes) : latin1.decode(valueBytes);
    } catch (_) { continue; }
    value = cleanTagValue(value);
    if (value) tags[key] = value;
  }
  return Object.keys(tags).length ? tags : null;
}

async function readMp4Tags(file) {
  // moov is usually near the start (for streaming-optimized files) or near
  // the end (common with encoders that finalize metadata last). Try a
  // front slice first since it's the more common case and cheaper to fail
  // fast on; fall back to a tail slice if that doesn't turn up tags.
  const frontWindow = Math.min(file.size, 2 * 1024 * 1024);
  const frontBuf = await readSlice(file, 0, frontWindow);
  let tags = findMp4Tags(new Uint8Array(frontBuf));
  if (tags) return tags;

  if (file.size > frontWindow) {
    const tailWindow = Math.min(file.size, 2 * 1024 * 1024);
    const tailBuf = await readSlice(file, file.size - tailWindow, file.size);
    tags = findMp4Tags(new Uint8Array(tailBuf));
    if (tags) return tags;
  }
  return null;
}

// --------------------------------------------------------------------------
// public entry point
// --------------------------------------------------------------------------

/**
 * Best-effort real tag read for a track. Returns { title?, artist?, album? }
 * (only the keys that were actually found) or null if nothing could be
 * parsed / the format isn't covered — callers should fall back to
 * filename-derived title and "Unknown Artist" in that case, same as before.
 */
export async function readTags(file, ext) {
  try {
    if (ext === 'flac') return await readFlacTags(file);
    if (ext === 'mp3') return await readId3Tags(file);
    if (ext === 'm4a' || ext === 'aac') return await readMp4Tags(file);
  } catch (err) {
    console.warn(`Tag read failed for "${file.name}":`, err.message);
  }
  return null;
}
