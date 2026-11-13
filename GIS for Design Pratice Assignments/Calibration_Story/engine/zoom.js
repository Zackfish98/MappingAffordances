// Zoomed views of the story map (the callouts beside it), drawn at their own resolution rather than enlarged
// from the map canvas:
// - walkshed: the same rule as spread.js (covered when margin + amp * noise <= 0), but margin is sampled
//   bilinearly between grid pixels and the noise is evaluated at each view pixel, so edges stay smooth and the
//   rough edge keeps its fine detail; the lost-to-calibration area is the residue mask, sampled the same way.
//   The grid stops at whole pixels along the shore, so around each view the margin and the residue mask are
//   carried a few pixels out into pixels no source can ever reach (water), and the result is clipped to the
//   borough shapes (clipLand);
// - streets and borough outlines from data/base_vec.json (export_base_vectors.py), parks and plazas / Open
//   Streets from their vector layers (reveal.js), with line widths as on the map at 1:1.
// Residue dots are a pattern in view pixels, the size they are on the map at 1:1.

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const CAP = 30;  // minutes: stands in for "no source reaches" when interpolating the margin
const REACH = 4; // grid px carried out past the edge of the reachable pixels

function linesPath(lines, path = new Path2D()) {
  for (const r of lines) { path.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) path.lineTo(r[i], r[i + 1]); }
  return path;
}

export class Zoom {
  constructor(field, spread, core, motion) {
    this.field = field; this.spread = spread; this.core = core; this.motion = motion;
    this.base = null; this.cells = new Map();
    this.inField = new Uint8Array(field.N);
    for (const p of field.fieldPx) this.inField[p] = 1;
  }

