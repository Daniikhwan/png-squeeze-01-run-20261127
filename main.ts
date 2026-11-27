// png-squeeze: squeeze 1280x720 screenshots into the smallest lossless PNG.
//
// Strategy (written from the PNG spec and standard compression practice):
//  1. Decode the stored RGBA input PNG.
//  2. Analyse it: opaque? grey? at most 256 colours? one transparent key value?
//  3. Try every exact form that can hold it: palette (several entry orders),
//     grey / grey+alpha / RGB / RGBA, with a tRNS key when one exists.
//  4. For each form try several per-row filter plans: every fixed filter,
//     minimum-sum, fewest-distinct-pairs, and brute force (each row's five
//     filters weighed by a real deflate of the row after its 32 KiB context).
//  5. Compress every candidate with zlib level 9 and keep the smallest file.
// Deterministic: fixed work budgets only, no clock, no environment variation.

import { deflateSync, inflateSync } from 'node:zlib';
import { constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC-32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------- PNG codec
const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunkBytes(type, data, out, at) {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(at, data.length);
  out[at + 4] = type.charCodeAt(0);
  out[at + 5] = type.charCodeAt(1);
  out[at + 6] = type.charCodeAt(2);
  out[at + 7] = type.charCodeAt(3);
  out.set(data, at + 8);
  view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
  return at + 12 + data.length;
}

function pngOf(chunks) {
  let size = SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, data] of chunks) at = chunkBytes(type, data, out, at);
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter one row of `cur` (stride samples) against `prev` (or null) into out.
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++)
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Decode a bit-depth-8, non-interlaced PNG (colour types 0, 2, 3, 4, 6) to RGBA.
function decodePng(bytes) {
  if (bytes.length < 8) throw new Error('file too short for a PNG');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('not a PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk header');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len))
      throw new Error(type + ' chunk CRC mismatch');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8) throw new Error('bit depth is not 8');
      if (!(header.colourType in CHANNELS)) throw new Error('unsupported colour type ' + header.colourType);
      if (header.interlace !== 0) throw new Error('interlaced');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error('unsupported chunk ' + type);
    }
  }
  if (!ended || !header || idat.length === 0) throw new Error('missing IHDR/IDAT/IEND');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to ' + raw.length + ', expected ' + expected);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('row ' + y + ' has filter type ' + ft);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++)
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- Analysis
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  const firstSeen = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      if (!counts.has(c)) {
        if (counts.size === 256) many = true;
        else {
          counts.set(c, 1);
          firstSeen.set(c, i);
        }
      } else counts.set(c, counts.get(c) + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c), first: firstSeen.get(c) };
    });
  }
  return { opaque, grey, colours };
}

// The one fully transparent value (grey sample or RGB triple) the image may
// key by tRNS instead of an alpha channel, or null.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];

function paletteForm(rgba, colours, order) {
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    if (order === 'first') return x.first - y.first;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- Filters
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Filter `samples` (height rows of width*bpp) under every plan at once:
// filter 0 (None), 'minsum', 'pairs' and 'brute' (per row, real deflate cost
// of the row after the 32 KiB already written). The five trial filters of a
// row are computed once and shared by the three adaptive plans, so the
// result is bit-identical to filtering each plan separately. Returns a map
// from plan name to the filtered bytes.
function filterPlans(samples, width, height, bpp, needed) {
  const stride = width * bpp;
  const size = height * (stride + 1);
  const want = new Set(needed);
  const plans = {};
  if (want.has(0)) plans[0] = new Uint8Array(size);
  if (want.has('minsum')) plans.minsum = new Uint8Array(size);
  if (want.has('pairs')) plans.pairs = new Uint8Array(size);
  if (want.has('brute')) plans.brute = new Uint8Array(size);
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (want.has(0)) {
      plans[0][at] = 0;
      plans[0].set(cur, at + 1);
    }
    for (let t = 0; t < 5; t++) filterRow(t, cur, prev, bpp, trial[t].subarray(1));
    let bestSum = Infinity, tSum = 0;
    let bestPairs = Infinity, tPairs = 0;
    let bestCost = Infinity, tBrute = 0;
    const before = want.has('brute') ? plans.brute.subarray(Math.max(0, at - BRUTE_CONTEXT), at) : null;
    for (let t = 0; t < 5; t++) {
      const row = trial[t].subarray(1);
      if (want.has('minsum')) {
        const s = signedSum(row);
        if (s < bestSum) {
          bestSum = s;
          tSum = t;
        }
      }
      if (want.has('pairs')) {
        const p = pairsOf(row, seen, ++stamp);
        if (p < bestPairs) {
          bestPairs = p;
          tPairs = t;
        }
      }
      if (want.has('brute')) {
        const c = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
        if (c < bestCost) {
          bestCost = c;
          tBrute = t;
        }
      }
    }
    if (want.has('minsum')) plans.minsum.set(trial[tSum], at);
    if (want.has('pairs')) plans.pairs.set(trial[tPairs], at);
    if (want.has('brute')) plans.brute.set(trial[tBrute], at);
  }
  return plans;
}

