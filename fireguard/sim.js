/*
  fireguard/sim.js — robot FireGuard virtual untuk mode Demo dan pengujian.
  Angka ambang batas dan nama status sengaja sama dengan firmware
  (firmware/fireguard_uno), supaya tampilan demo = tampilan robot asli.
*/
(function (root) {
  'use strict';

  const core = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../shared/js/sim-core.js')
    : root.Kopak.sim;
  const { VirtualRobot, clamp, rnd } = core;

  const TH = { fw: 700, fd: 400, gw: 350, gd: 550, hyst: 40 };
  const FLAME_TARGET = [970, 560, 200];     // nilai ADC untuk level 0/1/2 (makin kecil makin dekat api)
  const GAS_TARGET = [180, 430, 660];
  const PUMP_MAX_ON_S = 15;
  const PUMP_REST_S = 3;
  const NOZ = { min: 40, max: 140, home: 90 };

  function flameLevel(prev, v) {
    if (v <= TH.fd || (prev === 2 && v <= TH.fd + TH.hyst)) return 2;
    if (v <= TH.fw || (prev >= 1 && v <= TH.fw + TH.hyst)) return 1;
    return 0;
  }
  function gasLevel(prev, v) {
    if (v >= TH.gd || (prev === 2 && v >= TH.gd - TH.hyst)) return 2;
    if (v >= TH.gw || (prev >= 1 && v >= TH.gw - TH.hyst)) return 1;
    return 0;
  }

  class FireGuardSim extends VirtualRobot {
    constructor(emit) {
      super(emit, { robot: 'fireguard', mode: 'A' });
      this.labels = ['Kiri', 'Kanan'];
      this.gasLabels = ['MQ-2'];
      this.fl = [970, 970];
      this.flForced = [0, 0];
      this.fs = [0, 0];
      this.gs = [180];
      this.gsForced = [0];
      this.gl = [0];
      this.state = 'idle';
      this.stT = 0;                 // lama berada di state sekarang (detik)
      this.calmT = 0;               // lama tanpa api (detik)
      this.warnT = 0;               // lama ada tanda api (detik)
      this.pumpAuto = false;
      this.pumpOnT = 0;
      this.manualPump = false;
      this.manualPumpAt = 0;
      this.noz = NOZ.home;
      this.nozTarget = NOZ.home;
      this.nozManual = NOZ.home;
    }

    info() {
      return {
        t: 'info', robot: 'fireguard', fw: this.fw,
        flame: this.labels, flamePins: ['A0', 'A1'],
        gas: this.gasLabels, gasPins: ['A3'],
        th: { fw: TH.fw, fd: TH.fd, gw: TH.gw, gd: TH.gd },
        noz: NOZ, pump: 1,
      };
    }

    get pumpOn() { return this.pumpAuto || this.manualPump; }

    telemetry() {
      const t = this.commonTel();
      t.st = this.mode === 'M' ? 'manual' : this.state;
      t.fl = this.fl.map(Math.round);
      t.fs = this.fs.slice();
      t.gs = this.gs.map(Math.round);
      t.gl = this.gl.slice();
      t.gw = this.uptime() < 4 ? 1 : 0;
      t.p = this.pumpOn ? 1 : 0;
      t.na = Math.round(this.noz);
      return t;
    }

    /** dipakai demo: klik kartu sensor -> paksa level 0/1/2 */
    force(kind, idx, level) {
      if (kind === 'flame' && idx < this.flForced.length) this.flForced[idx] = level;
      if (kind === 'gas' && idx < this.gsForced.length) this.gsForced[idx] = level;
    }

    command(cmd, a) {
      if (cmd === 'PUMP') {
        if (this.mode !== 'M') return true;
        this.manualPump = a[0] === '1';
        this.manualPumpAt = this.now();
        return true;
      }
      if (cmd === 'NOZ') {
        if (this.mode !== 'M') return true;
        const v = Number(a[0]);
        if (isFinite(v)) this.nozManual = clamp(Math.round(v), NOZ.min, NOZ.max);
        return true;
      }
      return false;
    }

    onModeChange() {
      this.manualPump = false;
      this.pumpAuto = false;
      this.state = 'idle';
      this.stT = 0;
      this.calmT = 0;
      this.warnT = 0;
      this.nozManual = NOZ.home;
    }
    onStop() { this.onModeChange(); }

    _go(state) { this.state = state; this.stT = 0; }

    step(dt, now) {
      // --- sensor: menuju nilai target + sedikit noise ---
      const k = Math.min(1, dt * 5);
      for (let i = 0; i < this.fl.length; i++) {
        const target = FLAME_TARGET[this.flForced[i]] + rnd(this.flForced[i] ? 25 : 10);
        this.fl[i] += (target - this.fl[i]) * k;
        this.fs[i] = flameLevel(this.fs[i], this.fl[i]);
      }
      const warm = this.uptime() < 4;
      for (let i = 0; i < this.gs.length; i++) {
        const target = warm ? 60 + this.uptime() * 30 : GAS_TARGET[this.gsForced[i]] + rnd(8);
        this.gs[i] += (target - this.gs[i]) * k;
        this.gl[i] = warm ? 0 : gasLevel(this.gl[i], this.gs[i]);
      }

      const anyWarn = this.fs.some((l) => l >= 1);
      const anyFire = this.fs.some((l) => l === 2);
      this.stT += dt;

      // --- pompa manual punya dead-man sendiri ---
      if (this.manualPump && now - this.manualPumpAt > 700) this.manualPump = false;

      if (this.mode === 'M') {
        this.pumpAuto = false;
        this.sp = this.manualPwm();
        this.nozTarget = this.nozManual;
      } else {
        this._auto(dt, anyWarn, anyFire);
      }

      // --- servo nozzle bergerak halus ---
      const maxMove = 160 * dt;
      this.noz += clamp(this.nozTarget - this.noz, -maxMove, maxMove);
    }

    _auto(dt, anyWarn, anyFire) {
      this.warnT = anyWarn ? this.warnT + dt : 0;
      this.calmT = anyWarn ? 0 : this.calmT + dt;

      switch (this.state) {
        case 'idle':
          this.sp = 0; this.pumpAuto = false; this.nozTarget = NOZ.home;
          if (this.warnT > 0.3) this._go(Math.abs(this.fs[0] - this.fs[this.fs.length - 1]) > 0 ? 'turn' : 'approach');
          break;
        case 'turn':
          this.sp = 150;
          if (anyFire) this._go('spray');
          else if (this.stT > 0.8) this._go('approach');
          else if (this.calmT > 2) this._go('idle');
          break;
        case 'approach':
          this.sp = 140;
          if (anyFire) this._go('spray');
          else if (this.calmT > 2) this._go('idle');
          break;
        case 'spray':
          this.sp = 0;
          this.pumpAuto = true;
          this.pumpOnT += dt;
          this.nozTarget = NOZ.home + 25 * Math.sin(this.stT * 3);
          if (this.calmT > 2.5) { this.pumpAuto = false; this.pumpOnT = 0; this._go('rest'); }
          else if (this.pumpOnT > PUMP_MAX_ON_S) { this.pumpAuto = false; this.pumpOnT = 0; this._go('rest'); }
          break;
        case 'rest':
          this.sp = 0; this.pumpAuto = false; this.nozTarget = NOZ.home;
          if (anyFire && this.stT > PUMP_REST_S) this._go('spray');
          else if (this.stT > 2.5 && !anyWarn) this._go('idle');
          else if (this.stT > PUMP_REST_S && anyWarn) this._go('approach');
          break;
        default:
          this._go('idle');
      }
    }
  }

  const api = { FireGuardSim, factory: (emit) => new FireGuardSim(emit) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Kopak = root.Kopak || {}; root.Kopak.sim = Object.assign(root.Kopak.sim || {}, { FireGuardSim, fireguardFactory: api.factory }); }
})(typeof window !== 'undefined' ? window : globalThis);
