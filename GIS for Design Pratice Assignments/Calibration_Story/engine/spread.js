// The spread's look: rough edge, leading front and the residue dots (from the prototype,
// walkshed-spread.html), drawn into one ImageData at grid resolution.
//
// Settings are read live from the tokens (core.json colours, motion.json spread / residue), so the
// look sliders change them in place. Units: minutes of walking for widths along the walk, grid pixels for
// the noise grain and the residue dot pattern.

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(seed) {
  const r = rng(seed), G = 256, g = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) g[i] = r() * 2 - 1;
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = g[(yi & 255) * G + (xi & 255)], b = g[(yi & 255) * G + ((xi + 1) & 255)];
    const c = g[((yi + 1) & 255) * G + (xi & 255)], d = g[((yi + 1) & 255) * G + ((xi + 1) & 255)];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

const GRAIN_PX = [0, 40, 22, 12, 7]; // base noise wavelength per grain step, grid px (prototype)

export class Spread {
  constructor(field, core, motion) {
    this.field = field; this.core = core; this.motion = motion;
    this.noise = new Float32Array(field.N);
    this.nz = valueNoise(7);
    this.grain = null;
    this.residue = new Uint8Array(field.N);
    this.buildNoise();
  }

  setResidue(indices) { this.residue.fill(0); for (let i = 0; i < indices.length; i++) this.residue[indices[i]] = 1; }

  // Fractal value noise over the field pixels, -1..1, shaped (motion.spread.noise)
  buildNoise() {
    const sp = this.motion.spread, nn = sp.noise;
    if (this.grain === sp.grain) return;
    this.grain = sp.grain;
    const W = this.field.W, px = this.field.fieldPx;
    for (let q = 0; q < px.length; q++) { const p = px[q]; this.noise[p] = this.noiseAt(p % W, (p / W) | 0); }
  }

  // The noise at any point in grid px (pixel p is sampled at its column, row): continuous, so the zoomed
  // callouts (zoom.js) get the same rough edge in finer detail
  noiseAt(x, y) {
    const sp = this.motion.spread, nn = sp.noise, base = GRAIN_PX[Math.max(1, Math.min(4, Math.round(sp.grain)))];
    let v = 0, amp = 1, f = 1 / base, tot = 0;
    for (let o = 0; o < nn.octaves; o++) { v += amp * this.nz(x * f + o * 31.7, y * f + o * 17.3); tot += amp; amp *= nn.gain; f *= nn.lacunarity; }
    v /= tot;
    return Math.sign(v) * Math.pow(Math.abs(v), nn.shape);
  }

  // st: {amp, settle (front band strength 0-1), expanding (Uint8Array per source), residueOn}
  render(img, st) {
    const L = img.data, f = this.field, m = f.margin, own = f.owner, nz = this.noise, px = f.fieldPx, W = f.W;
    const col = this.core.color, sp = this.motion.spread, res = this.motion.residue;
    const body = hex(col.walkshed), front = hex(col.walkshedFront), dot = hex(col.residueDot), ground = hex(col.residueGround);
    const k = Math.max(0, Math.min(1, st.settle ?? 1)); // the front band blends into the body as fronts land
    const aBody = Math.round(255 * sp.body), aFront = Math.round(255 * (sp.body + (sp.frontOpacity - sp.body) * k));
    for (let i = 0; i < 3; i++) front[i] = Math.round(body[i] + (front[i] - body[i]) * k);
    const frontW = sp.frontWidth, amp = st.amp;
    const fadeIn = res.fadeInMin, dsp = res.dotSpacing, dr2 = res.dotSize * res.dotSize, aGround = 255 * res.groundAlpha;
    const resid = this.residue, exp = st.expanding;
    for (let q = 0; q < px.length; q++) {
      const p = px[q], k = p * 4, me = m[p] + amp * nz[p];
      if (me <= 0) {
        const isFront = frontW > 0 && me > -frontW && own[p] >= 0 && exp[own[p]];
        const c = isFront ? front : body;
        L[k] = c[0]; L[k + 1] = c[1]; L[k + 2] = c[2]; L[k + 3] = isFront ? aFront : aBody;
      } else if (st.residueOn && resid[p]) {
        const fade = me === Infinity ? 1 : Math.min(1, me / fadeIn);
        const x = p % W, y = (p / W) | 0, gx = (x % dsp) - dsp / 2, gy = (y % dsp) - dsp / 2;
        if (gx * gx + gy * gy <= dr2) { L[k] = dot[0]; L[k + 1] = dot[1]; L[k + 2] = dot[2]; L[k + 3] = Math.round(255 * fade); }
        else { L[k] = ground[0]; L[k + 1] = ground[1]; L[k + 2] = ground[2]; L[k + 3] = Math.round(aGround * fade); }
      } else L[k + 3] = 0;
    }
  }
}