  // margin and residue over the view's pixels plus a rim, carried out into pixels outside the field: each pass
  // gives an empty pixel the mean margin (and max residue) of its reached 4-neighbours
  local(v) {
    const f = this.field, W = f.W, H = f.H, m = f.margin, resid = this.spread.residue, inF = this.inField;
    const x0 = Math.max(0, Math.floor(v.x) - REACH - 1), y0 = Math.max(0, Math.floor(v.y) - REACH - 1);
    const x1 = Math.min(W - 1, Math.ceil(v.x + v.z) + REACH + 1), y1 = Math.min(H - 1, Math.ceil(v.y + v.z) + REACH + 1);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    let lm = new Float32Array(w * h), lr = new Float32Array(w * h);
    const out = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = (y0 + j) * W + x0 + i, q = j * w + i;
      lm[q] = m[p] === Infinity ? CAP : m[p]; lr[q] = resid[p]; out[q] = !inF[p];
    }
    for (let pass = 0; pass < REACH; pass++) {
      const nm = lm.slice(), nr = lr.slice();
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const q = j * w + i;
        if (!out[q] || lm[q] < CAP) continue;
        let s = 0, n = 0, r = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const o = jj * w + ii;
          if (lm[o] < CAP) { s += lm[o]; n++; }
          if (lr[o] > r) r = lr[o];
        }
        if (n) nm[q] = s / n;
        nr[q] = r;
      }
      lm = nm; lr = nr;
    }
    return { x0, y0, w, h, m: lm, r: lr };
  }

  setBase(vec) { // data/base_vec.json
    this.base = vec; this.cells.clear();
    this.outlines = linesPath(vec.outlines);
    this.land = new Path2D(this.outlines);
  }

  // a view: square box [x, y, size] in grid px drawn on an n x n canvas; pd = device px per CSS px
  view(box, n, pd) {
    const [x, y, z] = box, s = n / z;
    return { x, y, z, n, s, pd, ox: -x * s, oy: -y * s, lw: pd / s };
  }

  // streets and outlines (or the base.png crop until base_vec.json has loaded), onto c
  drawBase(c, v, baseImg) {
    const col = this.core.color;
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = col.background; c.fillRect(0, 0, v.n, v.n);
    if (!this.base) {
      const k = baseImg.width / this.field.W;
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
      c.drawImage(baseImg, v.x * k, v.y * k, v.z * k, v.z * k, 0, 0, v.n, v.n);
      return;
    }
    const C = this.base.cellPx, path = new Path2D();
    for (let i = Math.floor(v.x / C) - 1; i <= Math.floor((v.x + v.z) / C) + 1; i++) {
      for (let j = Math.floor(v.y / C) - 1; j <= Math.floor((v.y + v.z) / C) + 1; j++) {
        const key = `${i},${j}`;
        if (!this.base.streets[key]) continue;
        if (!this.cells.has(key)) this.cells.set(key, linesPath(this.base.streets[key]));
        path.addPath(this.cells.get(key));
      }
    }
    c.setTransform(v.s, 0, 0, v.s, v.ox, v.oy); c.lineJoin = c.lineCap = "round";
    c.strokeStyle = col.street; c.lineWidth = 0.5 * v.lw; c.stroke(path);
    c.strokeStyle = col.outline; c.lineWidth = 1.0 * v.lw; c.stroke(this.outlines);
  }

  // keep only what is on land (the borough shapes), on c (the walkshed layer); until base_vec.json loads, nothing
  clipLand(c, v) {
    if (!this.base) return;
    c.save(); c.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
    c.globalCompositeOperation = "destination-in"; c.fillStyle = "#000"; c.fill(this.land, "evenodd");
    c.restore();
  }

  // the noise at each view pixel (the caller keeps it until the view changes)
  noise(v) {
    const n = v.n, out = new Float32Array(n * n), d = v.z / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out[j * n + i] = this.spread.noiseAt(v.x + (i + 0.5) * d - 0.5, v.y + (j + 0.5) * d - 0.5);
    return out;
  }

  // walkshed and residue into img (n x n ImageData); st as Spread.render
  renderWalkshed(img, v, st, nzCache) {
    const f = this.field, W = f.W, own = f.owner;
    const L = img.data, n = v.n, d = v.z / n, nz = nzCache;
    const col = this.core.color, sp = this.motion.spread, res = this.motion.residue;
    const body = hex(col.walkshed), front = hex(col.walkshedFront), dot = hex(col.residueDot), ground = hex(col.residueGround);
    const k = Math.max(0, Math.min(1, st.settle ?? 1));
    const aBody = Math.round(255 * sp.body), aFront = Math.round(255 * (sp.body + (sp.frontOpacity - sp.body) * k));
    for (let i = 0; i < 3; i++) front[i] = Math.round(body[i] + (front[i] - body[i]) * k);
    const frontW = sp.frontWidth, amp = st.amp, exp = st.expanding;
    const fadeIn = res.fadeInMin, dsp = res.dotSpacing * v.pd, dr2 = (res.dotSize * v.pd) ** 2, aGround = 255 * res.groundAlpha;
    const lc = this.local(v), lw = lc.w, lm = lc.m, lr = lc.r;
    for (let j = 0; j < n; j++) {
      const gy = v.y + (j + 0.5) * d - 0.5, y0 = Math.max(0, Math.min(lc.h - 2, Math.floor(gy) - lc.y0)), fy = Math.max(0, Math.min(1, gy - lc.y0 - y0));
      for (let i = 0; i < n; i++) {
        const gx = v.x + (i + 0.5) * d - 0.5, x0 = Math.max(0, Math.min(lw - 2, Math.floor(gx) - lc.x0)), fx = Math.max(0, Math.min(1, gx - lc.x0 - x0));
        const p = y0 * lw + x0, q = (j * n + i) * 4;
        const a = lm[p], b = lm[p + 1], c = lm[p + lw], e = lm[p + lw + 1];
        const r = lr[p] + (lr[p + 1] - lr[p]) * fx + (lr[p + lw] - lr[p]) * fy + (lr[p] - lr[p + 1] - lr[p + lw] + lr[p + lw + 1]) * fx * fy;
        if (a >= CAP && b >= CAP && c >= CAP && e >= CAP && !(st.residueOn && r > 0)) { L[q + 3] = 0; continue; }
        const mm = a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
        const near = (lc.y0 + y0 + (fy < 0.5 ? 0 : 1)) * W + lc.x0 + x0 + (fx < 0.5 ? 0 : 1);
        const me = mm + amp * nz[j * n + i];
        if (me <= 0) {
          const isFront = frontW > 0 && me > -frontW && own[near] >= 0 && exp[own[near]];
          const cc = isFront ? front : body;
          L[q] = cc[0]; L[q + 1] = cc[1]; L[q + 2] = cc[2]; L[q + 3] = isFront ? aFront : aBody;
          continue;
        }
        if (st.residueOn) {
          if (r >= 0.5) {
            const fade = mm >= CAP ? 1 : Math.min(1, me / fadeIn);
            const gxp = (i % dsp) - dsp / 2, gyp = (j % dsp) - dsp / 2;
            if (gxp * gxp + gyp * gyp <= dr2) { L[q] = dot[0]; L[q + 1] = dot[1]; L[q + 2] = dot[2]; L[q + 3] = Math.round(255 * fade); }
            else { L[q] = ground[0]; L[q + 1] = ground[1]; L[q + 2] = ground[2]; L[q + 3] = Math.round(aGround * fade); }
            continue;
          }
        }
        L[q + 3] = 0;
      }
    }
  }
}
