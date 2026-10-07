/*
  ecobot/sim.js — robot EcoBot (penyapu) virtual untuk mode Demo dan pengujian.
  Urutan sensor, ambang batas, dan nama status sengaja sama dengan firmware (firmware/ecobot_uno):
    0 Depan, 1 Kiri-depan, 2 Kanan-depan, 3 Kiri, 4 Kanan, 5 Wadah (jarak ke permukaan sampah)
*/
(function (root) {
  'use strict';

  const core = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../shared/js/sim-core.js')
    : root.Kopak.sim;
  const { VirtualRobot, clamp, rnd } = core;

  const TH = { det: 50, near: 20, side: 10, binE: 20, binF: 4, binFull: 95 };
  const LIFT = { up: 80, down: 20 };
  const BRUSH = { min: 35, auto: 70, rampPerS: 100 / 0.6 };
  const FAR = [150, 120, 130, 90, 85];             // jarak "kosong" tiap sensor (cm)
  const SIDE = (i) => i === 3 || i === 4;
  const SWEEP_PWM = 110, AVOID_PWM = 130, STEER = 35;
  const AVOID_BACK_S = 0.45, TURN_EVERY_S = 12;

  function level(i, d) {
    if (d <= 0) return 0;
    if (d <= (SIDE(i) ? TH.side : TH.near)) return 2;
    if (d <= TH.det) return 1;
    return 0;
  }

  class EcoBotSim extends VirtualRobot {
    constructor(emit) {
      super(emit, { robot: 'ecobot', mode: 'M' });
      this.fw = '2.0.0-sim';
      this.forced = [0, 0, 0, 0, 0];                 // paksa level sensor 0..4 (demo)
      this.d = FAR.slice();
      this.binPct = 38;
      this.brushTarget = 0;
      this.brushOut = 0;
      this.brushOnS = 0;
      this.liftUp = true;                            // posisi istirahat: sapu terangkat
      this.lift = LIFT.up;
      this.state = 'manual';
      this.stT = 0;
      this.turnDir = 1;
      this.turnS = 0.7;
      this.sinceTurn = 0;
      this.binAcc = 0;
    }

    info() {
      return {
        t: 'info', robot: 'ecobot', kind: 'sweeper', fw: this.fw,
        us: ['Depan', 'Kiri-depan', 'Kanan-depan', 'Kiri', 'Kanan', 'Wadah'],
        pins: ['A0', 'A1', 'A2', 'A3', 'A4', 'D13'],
        th: { det: TH.det, near: TH.near, side: TH.side, binE: TH.binE, binF: TH.binF },
        lift: LIFT,
        brush: { pwm: 1, min: BRUSH.min, auto: BRUSH.auto },
      };
    }

    get binDist() { return TH.binE - (this.binPct / 100) * (TH.binE - TH.binF); }

    telemetry() {
      const t = this.commonTel();
      t.st = this.mode === 'M' ? 'manual' : this.state;
      t.d = this.d.map((v) => (v > 0 ? Math.round(v) : -1)).concat([Math.round(this.binDist)]);
      t.l = this.d.map((v, i) => level(i, v)).concat([0]);
      t.bin = Math.round(this.binPct);
      t.br = Math.round(this.brushOut);
      t.bt = this.brushTarget;
      t.lf = this.liftUp ? 1 : 0;
      t.la = Math.round(this.lift);
      t.sw = Math.floor(this.brushOnS);
      return t;
    }

    /** dipakai demo: klik kartu sensor -> paksa level 0/1/2 */
    force(idx, lvl) { if (idx >= 0 && idx < this.forced.length) this.forced[idx] = lvl; }
    /** dipakai demo: kosongkan wadah */
    resetBin() { this.binPct = 4; }

    _brush(pct) {
      pct = clamp(Math.round(pct), 0, 100);
      if (pct > 0 && pct < BRUSH.min) pct = BRUSH.min;
      this.brushTarget = pct;
    }

    command(cmd, a) {
      if (cmd === 'BRUSH') {
        if (this.mode !== 'M') return true;
        const v = Number(a[0]);
        if (isFinite(v)) this._brush(v);
        return true;
      }
      if (cmd === 'LIFT') {
        if (this.mode !== 'M') return true;
        this.liftUp = a[0] === '1';
        return true;
      }
      return false;
    }

    onModeChange() {
      this._brush(0);
      this.liftUp = true;
      this.state = this.mode === 'M' ? 'manual' : 'sweep';
      this.stT = 0;
      this.sinceTurn = 0;
      this.sp = 0;
    }
    onStop() { this.onModeChange(); }

    _go(state) { this.state = state; this.stT = 0; }

    step(dt) {
      // sensor menuju jarak target sesuai level paksa
      for (let i = 0; i < 5; i++) {
        const lv = this.forced[i];
        const target = lv === 0 ? FAR[i] : (lv === 1 ? 35 : (SIDE(i) ? 7 : 12));
        this.d[i] += (target + rnd(1.2) - this.d[i]) * Math.min(1, dt * 6);
      }

      // servo pengangkat & motor sapu bergerak halus (meniru firmware)
      const liftTarget = this.liftUp ? LIFT.up : LIFT.down;
      this.lift += clamp(liftTarget - this.lift, -200 * dt, 200 * dt);
      if (this.brushOut < this.brushTarget) {
        const start = this.brushOut === 0 ? BRUSH.min : this.brushOut;
        this.brushOut = Math.min(this.brushTarget, start + BRUSH.rampPerS * dt);
      } else {
        this.brushOut = this.brushTarget;
      }
      if (this.brushOut > 0) this.brushOnS += dt;

      this.stT += dt;
      if (this.mode === 'M') { this.sp = this.manualPwm(); this._fill(dt); return; }
      this._auto(dt);
      this._fill(dt);
    }

    // demo: wadah perlahan terisi selama sapu berputar sambil robot bergerak
    _fill(dt) {
      if (this.brushOut > 0 && this.sp > 0 && this.lift < LIFT.down + 10) {
        this.binPct = Math.min(100, this.binPct + dt * 0.35);
      }
    }

    _auto(dt) {
      const lv = this.d.map((v, i) => level(i, v));
      if (this.binPct >= TH.binFull) {
        if (this.state !== 'full') this._go('full');
        this.sp = 0; this._brush(0); this.liftUp = true;
        return;
      }
      if (this.state === 'full') { this._go('sweep'); this.sinceTurn = 0; }

      const blocked = lv[0] === 2 || lv[1] === 2 || lv[2] === 2;
      switch (this.state) {
        case 'sweep':
          this.liftUp = false;
          if (Math.abs(this.lift - LIFT.down) <= 10) this._brush(BRUSH.auto);
          this.sinceTurn += dt;
          if (blocked) { this._startTurn(this._freerSide(), 'avoid'); break; }
          if (this.sinceTurn > TURN_EVERY_S) { this._startTurn(Math.random() < 0.5 ? 1 : -1, 'turn'); break; }
          this.sp = (lv[3] === 2 || lv[4] === 2) ? SWEEP_PWM - STEER / 2 : SWEEP_PWM;
          break;
        case 'avoid':
          this._brush(0);
          this.liftUp = true;
          this.sp = AVOID_PWM;
          if (this.stT > AVOID_BACK_S + this.turnS) {
            // simulasi: setelah berputar, rintangan tidak lagi di depan robot
            for (let i = 0; i < 3; i++) this.forced[i] = 0;
            this._go('sweep'); this.sinceTurn = 0;
          }
          break;
        case 'turn':
          if (blocked) { this._startTurn(this._freerSide(), 'avoid'); break; }
          this.sp = AVOID_PWM;
          if (this.stT > this.turnS) { this._go('sweep'); this.sinceTurn = 0; }
          break;
        default:
          this._go('sweep');
      }
    }

    _startTurn(dir, state) {
      this.turnDir = dir;
      this.turnS = 0.45 + Math.random() * 0.55;
      this._go(state);
    }

    _freerSide() {
      const sp = (i) => (this.forced[i] === 0 ? FAR[i] : this.d[i]);
      const left = Math.min(sp(1), sp(3));
      const right = Math.min(sp(2), sp(4));
      if (Math.abs(left - right) < 5) return Math.random() < 0.5 ? 1 : -1;
      return right > left ? 1 : -1;
    }
  }

  const api = { EcoBotSim, factory: (emit) => new EcoBotSim(emit) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Kopak = root.Kopak || {}; root.Kopak.sim = Object.assign(root.Kopak.sim || {}, { EcoBotSim, ecobotFactory: api.factory }); }
})(typeof window !== 'undefined' ? window : globalThis);
