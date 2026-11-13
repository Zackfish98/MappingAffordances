// "Residents with access" table, ported from access-table-story.html. Same look and the same motion, but
// driven by the story clock (update(now) every frame) instead of CSS transitions and timers, so it stays in step
// with the map and renders frame by frame in the video export.
//
// The table follows the timeline's steps: setStage(stageId, animate, now). data/access_table.json maps each
// story stage to a table state (null = hidden, pre, post, osWeekend, osAllWeek) and holds the numbers.
// Motion per step (motion.json "table"):
// - hidden -> shown: switches on from a point (dot -> horizontal line -> opens to full height) with the Total
//   row; after beatBeforeCdbgSec the CDBG Eligible vs. Non row opens downward;
// - a new state: the change rows open (once), then every value ticks to the new numbers over tickSec
//   (ease-out cubic) while the changes count up from where they are (from 0 when the rows first open);
// - the same state (the park-load step): no change. Snaps (no motion) unless animate.
// Change = % change from before calibration (relative, rounded: dTotal / dElig / dNon in the data, as
// statistics_progression.ipynb); arrows and colours by its sign.

const FIELDS = ["total", "elig", "non"];

// CSS cubic-bezier timing functions
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = X(t) - x, d = dX(t); if (Math.abs(e) < 1e-6 || !d) break; t -= e / d; }
    let lo = 0, hi = 1;
    for (let i = 0; i < 30 && Math.abs(X(t) - x) > 1e-6; i++) { if (X(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return Y(t);
  };
}
const EASE = bezier(0.25, 0.1, 0.25, 1);          // CSS "ease"
const LINE = bezier(0.5, 0, 0.2, 1);              // switch-on: point -> line
const OPEN_TV = bezier(0.2, 0.8, 0.2, 1);         // switch-on: line -> full height
const OPEN_ROW = bezier(0.3, 0.7, 0.2, 1);        // rows opening downward
const OUT_CUBIC = (k) => 1 - Math.pow(1 - k, 3);  // number ticks
const LINEAR = (k) => Math.max(0, Math.min(1, k));

// A value moving from a to b, starting at t0 (after delay) over dur seconds
class Tween {
  constructor(a, b, t0 = -Infinity, dur = 0, ease = LINEAR, delay = 0) { Object.assign(this, { a, b, t0, dur, ease, delay }); }
  at(now) {
    if (this.dur <= 0) return now >= this.t0 + this.delay ? this.b : this.a;
    const k = (now - this.t0 - this.delay) / this.dur;
    return this.a + (this.b - this.a) * this.ease(Math.max(0, Math.min(1, k)));
  }
}
const still = (v) => new Tween(v, v);

export class AccessTable {
  constructor(root, data, core, motion) {
    Object.assign(this, { root, data, core, motion });
    this.areas = data.areas.map((a) => a.key);
    const T = core.table;
    root.classList.add("access-table");
    const vars = { "--ink": T.ink, "--title": T.title, "--eligible": T.eligible, "--separator": T.separator,
                   "--increase": T.increase, "--decrease": T.decrease,
                   "--font-title": `"${T.fontTitle}", "Helvetica Neue", Arial, sans-serif`,
                   "--font-data": `${T.fontData.map((f) => `"${f}"`).join(", ")}, ui-monospace, monospace`,
                   "--lab-pt": T.labelColPt, "--col-pt": T.boroughColPt, "--head-pt": T.headRowPt, "--row-pt": T.rowPt,
                   "--rule-outer-pt": T.ruleOuterPt, "--rule-inner-pt": T.ruleInnerPt, "--title-pt": T.titlePt, "--fs": T.dataPt };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    this.build();
    this.key = null;   // table state shown (null = hidden)
    this.cur = new Map();
    this.snap(null);
  }

  build() {
    const pc = (v) => `<span class="pc">%</span><span class="dg">${v}</span>`;
    const A = this.data.areas;
    const total = (a) => `<span class="num t" data-k="${a}.total">${pc(0)}</span>`;
    const split = (a) => `<span class="split"><span class="num p elig" data-k="${a}.elig">${pc(0)}</span><span class="sep">/</span><span class="num p" data-k="${a}.non">${pc(0)}</span></span>`;
    const dnum = (a, f, side, cls) => `<span class="num ${cls}" data-d="${a}.${f}" data-side="${side}">${pc(0)}<i class="arr ${side}-side" aria-hidden="true"></i></span>`;
    this.root.innerHTML =
      `<div class="screen"><div class="scanline"></div><h1>Residents with access</h1><div class="acc">` +
      `<div class="r head"><div class="lab"></div>${A.map((a) => `<div class="c">${a.label}</div>`).join("")}</div>` +
      `<div class="r box first" data-row="total"><div class="lab">Total</div>${A.map((a) => `<div class="c">${total(a.key)}</div>`).join("")}</div>` +
      `<div class="delta" data-row="total"><div class="r"><div class="lab"></div>${A.map((a) => `<div class="c"><span class="val">${dnum(a.key, "total", "r", "t")}</span></div>`).join("")}</div></div>` +
      `<div class="grow"><div class="r box last" data-row="cdbg"><div class="lab">CDBG&nbsp;<span class="elig">Eligible</span>&nbsp;vs.&nbsp;Non</div>${A.map((a) => `<div class="c">${split(a.key)}</div>`).join("")}</div></div>` +
      `<div class="delta" data-row="cdbg"><div class="r"><div class="lab"></div>${A.map((a) => `<div class="c"><span class="val"><span class="split">${dnum(a.key, "elig", "l", "p")}<span class="sep dsep" data-a="${a.key}">/</span>${dnum(a.key, "non", "r", "p")}</span></span></div>`).join("")}</div></div>` +
      `</div></div>`;
    const q = (s) => this.root.querySelector(s), qa = (s) => [...this.root.querySelectorAll(s)];
    this.el = {
      screen: q(".screen"), scan: q(".scanline"), grow: q(".grow"), growBox: q(".grow .box"),
      dTotal: q('.delta[data-row="total"]'), dCdbg: q('.delta[data-row="cdbg"]'), vals: qa(".delta .val"),
      totalCells: qa('.box[data-row="total"] .c'), cdbgCells: qa('.box[data-row="cdbg"] .c'), seps: qa(".dsep"),
      nums: new Map(qa("[data-k]").map((n) => [n.dataset.k, n])), deltas: new Map(qa("[data-d]").map((n) => [n.dataset.d, n])),
    };
  }

  values(key) { return this.data.values[key]; }
  change(key, a, f) { return this.data.values[key][a]["d" + f.charAt(0).toUpperCase() + f.slice(1)]; }

  // --- numbers ---
  setNum(el, v) { el.querySelector(".dg").textContent = Math.round(Math.abs(v)); }
  styleDelta(el, v) {
    const d = v > 0.5 ? "up" : v < -0.5 ? "down" : "flat";
    el.classList.remove("up", "down", "flat"); el.classList.add(d);
    el.querySelector(".arr").textContent = d === "up" ? "▲" : d === "down" ? "▼" : "";
  }
  styleSeps(key) { // a change row's slash takes the shared direction, or stays blue when the sides disagree
    for (const s of this.el.seps) {
      const a = s.dataset.a, de = this.change(key, a, "elig"), dn = this.change(key, a, "non");
      s.className = "sep dsep" + (Math.sign(de) === Math.sign(dn) && de ? (de > 0 ? " up" : " down") : "");
    }
  }
  snapNumbers(key) {
    const D = this.values(key);
    for (const a of this.areas) for (const f of FIELDS) {
      const k = `${a}.${f}`, dv = this.change(key, a, f);
      this.cur.set(k, D[a][f]); this.setNum(this.el.nums.get(k), D[a][f]);
      const el = this.el.deltas.get(k); this.cur.set(`d:${k}`, dv); this.setNum(el, dv); this.styleDelta(el, dv);
    }
    this.styleSeps(key);
    this.tick = null; this.pendingTick = null;
  }
  startTick(key, now) {
    const D = this.values(key), targets = [];
    for (const a of this.areas) for (const f of FIELDS) {
      const k = `${a}.${f}`;
      targets.push({ k, el: this.el.nums.get(k), from: this.cur.get(k) ?? 0, to: D[a][f] });
      targets.push({ k: `d:${k}`, el: this.el.deltas.get(k), from: this.cur.get(`d:${k}`) ?? 0, to: this.change(key, a, f), delta: true });
    }
    for (const t of targets) if (t.delta) this.styleDelta(t.el, t.to);
    this.styleSeps(key);
    this.tick = { targets, t0: now };
  }

  // --- states ---
  snap(key) {
    const shown = key !== null && key !== undefined;
    this.key = shown ? key : null;
    this.screenOn = shown;
    this.tLine = this.tOn = -Infinity;
    this.solo = still(shown ? 0 : 1); this.soloB = still(shown ? 0 : 1); this.growOp = still(shown ? 1 : 0);
    const open = shown && key !== "pre" ? 1 : 0;
    this.open = still(open); this.openB = still(open); this.valOp = still(open);
    this.pendingOpen = null;
    this.snapNumbers(shown ? key : "pre");
  }

  setStage(stageId, animate, now) {
    const key = this.data.stages[stageId] ?? null;
    if (!animate) { this.snap(key); return; }
    if (key === null) { this.snap(null); return; }
    const M = this.motion.table;
    if (this.key === null) { // switch on from a point, Total only; a beat; then CDBG opens downward
      this.snap("pre"); this.key = key;
      this.solo = still(1); this.soloB = still(1); this.growOp = still(0);
      this.screenOn = false; this.tLine = now; this.tOn = now + M.switchOnLineSec;
      const tCdbg = now + M.switchOnLineSec + M.switchOnOpenSec + M.beatBeforeCdbgSec;
      this.solo = new Tween(1, 0, tCdbg, M.rowOpenSec, OPEN_ROW);
      this.soloB = new Tween(1, 0, tCdbg, M.rowOpenSec, EASE);
      this.growOp = new Tween(0, 1, tCdbg, M.textFadeSec, EASE, M.rowOpenSec * 0.4);
      if (key !== "pre") this.pendingOpen = { key, t: tCdbg + M.rowOpenSec };
      return;
    }
    if (key === this.key) return; // e.g. the park-load step
    this.key = key;
    this.openRows(key, now);
  }

  openRows(key, now) {
    const M = this.motion.table;
    const opening = this.open.b < 1;
    if (opening) {
      this.open = new Tween(0, 1, now, M.rowOpenSec, OPEN_ROW);
      this.openB = new Tween(0, 1, now, M.rowOpenSec, EASE);
      this.valOp = new Tween(0, 1, now, M.textFadeSec, EASE, M.rowOpenSec * 0.55);
      for (const a of this.areas) for (const f of FIELDS) this.cur.set(`d:${a}.${f}`, 0); // changes count up from 0
      this.pendingTick = { key, t: now + M.rowOpenSec * 0.55 };
    } else {
      this.startTick(key, now);
    }
  }

  // Every number and its change share one width (the widest value either shows across all stages), so "%" sits
  // under "%" and the last digit under the last digit. Call when fonts load and on resize.
  align() {
    const T = this.core.table;
    if (!document.fonts.check(`10px "${T.fontData[0]}"`)) this.root.style.setProperty("--fs", T.dataPtFallback);
    const states = Object.keys(this.data.values);
    for (const [k, n] of this.el.nums) {
      const [a, f] = k.split("."), m = this.el.deltas.get(k), dg = n.querySelector(".dg"), mg = m.querySelector(".dg");
      n.style.width = m.style.width = "";
      const keepN = dg.textContent, keepM = mg.textContent;
      let w = 0;
      for (const s of states) {
        dg.textContent = this.values(s)[a][f]; w = Math.max(w, n.getBoundingClientRect().width);
        mg.textContent = Math.abs(this.change(s, a, f)); w = Math.max(w, m.getBoundingClientRect().width);
      }
      dg.textContent = keepN; mg.textContent = keepM;
      n.style.width = m.style.width = w + "px";
    }
  }

  // Size: 1 = the InDesign table (1 pt = 1.3333 CSS px)
  setScale(s) {
    if (s === this.scale) return;
    this.scale = s;
    this.root.style.setProperty("--scale", s);
    this.align();
  }

  // --- per frame ---
  update(now) {
    const M = this.motion.table, e = this.el;
    if (this.pendingOpen && now >= this.pendingOpen.t) { const p = this.pendingOpen; this.pendingOpen = null; this.openRows(p.key, p.t); }
    if (this.pendingTick && now >= this.pendingTick.t) { const p = this.pendingTick; this.pendingTick = null; this.startTick(p.key, p.t); }
    // switch-on clip: point -> horizontal line -> full height (inset in px of the current box)
    const W = e.screen.offsetWidth, H = e.screen.offsetHeight;
    let clip, scan = 0;
    if (this.key === null) clip = [H / 2, W / 2, H / 2, W / 2];
    else if (this.screenOn || now >= this.tOn + M.switchOnOpenSec) clip = [-4, -40, -4, -4];
    else if (now < this.tOn) {
      const p = LINE((now - this.tLine) / M.switchOnLineSec);
      clip = [H / 2 + (-1) * p, W / 2 * (1 - p), H / 2 + (-1) * p, W / 2 * (1 - p)];
      scan = LINEAR((now - this.tLine) / 0.08);
    } else {
      const q = OPEN_TV((now - this.tOn) / M.switchOnOpenSec);
      const from = [H / 2 - 1, 0, H / 2 - 1, 0], to = [-4, -40, -4, -4];
      clip = from.map((v, i) => v + (to[i] - v) * q);
      scan = 1 - LINEAR((now - this.tOn - 0.12) / 0.2);
    }
    e.screen.style.clipPath = `inset(${clip.map((v) => v.toFixed(2) + "px").join(" ")})`;
    e.scan.style.opacity = scan;

    const u = 1.3333 * (this.scale || 1), hRow = this.core.table.rowPt * u;
    const outer = Math.max(1, this.core.table.ruleOuterPt * u), inner = Math.max(0.5, this.core.table.ruleInnerPt * u);
    const solo = this.solo.at(now), soloB = this.soloB.at(now), open = this.open.at(now), openB = this.openB.at(now);
    e.grow.style.height = `${(1 - solo) * hRow}px`;
    e.growBox.style.opacity = this.growOp.at(now);
    e.dTotal.style.height = `${open * hRow}px`;
    e.dCdbg.style.height = `${Math.min(open, 1 - solo) * hRow}px`;
    const vo = this.valOp.at(now);
    for (const v of e.vals) v.style.opacity = vo; // (the prototype's slide is on inline spans, which browsers don't transform)
    // rules: Total closes its own box while alone; every box gets outer rules top and bottom once the change rows open
    for (const c of e.totalCells) { c.style.borderTopWidth = `${outer}px`; c.style.borderBottomWidth = `${outer * Math.max(soloB, openB)}px`; }
    for (const c of e.cdbgCells) { c.style.borderTopWidth = `${inner + (outer - inner) * openB}px`; c.style.borderBottomWidth = `${outer}px`; }

    if (this.tick) {
      const k = M.tickSec > 0 ? Math.min(1, (now - this.tick.t0) / M.tickSec) : 1, ek = OUT_CUBIC(k);
      for (const t of this.tick.targets) { const v = t.from + (t.to - t.from) * ek; this.cur.set(t.k, v); this.setNum(t.el, v); }
      if (k >= 1) this.tick = null;
    }
  }

  busy(now) { return !!(this.tick || this.pendingTick || this.pendingOpen) || now < this.tOn + 2 || now < this.solo.t0 + 2 || now < this.open.t0 + 1; }
}
