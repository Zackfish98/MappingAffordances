// Plays story.json: each step enters (cut, spread or revealParkLoad), then holds; play / pause / step / replay.
// Works for any order or subset of steps: a step always starts from the end of the step before it in the
// story (the first from nothing: no walksheds, no park load, no residue, no plazas or Open Streets).
//
// Time is advanced explicitly (advance(dt)), so the same code runs live and under a virtual clock (video).
// Spread motion runs at motion.spread.rateMinPerSec x motion.playback.speed; reveals, pulses and holds in
// plain seconds.
//
// Park colour is a continuous position on the five load classes (coord: 0 = under half the standard ...
// 4 = over 4x; class colours sit at the whole numbers, class breaks at the halves), so during a spread a
// park's fill follows its load at the current reach. When a source lands on its target reach its fill
// settles on its final class colour, and if that class differs from where it started it pulses once.

import { easeInOut } from "./reveal.js";

const NONE = -0.01; // a straight-line radius that covers nothing (distances are >= 0)

export class Timeline {
  constructor({ story, stages, field, spread, parks, places, core, motion }) {
    Object.assign(this, { story, stages, field, spread, parks, places, core, motion });
    this.steps = story.steps;
    const doc = stages[this.steps[0].stage];
    this.ids = doc.sources.map((r) => r.id);
    this.kinds = doc.sources.map((r) => r.kind);
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    const n = (this.nS = this.ids.length);
    this.rt = new Float64Array(n);
    this.rd = new Float64Array(n).fill(Infinity);
    this.cls = new Int8Array(n);             // load class at the current state (final class once landed)
    this.coord = new Float32Array(n);        // displayed class position
    this.curve = new Array(n).fill(null);
    this.placeOn = new Uint8Array(n);
    this.expanding = new Uint8Array(n);
    this.startC = new Float32Array(n); this.landC = new Float32Array(n); this.tLand = new Float64Array(n).fill(-1);
    this.tracking = [];                      // sources whose colour is still moving
    this.revealed = false;
    this.intro = 0;                          // park fills: 0 = parkDefault ... 1 = on the load scale
    this.residueOn = false;
    this.clock = 0;    // seconds since load, drives fades and pulses
    this.amp = 0;      // current edge roughness (minutes), settles to 0 when every front has arrived
    this.settle = 0;   // 1 while fronts move, easing in over the first and out over the last spread.settleMin (front band and rough edge)
    this.dirty = true; // reaches changed: coverage must be recomputed
    this.cache = {};
    this.seeks = 0;
    this.k = 0; this.phase = "enter"; this.sub = null; this.inStep = 0; this.done = false;
  }

  stageState(id) {
    if (this.cache[id]) return this.cache[id];
    const doc = this.stages[id];
    if (!doc) throw new Error(`no stage data for ${id}`);
    const n = this.nS, st = { rt: new Float64Array(n), rd: new Float64Array(n).fill(Infinity), cls: new Int8Array(n),
                               curve: new Array(n).fill(null), placeOn: new Uint8Array(n) };
    for (const r of doc.sources) {
      const s = this.index.get(r.id);
      if (s === undefined || !r.active) continue;
      st.rt[s] = r.minutes;
      st.rd[s] = r.radiusMin === null ? Infinity : r.radiusMin;
      st.cls[s] = r.loadClass;
      st.curve[s] = r.loadAtMinute ? Float32Array.from(r.loadAtMinute) : null;
      if (r.kind !== "park") st.placeOn[s] = 1;
    }
    st.step = doc.loadStepMin;
    return (this.cache[id] = st);
  }

  zeroState() {
    const n = this.nS;
    return { rt: new Float64Array(n), rd: new Float64Array(n).fill(Infinity), cls: new Int8Array(n),
             curve: new Array(n).fill(null), placeOn: new Uint8Array(n) };
  }

  flagsAt(k) { // after step k (cumulative over the story order)
    const done = this.steps.slice(0, k + 1);
    return { revealed: done.some((s) => s.enter === "revealParkLoad"), residueOn: done.some((s) => s.residue === "draw") };
  }

  apply(st, flags) {
    this.copyReach(st);
    this.placeOn.set(st.placeOn);
    this.revealed = flags.revealed; this.intro = flags.revealed ? 1 : 0; this.residueOn = flags.residueOn;
    this.expanding.fill(0); this.amp = 0;
    for (let s = 0; s < this.nS; s++) this.coord[s] = this.cls[s];
    this.tracking = []; this.parks.pulses = []; this.parks.dirty = true;
    this.places.set(this.placeOn, this.clock, 0);
  }

  copyReach(st) {
    this.rt.set(st.rt); this.rd.set(st.rd); this.cls.set(st.cls);
    this.curve = st.curve.slice(); this.dirty = true;
  }

  // Jump to the start of step k
  seek(k) {
    k = Math.max(0, Math.min(this.steps.length - 1, k));
    this.seeks = (this.seeks || 0) + 1; // jumps (the table snaps instead of animating)
    if (k === 0) this.apply(this.zeroState(), { revealed: false, residueOn: false });
    else this.apply(this.stageState(this.steps[k - 1].stage), this.flagsAt(k - 1));
    this.k = k; this.done = false;
    this.startStep();
  }

