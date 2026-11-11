// A small QR code maker for links (byte mode, error correction level M, versions 1 to 10, up to 213 bytes).
// No outside libraries: qrSvg(text) returns an <svg> string. Used for friend links and invite links.
(() => {
  'use strict';
  // per version: [error correction codewords per block, [blocks, data codewords], [blocks, data codewords]?]
  const BLOCKS = [null, [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]],
    [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  // arithmetic in GF(256)
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
  function ecc(data, n) {
    let g = [1];
    for (let i = 0; i < n; i++) { const next = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); } g = next; }
    const r = data.concat(new Array(n).fill(0));
    for (let i = 0; i < data.length; i++) { const c = r[i]; if (c) for (let j = 1; j < g.length; j++) r[i + j] ^= mul(g[j], c); }
    return r.slice(data.length);
  }
  const dataCap = v => { const b = BLOCKS[v]; return b[1][0] * b[1][1] + (b[2] ? b[2][0] * b[2][1] : 0); };
  function codewords(bytes, v) {
    const bits = [], put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    const cap = dataCap(v);
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
    put(0, Math.min(4, cap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let p = 0; data.length < cap; p++) data.push(p % 2 ? 0x11 : 0xec);
    const [n, ...groups] = BLOCKS[v], blocks = [];
    let k = 0; for (const [count, size] of groups) for (let i = 0; i < count; i++) { const d = data.slice(k, k + size); k += size; blocks.push({ d, e: ecc(d, n) }); }
    const out = [], maxD = Math.max(...blocks.map(b => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < n; i++) for (const b of blocks) out.push(b.e[i]);
    return out;
  }
  const bch = (val, poly) => { const deg = Math.floor(Math.log2(poly)); let r = val << deg;
    for (let i = Math.floor(Math.log2(r || 1)); i >= deg; i--) if (r & (1 << i)) r ^= poly << (i - deg); return (val << deg) | r; };
  const MASKS = [(r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0, (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];
  function matrix(v, words, mask) {
    const size = 17 + 4 * v, m = Array.from({ length: size }, () => new Array(size).fill(null));
    const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const y = r + i, x = c + j; if (y < 0 || x < 0 || y >= size || x >= size) continue;
      m[y][x] = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); } };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) { m[6][i] = i % 2 === 0; m[i][6] = i % 2 === 0; }
    const al = ALIGN[v];
    const last = al.length - 1;
    al.forEach((r, a) => al.forEach((c, b) => { if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) return; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) m[r + i][c + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1; }));
    m[size - 8][8] = true;   // the dark module
    // reserve format and version areas
    const fmtCells = []; for (let i = 0; i < 9; i++) { if (i !== 6) { fmtCells.push([8, i], [i, 8]); } } for (let i = 0; i < 8; i++) fmtCells.push([8, size - 1 - i], [size - 1 - i, 8]);
    for (const [r, c] of fmtCells) if (m[r][c] === null) m[r][c] = false;
    if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { m[i][size - 11 + j] = false; m[size - 11 + j][i] = false; }
    const fixed = m.map(row => row.map(x => x !== null));
    // data, in the zigzag
    const bits = []; for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
    let k = 0;
    for (let c = size - 1; c > 0; c -= 2) { if (c === 6) c--;
      for (let n = 0; n < size; n++) { const r = ((c + 1) & 2) === 0 ? size - 1 - n : n;
        for (let d = 0; d < 2; d++) { const x = c - d; if (fixed[r][x]) continue; const b = k < bits.length ? bits[k++] : 0; m[r][x] = !!(b ^ (MASKS[mask](r, x) ? 1 : 0)); } } }
    // format info: level M is 00
    const f = bch((0 << 3) | mask, 0x537) ^ 0x5412;
    const fb = i => ((f >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) m[i][8] = fb(i);
    m[7][8] = fb(6); m[8][8] = fb(7); m[8][7] = fb(8);
    for (let i = 9; i <= 14; i++) m[8][14 - i] = fb(i);
    for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = fb(i);
    for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = fb(i);
    m[size - 8][8] = true;
    if (v >= 7) { const vi = bch(v, 0x1f25); for (let i = 0; i < 18; i++) { const b = ((vi >> i) & 1) === 1, a = Math.floor(i / 3), c2 = size - 11 + (i % 3); m[a][c2] = b; m[c2][a] = b; } }
    return m;
  }
  function penalty(m) {
    const n = m.length; let p = 0;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) { let run = 1;
      for (let j = 1; j < n; j++) { const a = pass ? m[j][i] : m[i][j], b = pass ? m[j - 1][i] : m[i][j - 1]; if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) { const c = m[i][j]; if (c === m[i + 1][j] && c === m[i][j + 1] && c === m[i + 1][j + 1]) p += 3; }
    const pat = [true, false, true, true, true, false, true];
    for (let i = 0; i < n; i++) for (let j = 0; j + 7 <= n; j++) for (const pass of [0, 1]) {
      if (!pat.every((x, k) => (pass ? m[j + k][i] : m[i][j + k]) === x)) continue;
      const lite = (a, b) => { for (let k = a; k < b; k++) { if (k < 0 || k >= n) continue; if (pass ? m[k][i] : m[i][k]) return false; } return true; };
      if (lite(j - 4, j) || lite(j + 7, j + 11)) p += 40; }
    let dark = 0; for (const row of m) for (const x of row) if (x) dark++;
    p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }
  function qrMatrix(text, onlyMask) {
    const bytes = [...new TextEncoder().encode(String(text))];
    let v = 1; while (v <= 10 && dataCap(v) < bytes.length + (v < 10 ? 2 : 3)) v++;
    if (v > 10) throw new Error('Too long for a QR code');
    const words = codewords(bytes, v);
    let best = null, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) { if (onlyMask != null && mask !== onlyMask) continue; const m = matrix(v, words, mask), p = penalty(m); if (p < bestP) { bestP = p; best = m; } }
    return best;
  }
  function qrSvg(text, { dark = '#14112A', light = '#fff' } = {}) {
    const m = qrMatrix(text), n = m.length, q = 4, s = n + 2 * q; let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${s}" height="${s}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }
  if (typeof module !== 'undefined') module.exports = { qrSvg, qrMatrix };
  else window.qrSvg = qrSvg;
})();