// ---------------------------------------------------------------- Forms
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
      ['first', [0, 'minsum']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 'minsum', 'pairs', 'brute'] });
  return forms;
}

const chunkBytesOf = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// Custom optimal-parsing deflate (zopfli-style, bounded deterministic work).
// Pure Node builtins. No clock reads; all budgets are fixed counts.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeOf(len) {
  if (len >= 258) return 28;
  let lo = 0, hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
function distCodeOf(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Length-limited Huffman code lengths from frequencies (zlib gen_bitlen style).
// Returns Uint8Array of lengths (0 = unused). The code is always complete
// (Kraft sum 1) when at least one symbol has freq > 0.
function buildLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  let nonzero = 0;
  let single = -1;
  for (let i = 0; i < n; i++) {
    if (freq[i] > 0) {
      nonzero++;
      single = i;
    }
  }
  if (nonzero === 0) return lengths;
  if (nonzero === 1) {
    // A one-symbol code needs two length-1 codes to be complete; the second
    // is a dummy that is never emitted.
    lengths[single] = 1;
    lengths[single === 0 ? 1 : 0] = 1;
    return lengths;
  }
  const maxNodes = 2 * n;
  const nodeFreq = new Float64Array(maxNodes);
  const nodeLeft = new Int32Array(maxNodes);
  const nodeRight = new Int32Array(maxNodes);
  const nodeDepth = new Int32Array(maxNodes);
  for (let i = 0; i < n; i++) {
    nodeFreq[i] = freq[i];
    nodeLeft[i] = -1;
  }
  const heap = [];
  const heapLess = (a, b) => nodeFreq[a] < nodeFreq[b] || (nodeFreq[a] === nodeFreq[b] && a < b);
  const heapPush = (v) => {
    heap.push(v);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      const t = heap[i]; heap[i] = heap[p]; heap[p] = t;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
        if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[i]; heap[i] = heap[m]; heap[m] = t;
        i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) heapPush(i);
  let next = n;
  while (heap.length > 1) {
    const a = heapPop();
    const b = heapPop();
    nodeFreq[next] = nodeFreq[a] + nodeFreq[b];
    nodeLeft[next] = a;
    nodeRight[next] = b;
    heapPush(next);
    next++;
  }
  const root = heapPop();
  const stack = [root];
  nodeDepth[root] = 0;
  const blCount = new Int32Array(n + 2); // indexed up to maxDepth (<= n - 1)
  let maxDepth = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    const d = nodeDepth[v];
    if (nodeLeft[v] === -1) {
      lengths[v] = d;
      blCount[d]++;
      if (d > maxDepth) maxDepth = d;
    } else {
      nodeDepth[nodeLeft[v]] = d + 1;
      nodeDepth[nodeRight[v]] = d + 1;
      stack.push(nodeLeft[v]);
      stack.push(nodeRight[v]);
    }
  }
  if (maxDepth <= maxBits) return lengths;
  // The Huffman tree is too deep: length-limited Huffman by package-merge
  // (Larmore & Przytycka), which is optimal under the length limit and
  // always yields a complete code (Kraft sum 1).
  return pmLengths(freq, maxBits);
}

