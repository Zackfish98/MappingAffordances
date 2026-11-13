// Non-spread changes: park fills (parkDefault, then a continuous position on the five park load classes,
// blended in OKLab), landing pulses, and the plazas / Open Streets layer (faded in or out). Drawn as vector
// layers at device resolution.

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const css = ([r, g, b]) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
// core.json color.parkLoad keys, by load class (0 = under half the standard ... 4 = over 4x)
export const LOAD_KEYS = ["under_half", "at_or_under", "1_2x", "2_4x", "over_4x"];

// --- OKLab (Björn Ottosson) ---
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toSrgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export function oklab([r8, g8, b8]) {
  const r = toLin(r8), g = toLin(g8), b = toLin(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function rgbOf([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const c = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
             -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
             -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return c.map((v) => Math.max(0, Math.min(255, toSrgb(Math.max(0, Math.min(1, v))))));
}
const mixLab = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const easeInOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function ringsPath(rings) {
  const path = new Path2D();
  for (const r of rings) {
    path.moveTo(r[0], r[1]);
    for (let i = 2; i < r.length; i += 2) path.lineTo(r[i], r[i + 1]);
    path.closePath();
  }
  return path;
}

function ringsBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: Math.hypot(x1 - x0, y1 - y0) / 2 };
}

export class ParkLayer {
  // parks: data/parks.json parks; sourceOf: park id -> engine source index (or -1)
  constructor(parks, sourceOf, core, motion, W, H) {
    this.core = core; this.motion = motion; this.W = W; this.H = H;
    this.items = parks.map((p) => ({ id: p.id, s: sourceOf(p.id), path: ringsPath(p.rings), ...ringsBox(p.rings) }));
    this.bySource = new Map();
    this.items.forEach((it, i) => { if (it.s >= 0) (this.bySource.get(it.s) || this.bySource.set(it.s, []).get(it.s)).push(i); });
    this.all = new Path2D();
    for (const it of this.items) this.all.addPath(it.path);
    this.canvas = document.createElement("canvas");
    this.pulses = []; // {i: item, color: rgb, t0}
    this.dirty = true; // fills must be redrawn (the timeline sets this when colours move)
    this.setColors();
  }

  // Colour tokens to OKLab (call again if core.json colours change)
  setColors() {
    const c = this.core.color;
    this.defaultLab = oklab(hex(c.parkDefault));
    this.scaleLab = LOAD_KEYS.map((k) => oklab(hex(c.parkLoad[k])));
    this.cssCache = new Map();
    this.dirty = true;
  }

  // CSS colour for a class position and intro mix, cached at 1/64 steps (finer than the eye can tell apart)
  cssAt(x, intro) {
    const qx = Math.round(x * 64), qi = Math.round(intro * 64), key = qx * 65 + qi;
    let v = this.cssCache.get(key);
    if (!v) {
      const lab = this.labAt(qx / 64);
      v = css(rgbOf(qi >= 64 ? lab : mixLab(this.defaultLab, lab, qi / 64)));
      this.cssCache.set(key, v);
    }
    return v;
  }

  // Colour at a continuous class position (0 = under half ... 4 = over 4x), between class colours in OKLab
  labAt(x) {
    const n = this.scaleLab.length - 1, c = Math.max(0, Math.min(n, x)), i = Math.min(n - 1, Math.floor(c));
    return mixLab(this.scaleLab[i], this.scaleLab[i + 1], c - i);
  }
  classRgb(k) { return rgbOf(this.scaleLab[Math.max(0, Math.min(this.scaleLab.length - 1, k))]); }

  // One landing pulse around every park of source s, in its final class colour
  pulse(s, cls, now) {
    const color = this.classRgb(cls);
    for (const i of this.bySource.get(s) || []) this.pulses.push({ i, color, t0: now });
  }

  active(now) {
    this.pulses = this.pulses.filter((p) => now - p.t0 < this.motion.pulse.durationSec);
    return this.pulses.length > 0;
  }

  // Fills (only when dirty). coord: class position per source; intro: 0 = parkDefault ... 1 = on the scale;
  // revealed false = parkDefault
  draw(dpr, coord, intro, revealed) {
    const cv = this.canvas, c = cv.getContext("2d");
    if (cv.width !== Math.round(this.W * dpr)) { cv.width = Math.round(this.W * dpr); cv.height = Math.round(this.H * dpr); this.dirty = true; }
    if (!this.dirty) return;
    this.dirty = false;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    this.paint(c, [dpr, 0, 0], 1, coord, intro, revealed);
  }

  // Fills onto any canvas: view [scale (device px per grid px), offset x, offset y], lw scales the line widths
  paint(c, [s, ox, oy], lw, coord, intro, revealed) {
    c.setTransform(s, 0, 0, s, ox, oy);
    c.lineJoin = "round";
    c.strokeStyle = this.core.color.parkHalo; c.lineWidth = 1.6 * lw; c.stroke(this.all); // halo, merged under every park
    const groups = new Map(), def = css(rgbOf(this.defaultLab));
    for (const it of this.items) {
      const key = !revealed ? def : this.cssAt(it.s >= 0 ? coord[it.s] : 0, intro);
      if (!groups.has(key)) groups.set(key, new Path2D());
      groups.get(key).addPath(it.path);
    }
    for (const [color, path] of groups) { c.fillStyle = color; c.fill(path, "evenodd"); }
    c.strokeStyle = this.core.color.parkOutline; c.lineWidth = 0.5 * lw; c.stroke(this.all);
  }

  // Landing pulses, drawn straight onto the page canvas (c in device px): a ring that grows outward while its
  // stroke thins and fades
  drawPulses(c, dpr, now, ox = 0, oy = 0, lw = 1) {
    const P = this.motion.pulse;
    c.save();
    c.setTransform(dpr, 0, 0, dpr, ox, oy);
    for (const p of this.pulses) {
      const a = (now - p.t0) / P.durationSec;
      if (a < 0 || a >= 1) continue;
      const it = this.items[p.i], e = 1 - (1 - a) * (1 - a); // ease-out
      c.globalAlpha = 1 - a;
      c.strokeStyle = css(p.color);
      c.lineWidth = (P.strokeStartPx + (P.strokeEndPx - P.strokeStartPx) * a) * lw;
      c.beginPath(); c.arc(it.cx, it.cy, Math.max(1.5, it.r) + 1 + P.growPx * e, 0, 2 * Math.PI); c.stroke();
    }
    c.restore();
  }
}

export class PlaceLayer {
  // places: data/openstreets.json places; sourceOf: place id -> engine source index
  constructor(places, sourceOf, core, W, H) {
    this.core = core; this.W = W; this.H = H;
    this.items = places.map((p) => ({ id: p.id, kind: p.kind, s: sourceOf(p.id), path: ringsPath(p.rings), from: 0, to: 0, t0: 0, dur: 0 }));
    this.canvas = document.createElement("canvas");
    this.dirty = true;
  }

  alpha(it, now) {
    if (it.dur <= 0 || now >= it.t0 + it.dur) return it.to;
    return it.from + (it.to - it.from) * Math.max(0, (now - it.t0) / it.dur);
  }

  // on: per source, 1 = shown; changes fade over dur seconds
  set(on, now, dur = 0) {
    let changed = false;
    for (const it of this.items) {
      const to = it.s >= 0 && on[it.s] ? 1 : 0;
      if (to !== it.to) changed = true;
      it.from = dur > 0 ? this.alpha(it, now) : to; it.to = to; it.t0 = now; it.dur = dur;
    }
    this.dirty = true;
    return changed;
  }

  fading(now) { return this.items.some((it) => it.dur > 0 && now < it.t0 + it.dur); }

  draw(dpr, now) {
    const cv = this.canvas, c = cv.getContext("2d");
    if (cv.width !== Math.round(this.W * dpr)) { cv.width = Math.round(this.W * dpr); cv.height = Math.round(this.H * dpr); this.dirty = true; }
    if (!this.dirty && !this.fading(now)) return;
    this.dirty = false;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    this.paint(c, [dpr, 0, 0], 1, now);
  }

  // onto any canvas: view [scale, offset x, offset y] as ParkLayer.paint, lw scales the line widths
  paint(c, [s, ox, oy], lw, now) {
    c.setTransform(s, 0, 0, s, ox, oy);
    c.lineJoin = "round"; c.lineCap = "round";
    // footprints are narrower than a grid pixel, so each is drawn as a cased line along its outline
    for (const pass of ["casing", "fill"]) {
      for (const it of this.items) {
        const a = this.alpha(it, now);
        if (a <= 0) continue;
        c.globalAlpha = a;
        if (pass === "casing") { c.strokeStyle = this.core.color.openStreetCasing; c.lineWidth = 2.4 * lw; c.stroke(it.path); }
        else { c.strokeStyle = c.fillStyle = this.core.color.openStreet; c.lineWidth = 1.2 * lw; c.stroke(it.path); c.fill(it.path); }
      }
    }
    c.globalAlpha = 1;
  }
}