  startStep() {
    const step = this.steps[this.k];
    const target = (this.target = this.stageState(step.stage));
    this.phase = "enter"; this.inStep = 0; this.subT = 0; this.holdT = 0;
    if (step.residue === "draw") this.residueOn = true;
    if (step.enter === "revealParkLoad") {
      this.copyReach(target);
      this.places.set(target.placeOn, this.clock, 0);
      this.revealed = true; this.intro = 0;
      this.coord.fill(0); this.tracking = []; this.parks.dirty = true;
      this.maxCls = Math.max(0, ...this.cls);
      this.sub = "intro";
    } else if (step.enter === "spread") {
      this.prepareMotion(target);
      const changed = this.places.set(target.placeOn, this.clock, this.motion.reveal.openStreetsSec);
      this.placeOn.set(target.placeOn);
      this.sub = changed ? "places" : "motion";
    } else { // "cut" (and anything unknown)
      this.apply(target, this.flagsAt(this.k));
      this.phase = "hold";
    }
  }

  // Class position of a load: class colours at whole numbers, breaks (0.5x, 1x, 2x, 4x the standard) at halves
  classPos(load) {
    const m = load / this.core.load.standard;
    if (!(m > 0)) return 0;
    return Math.max(0, Math.min(this.core.load.classMultiples.length, Math.log2(m) + 1.5));
  }

  loadAt(s, r) {
    const c = this.curve[s];
    if (!c) return 0;
    const full = this.core.walk.fullMinutes, step = this.target.step;
    const x = Math.max(0, Math.min(full, isFinite(r) ? r : full)) / step;
    const i = Math.min(c.length - 2, Math.floor(x)), a = x - i;
    return c[i] + (c[i + 1] - c[i]) * a;
  }

  // Every source's reach moves from here to the target at one rate (walking and straight-line, in minutes)
  prepareMotion(target) {
    const full = this.core.walk.fullMinutes;
    this.moves = [];
    this.moveMax = 0;
    this.tStart = this.clock;
    this.tracking = [];
    this.tLand.fill(-1);
    for (let s = 0; s < this.nS; s++) {
      const rt0 = this.rt[s], rt1 = target.rt[s], rd0 = this.rd[s], rd1 = target.rd[s];
      const fr = this.field.fullRadius(s) || full;
      // Every move runs on the straight-line radius (the calibration's own measure), clipped to the walkshed:
      // a walkshed appearing gets its full shape at once and is revealed by a radius growing from nothing; one
      // leaving shrinks its radius to nothing, then switches off; calibrated ones pull in or out to their reach.
      const appear = rt0 <= 0 && rt1 > 0, leave = rt0 > 0 && rt1 <= 0;
      let rd0m = isFinite(rd0) ? rd0 : Math.max(fr, isFinite(rd1) ? rd1 : fr);
      let rd1m = isFinite(rd1) ? rd1 : Math.max(fr, rd0m);
      if (appear) { this.rt[s] = rt1; rd0m = NONE; this.rd[s] = NONE; }
      if (leave) rd1m = NONE;
      let rdMove = (appear || leave || rt0 > 0) && !(rd0 === Infinity && rd1 === Infinity && !appear && !leave);
      if (rdMove && !isFinite(this.rd[s])) this.rd[s] = rd0m;  // same coverage, now a finite radius
      if (rdMove && Math.abs(rd1m - rd0m) < 1e-9) rdMove = false;
      const rtMove = !appear && !leave ? Math.abs(rt1 - rt0) : 0; // (walking reach itself no longer animates)
      const dist = Math.max(rtMove, rdMove ? Math.abs(rd1m - rd0m) : 0);
      this.curve[s] = target.curve[s];
      this.startC[s] = this.coord[s];
      const startCls = this.cls[s];
      this.cls[s] = target.cls[s]; // final class; the fill gets there through coord
      if (dist > 0) {
        this.moves.push({ s, rt0: appear ? rt1 : rt0, rt1: leave ? rt0 : rt1, rtOff: leave, rd0m, rd1m, rdMove,
                          rdInfEnd: !isFinite(rd1) && !leave, dist, startCls });
        this.expanding[s] = rdMove && rd1m > rd0m ? 1 : 0;
        this.moveMax = Math.max(this.moveMax, dist);
        if (rdMove) { this.tracking.push(s); continue; }
      }
      // no straight-line motion: already at its target reach, so it lands now
      if (startCls !== this.cls[s] || this.coord[s] !== this.cls[s]) this.land(s, startCls);
    }
    this.tMove = 0;
  }

  land(s, startCls) {
    this.landC[s] = this.coord[s];
    this.tLand[s] = this.clock;
    if (!this.tracking.includes(s)) this.tracking.push(s);
    if (this.revealed && startCls !== this.cls[s] && this.kinds[s] === "park") this.parks.pulse(s, this.cls[s], this.clock);
  }