// Length-limited Huffman code lengths by package-merge. `freq` is the
// frequency array; returns a Uint8Array of lengths (0 = unused), every
// length at most maxBits, Kraft sum exactly 1 when any frequency is > 0.
function pmLengths(freq, maxBits) {
  const n0 = freq.length;
  const lengths = new Uint8Array(n0);
  const items = [];
  for (let i = 0; i < n0; i++) if (freq[i] > 0) items.push({ w: freq[i], syms: [i] });
  const n = items.length;
  if (n === 0) return lengths;
  if (n === 1) {
    lengths[items[0].syms[0]] = 1;
    lengths[items[0].syms[0] === 0 ? 1 : 0] = 1;
    return lengths;
  }
  items.sort((a, b) => a.w - b.w || a.syms[0] - b.syms[0]);
  let current = items.map((it) => ({ w: it.w, syms: it.syms }));
  for (let level = 0; level < maxBits - 1; level++) {
    const packaged = [];
    for (let i = 0; i + 1 < current.length; i += 2) {
      packaged.push({ w: current[i].w + current[i + 1].w, syms: current[i].syms.concat(current[i + 1].syms) });
    }
    if (current.length % 2 === 1) packaged.push(current[current.length - 1]);
    const merged = [];
    let a = 0, b = 0;
    while (a < packaged.length && b < items.length) {
      if (packaged[a].w <= items[b].w) merged.push(packaged[a++]);
      else merged.push(items[b++]);
    }
    while (a < packaged.length) merged.push(packaged[a++]);
    while (b < items.length) merged.push(items[b++]);
    current = merged;
  }
  const selected = current.slice(0, 2 * n - 2);
  for (const pkg of selected) for (const s of pkg.syms) lengths[s]++;
  return lengths;
}

function buildCodes(lengths) {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len !== 0) codes[i] = nextCode[len]++;
  }
  return codes;
}

