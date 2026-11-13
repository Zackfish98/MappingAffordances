// Walkshed coverage from per-source walking-time fields and each source's current reach.
//
// Every source (park, plaza, Open Street) has a sparse field over the grid (data/fields/<id>.bin):
// walking minutes t and straight-line minutes d per reached pixel. With a source's walking reach rt and
// straight-line cut rd (Infinity = no cut), a pixel is inside its walkshed when max(t - rt, d - rd) <= 0.
// margin[px] keeps the smallest of those over all sources (and owner[px] the source that gave it), so a
// pixel is covered when margin[px] + rough * noise[px] <= 0 (spread.js). Sources with rt <= 0 cover nothing.

export async function loadFields(base, index, onProgress = () => {}) {
  const meta = index.sources;
  const scale = index.encoding.straightScale;
  const out = new Map();
  let next = 0, done = 0;
  async function worker() {
    while (next < meta.length) {
      const r = meta[next++];
      const buf = await (await fetch(base + r.file)).arrayBuffer();
      const n = r.count;
      const dq = new Uint16Array(buf, 8 * n, n);
      const d = new Float32Array(n);
      for (let j = 0; j < n; j++) d[j] = dq[j] / scale;
      out.set(r.id, { idx: new Int32Array(buf, 0, n), t: new Float32Array(buf, 4 * n, n), d,
                      fullRadius: r.fullRadiusMin });
      onProgress(++done, meta.length);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  return out;
}

export class Field {
  // frame: data/frame.json; fields: Map id -> {idx, t, d, fullRadius}; ids: the engine's source order
  constructor(frame, fields, ids) {
    this.W = frame.width; this.H = frame.height; this.N = this.W * this.H;
    this.src = ids.map((id) => fields.get(id) || null);
    this.margin = new Float32Array(this.N).fill(Infinity);
    this.owner = new Int32Array(this.N).fill(-1);
    const mark = new Uint8Array(this.N);
    for (const s of this.src) if (s) for (let j = 0; j < s.idx.length; j++) mark[s.idx[j]] = 1;
    let n = 0;
    for (let p = 0; p < this.N; p++) n += mark[p];
    this.fieldPx = new Int32Array(n); // every pixel any source can reach: the only pixels ever drawn
    for (let p = 0, q = 0; p < this.N; p++) if (mark[p]) this.fieldPx[q++] = p;
  }

  fullRadius(s) { return this.src[s] ? this.src[s].fullRadius : 0; }

  // Rebuild margin and owner from every source's current reach (rt, rd: per-source arrays)
  recompute(rt, rd) {
    const m = this.margin, o = this.owner, px = this.fieldPx;
    for (let q = 0; q < px.length; q++) { m[px[q]] = Infinity; o[px[q]] = -1; }
    for (let s = 0; s < this.src.length; s++) {
      const R = rt[s], src = this.src[s];
      if (!(R > 0) || !src) continue;
      const D = rd[s], idx = src.idx, t = src.t, d = src.d;
      for (let j = 0; j < idx.length; j++) {
        let v = t[j] - R;
        const w = d[j] - D;
        if (w > v) v = w;
        const p = idx[j];
        if (v < m[p]) { m[p] = v; o[p] = s; }
      }
    }
  }
}