  // Colour positions: moving sources follow their load (blended in from where they started); landed sources
  // settle on their final class over the pulse's duration
  updateCoords() {
    const dur = this.motion.pulse.durationSec, now = this.clock;
    const keep = [];
    for (const s of this.tracking) {
      if (this.tLand[s] < 0) {
        const lc = this.classPos(this.loadAt(s, this.rd[s]));
        const a = easeInOut(dur > 0 ? (now - this.tStart) / dur : 1);
        this.coord[s] = this.startC[s] + (lc - this.startC[s]) * a;
        keep.push(s);
      } else {
        const b = easeInOut(dur > 0 ? (now - this.tLand[s]) / dur : 1);
        this.coord[s] = this.landC[s] + (this.cls[s] - this.landC[s]) * b;
        if (b < 1) keep.push(s);
      }
    }
    this.tracking = keep;
    this.parks.dirty = true;
  }

  stepMotion(dt) {
    this.tMove += dt;
    const v = this.motion.spread.rateMinPerSec * this.motion.playback.speed, go = v * this.tMove;
    for (const m of this.moves) {
      const a = Math.min(go, m.dist);
      const rt = m.rt0 + Math.sign(m.rt1 - m.rt0) * Math.min(a, Math.abs(m.rt1 - m.rt0));
      if (rt !== this.rt[m.s]) { this.rt[m.s] = rt; this.dirty = true; }
      if (m.rdMove) {
        let rd = m.rd0m + Math.sign(m.rd1m - m.rd0m) * Math.min(a, Math.abs(m.rd1m - m.rd0m));
        if (go >= m.dist && m.rdInfEnd) rd = Infinity;
        if (rd !== this.rd[m.s]) { this.rd[m.s] = rd; this.dirty = true; }
      }
      if (go >= m.dist && !m.arrived) {
        m.arrived = true; this.expanding[m.s] = 0;
        if (m.rtOff) { this.rt[m.s] = 0; this.rd[m.s] = Infinity; this.dirty = true; } // left: switched off
        if (m.rdMove) this.land(m.s, m.startCls);
      }
    }
    const remaining = Math.max(0, this.moveMax - go);
    const sp = this.motion.spread;
    this.settle = sp.settleMin > 0 ? Math.min(1, go / sp.settleMin, remaining / sp.settleMin) : remaining > 0 ? 1 : 0; // eases in and out
    this.amp = sp.rough * this.settle; // the rough edge and the front band fade out together as the last fronts land
    return remaining <= 0;
  }

  // revealParkLoad: parkDefault -> lightest class, then every park climbs the scale at one rate to its class (no pulses)
  stepReveal() {
    const lr = this.motion.loadReveal, top = this.core.load.classMultiples.length;
    if (this.sub === "intro") {
      this.intro = easeInOut(lr.introSec > 0 ? this.subT / lr.introSec : 1);
      this.parks.dirty = true;
      if (this.subT >= lr.introSec) { this.intro = 1; this.sub = "climb"; this.subT = 0; }
      return false;
    }
    const level = lr.climbTotalSec > 0 ? (this.subT * top) / lr.climbTotalSec : top;
    this.parks.dirty = true;
    for (let s = 0; s < this.nS; s++) {
      const c = this.cls[s];
      this.coord[s] = Math.min(c, level);
    }
    return level >= this.maxCls;
  }

  finishEnter() {
    const t = this.target;
    this.rt.set(t.rt); this.rd.set(t.rd); this.dirty = true;
    this.placeOn.set(t.placeOn);
    this.expanding.fill(0); this.amp = 0; this.settle = 0;
    this.phase = "hold";
  }

  advance(dt) {
    if (this.done) return;
    this.clock += dt;
    this.inStep += dt;
    if (this.phase === "enter") {
      this.subT += dt;
      if (this.sub === "intro" || this.sub === "climb") {
        if (this.stepReveal()) { this.coord.set(this.cls); this.parks.dirty = true; this.finishEnter(); }
      } else if (this.sub === "places") {
        if (this.subT >= this.motion.reveal.openStreetsSec) { this.sub = "beat"; this.subT = 0; }
      } else if (this.sub === "beat") { // plazas / Open Streets have appeared or left; the walksheds wait a beat
        if (this.subT >= this.motion.reveal.beatSec) { this.sub = "motion"; this.subT = 0; this.tStart = this.clock; }
      } else if (this.sub === "motion") {
        if (this.stepMotion(dt)) this.finishEnter();
      }
    } else if (this.phase === "hold") {
      const hold = this.steps[this.k].holdSec || 0;
      this.holdT += dt;
      if (this.holdT >= hold) {
        this.holdT = 0;
        if (this.k + 1 < this.steps.length) { this.k++; this.startStep(); }
        else this.done = true;
      }
    }
    if (this.tracking.length) this.updateCoords();
  }

  busy() { return this.tracking.length > 0 || this.parks.active(this.clock); }

  status() {
    const step = this.steps[this.k];
    return { k: this.k, stage: step.stage, phase: this.phase, sub: this.sub, done: this.done, inStep: this.inStep };
  }
}