class BitWriter {
  constructor(capacity) {
    this.out = new Uint8Array(Math.max(1024, capacity));
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  ensure(n) {
    if (this.pos + n > this.out.length) {
      const bigger = new Uint8Array(Math.max(this.out.length * 2, this.pos + n));
      bigger.set(this.out.subarray(0, this.pos));
      this.out = bigger;
    }
  }
  writeBits(code, len) {
    this.bitBuf |= (code & ((1 << len) - 1)) << this.bitCnt;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.ensure(1);
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  writeCode(code, len) {
    let rev = 0;
    for (let i = 0; i < len; i++) rev = (rev << 1) | ((code >> i) & 1);
    this.writeBits(rev, len);
  }
  finish() {
    if (this.bitCnt > 0) {
      this.ensure(1);
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
    return this.out.subarray(0, this.pos);
  }
}

const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_LEN = new Uint8Array(30);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
for (let i = 0; i < 30; i++) FIXED_DIST_LEN[i] = 5;
const FIXED_LIT_CODE = buildCodes(FIXED_LIT_LEN);
const FIXED_DIST_CODE = buildCodes(FIXED_DIST_LEN);

const MAX_CHAIN = 1024;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_DIST = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;

function hash3(data, pos) {
  return (Math.imul(((data[pos] << 16) ^ (data[pos + 1] << 8) ^ data[pos + 2]), 2654435761) >>> (32 - HASH_BITS)) & (HASH_SIZE - 1);
}

// Length of the match between data[pos..] and data[cand..], at most maxLen.
function matchLength(data, u32, pos, cand, maxLen, best) {
  const n = data.length;
  const maxP = Math.min(maxLen, n - pos);
  if (best > 0) {
    if (best >= maxP || data[cand + best] !== data[pos + best]) return 0;
  }
  let len = 0;
  if ((pos & 3) === (cand & 3)) {
    while (len < maxP && ((pos + len) & 3) !== 0 && data[cand + len] === data[pos + len]) len++;
    while (len + 4 <= maxP && u32[(cand + len) >>> 2] === u32[(pos + len) >>> 2]) len += 4;
  }
  while (len < maxP && data[cand + len] === data[pos + len]) len++;
  return len;
}

function findLongest(data, u32, pos, head, prev, maxChain) {
  const n = data.length;
  if (pos + MIN_MATCH > n) return [0, 0];
  const h = hash3(data, pos);
  let bestLen = 0;
  let bestDist = 0;
  let chain = maxChain;
  let cand = head[h];
  const limit = pos > MAX_DIST ? pos - MAX_DIST : 0;
  while (cand >= limit && chain-- > 0) {
    const len = matchLength(data, u32, pos, cand, MAX_MATCH, bestLen);
    if (len >= MIN_MATCH && len > bestLen) {
      bestLen = len;
      bestDist = pos - cand;
      if (len >= MAX_MATCH || len >= n - pos) break;
      if (len >= 64) chain = Math.min(chain, 8);
    }
    cand = prev[cand];
  }
  return [bestLen, bestDist];
}

function insertPos(data, pos, head, prev) {
  if (pos + MIN_MATCH > data.length) return;
  const h = hash3(data, pos);
  prev[pos] = head[h];
  head[h] = pos;
}

// DP optimal parse under the given bit-length model. Returns token arrays.
function parseDP(data, litLen, lenCost, distCost, maxChain) {
  const n = data.length;
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length >>> 2);
  const cost = new Float64Array(n + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  const choiceLen = new Uint16Array(n + 1);
  const choiceDist = new Int32Array(n + 1);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci !== Infinity) {
      const lc = ci + litLen[data[i]];
      if (lc < cost[i + 1]) {
        cost[i + 1] = lc;
        choiceLen[i + 1] = 0;
      }
      const [mlen, mdist] = findLongest(data, u32, i, head, prev, maxChain);
      if (mlen >= MIN_MATCH) {
        const dc = distCodeOf(mdist);
        const dcost = distCost[dc] + DIST_EXTRA[dc];
        let L = mlen;
        while (L >= MIN_MATCH) {
          const b = lenCodeOf(L);
          const c = ci + lenCost[b] + LEN_EXTRA[b] + dcost;
          if (c < cost[i + L]) {
            cost[i + L] = c;
            choiceLen[i + L] = L;
            choiceDist[i + L] = mdist;
          }
          if (b === 0) break;
          L = LEN_BASE[b] - 1;
        }
      }
    }
    insertPos(data, i, head, prev);
  }
  // Count tokens, then fill them backwards into preallocated arrays.
  let count = 0;
  let end = n;
  while (end > 0) {
    count++;
    end -= choiceLen[end] === 0 ? 1 : choiceLen[end];
  }
  const tok = new Int32Array(count);
  const tokLen = new Uint16Array(count);
  const tokDist = new Int32Array(count);
  let k = count - 1;
  end = n;
  while (end > 0) {
    const L = choiceLen[end];
    if (L === 0) {
      tok[k] = data[end - 1];
      tokLen[k] = 0;
      tokDist[k] = 0;
      end -= 1;
    } else {
      tok[k] = -1;
      tokLen[k] = L;
      tokDist[k] = choiceDist[end];
      end -= L;
    }
    k--;
  }
  return { tok, tokLen, tokDist, count };
}

function tokenFreqs(tok, tokLen, tokDist, count, from = 0, to = count) {
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (let k = from; k < to; k++) {
    if (tok[k] >= 0) litFreq[tok[k]]++;
    else {
      litFreq[257 + lenCodeOf(tokLen[k])]++;
      distFreq[distCodeOf(tokDist[k])]++;
    }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

// Frequencies smoothed (+1 everywhere) so the DP cost model never prices a
// usable symbol at zero bits.
function smoothedFreqs(litFreq, distFreq) {
  const lf = new Uint32Array(286);
  const df = new Uint32Array(30);
  for (let i = 0; i < 286; i++) lf[i] = litFreq[i] + 1;
  for (let i = 0; i < 30; i++) df[i] = distFreq[i] + 1;
  return { litFreq: lf, distFreq: df };
}

function rangeCost(tok, tokLen, tokDist, from, to, litLen, distLen) {
  let bits = 0;
  for (let k = from; k < to; k++) {
    if (tok[k] >= 0) bits += litLen[tok[k]];
    else {
      const lc = lenCodeOf(tokLen[k]);
      bits += litLen[257 + lc] + LEN_EXTRA[lc];
      const dc = distCodeOf(tokDist[k]);
      bits += distLen[dc] + DIST_EXTRA[dc];
    }
  }
  return bits;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Plan a dynamic-Huffman block header: RLE-encode the code lengths, build the
// code-length code, and count the header's exact bit cost.
function planDynamic(litLen, distLen) {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const lens = new Uint8Array(hlit + hdist);
  lens.set(litLen.subarray(0, hlit), 0);
  lens.set(distLen.subarray(0, hdist), hlit);
  const rleSym = [];
  const rleExtra = [];
  const rleBits = [];
  let i = 0;
  while (i < lens.length) {
    const cur = lens[i];
    let run = 1;
    while (i + run < lens.length && lens[i + run] === cur) run++;
    const total = run;
    if (cur === 0) {
      while (run >= 11) {
        const take = Math.min(run, 138);
        rleSym.push(18); rleExtra.push(take - 11); rleBits.push(7);
        run -= take;
      }
      if (run >= 3) {
        rleSym.push(17); rleExtra.push(run - 3); rleBits.push(3);
        run = 0;
      }
      while (run > 0) {
        rleSym.push(0); rleExtra.push(0); rleBits.push(0);
        run--;
      }
    } else {
      rleSym.push(cur); rleExtra.push(0); rleBits.push(0);
      run--;
      while (run >= 3) {
        const take = Math.min(run, 6);
        rleSym.push(16); rleExtra.push(take - 3); rleBits.push(2);
        run -= take;
      }
      while (run > 0) {
        rleSym.push(cur); rleExtra.push(0); rleBits.push(0);
        run--;
      }
    }
    i += total;
  }
  const clFreq = new Uint32Array(19);
  for (const s of rleSym) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  const clCode = buildCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  let headerBits = 14 + 3 * hclen;
  for (let k = 0; k < rleSym.length; k++) headerBits += clLen[rleSym[k]] + rleBits[k];
  return { hlit, hdist, hclen, clLen, clCode, rleSym, rleExtra, rleBits, headerBits };
}

function emitTokens(w, tok, tokLen, tokDist, from, to, litCode, litLen, distCode, distLen) {
  for (let k = from; k < to; k++) {
    if (tok[k] >= 0) {
      w.writeCode(litCode[tok[k]], litLen[tok[k]]);
    } else {
      const lc = lenCodeOf(tokLen[k]);
      w.writeCode(litCode[257 + lc], litLen[257 + lc]);
      if (LEN_EXTRA[lc] > 0) w.writeBits(tokLen[k] - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCodeOf(tokDist[k]);
      w.writeCode(distCode[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) w.writeBits(tokDist[k] - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.writeCode(litCode[256], litLen[256]);
}

function emitDynamic(w, tok, tokLen, tokDist, from, to, litLen, distLen) {
  const plan = planDynamic(litLen, distLen);
  w.writeBits(plan.hlit - 257, 5);
  w.writeBits(plan.hdist - 1, 5);
  w.writeBits(plan.hclen - 4, 4);
  for (let k = 0; k < plan.hclen; k++) w.writeBits(plan.clLen[CL_ORDER[k]], 3);
  for (let k = 0; k < plan.rleSym.length; k++) {
    w.writeCode(plan.clCode[plan.rleSym[k]], plan.clLen[plan.rleSym[k]]);
    if (plan.rleBits[k] > 0) w.writeBits(plan.rleExtra[k], plan.rleBits[k]);
  }
  const litCode = buildCodes(litLen);
  const distCode = buildCodes(distLen);
  emitTokens(w, tok, tokLen, tokDist, from, to, litCode, litLen, distCode, distLen);
}

function emitFixed(w, tok, tokLen, tokDist, from, to) {
  emitTokens(w, tok, tokLen, tokDist, from, to, FIXED_LIT_CODE, FIXED_LIT_LEN, FIXED_DIST_CODE, FIXED_DIST_LEN);
}

const BLOCK_BYTES = 200000;
const ITERATIONS = 1;

function deflateOptimal(data) {
  const maxChain = data.length > 2500000 ? 128 : 512;
  const n = data.length;
  if (n === 0) return new Uint8Array([0x03, 0x00]);
  const fixedLenCost = new Float64Array(29);
  const fixedDistCost = new Float64Array(30);
  for (let c = 0; c < 29; c++) fixedLenCost[c] = FIXED_LIT_LEN[257 + c];
  for (let c = 0; c < 30; c++) fixedDistCost[c] = 5;
  let parsed = parseDP(data, FIXED_LIT_LEN, fixedLenCost, fixedDistCost, maxChain);
  // Refinement passes (ITERATIONS = 1 keeps only the fixed-model parse: the
  // per-block Huffman below is still built from the real token frequencies).
  for (let it = 1; it < ITERATIONS; it++) {
    const { litFreq, distFreq } = tokenFreqs(parsed.tok, parsed.tokLen, parsed.tokDist, parsed.count);
    const sm = smoothedFreqs(litFreq, distFreq);
    const litLen = buildLengths(sm.litFreq, 15);
    const distLen = buildLengths(sm.distFreq, 15);
    const lenCost = new Float64Array(29);
    const distCost = new Float64Array(30);
    for (let c = 0; c < 29; c++) lenCost[c] = litLen[257 + c];
    for (let c = 0; c < 30; c++) distCost[c] = distLen[c];
    parsed = parseDP(data, litLen, lenCost, distCost, maxChain);
  }

  const bounds = [0];
  let covered = 0;
  for (let k = 0; k < parsed.count; k++) {
    covered += parsed.tok[k] >= 0 ? 1 : parsed.tokLen[k];
    if (covered >= BLOCK_BYTES && k + 1 < parsed.count) {
      bounds.push(k + 1);
      covered = 0;
    }
  }
  bounds.push(parsed.count);

  const w = new BitWriter(n >>> 2);
  for (let b = 0; b + 1 < bounds.length; b++) {
    const from = bounds[b];
    const to = bounds[b + 1];
    const last = b + 2 === bounds.length;
    const { litFreq: blf, distFreq: bdf } = tokenFreqs(parsed.tok, parsed.tokLen, parsed.tokDist, parsed.count, from, to);
    let hasMatch = false;
    for (let k = from; k < to; k++) if (parsed.tok[k] < 0) { hasMatch = true; break; }
    const blitLen = buildLengths(blf, 15);
    const bdistLen = hasMatch ? buildLengths(bdf, 15) : FIXED_DIST_LEN;
    const dynBits = rangeCost(parsed.tok, parsed.tokLen, parsed.tokDist, from, to, blitLen, bdistLen) + blitLen[256] + planDynamic(blitLen, bdistLen).headerBits;
    const fixBits = rangeCost(parsed.tok, parsed.tokLen, parsed.tokDist, from, to, FIXED_LIT_LEN, FIXED_DIST_LEN) + FIXED_LIT_LEN[256];
    w.writeBits(last ? 1 : 0, 1);
    if (hasMatch && dynBits < fixBits) {
      w.writeBits(2, 2);
      emitDynamic(w, parsed.tok, parsed.tokLen, parsed.tokDist, from, to, blitLen, bdistLen);
    } else {
      w.writeBits(1, 2);
      emitFixed(w, parsed.tok, parsed.tokLen, parsed.tokDist, from, to);
    }
  }
  return w.finish();
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibOptimal(data) {
  const raw = deflateOptimal(data);
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  const ad = adler32(data);
  out[out.length - 4] = (ad >>> 24) & 0xff;
  out[out.length - 3] = (ad >>> 16) & 0xff;
  out[out.length - 2] = (ad >>> 8) & 0xff;
  out[out.length - 1] = ad & 0xff;
  return out;
}

const SCREEN = { level: 6, memLevel: 8 };

// Compress one image: screen every form and filter plan cheaply at zlib
// level 6, then compress the winner with the optimal-parsing deflate (and
// zlib level 9 as a fallback) and keep the smallest PNG.
function squeeze(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytesOf(form);
    const plans = filterPlans(form.samples, width, height, form.bpp, form.filters);
    for (const choice of form.filters) {
      const data = plans[choice];
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  const z9 = deflateSync(best.data, { level: 9, memLevel: 9 });
  const z9f = deflateSync(best.data, { level: 9, memLevel: 9, strategy: constants.Z_FILTERED });
  let idat = z9.length <= z9f.length ? z9 : z9f;
  const opt = zlibOptimal(best.data);
  if (opt.length < idat.length) idat = opt;
  return pngOfForm(width, height, best.form, idat);
}

// ---------------------------------------------------------------- Main
for (const id of readdirSync(INPUT).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT, id, 'image.png'))));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
