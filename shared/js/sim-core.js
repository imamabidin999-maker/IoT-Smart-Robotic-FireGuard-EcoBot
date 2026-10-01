/*
  sim-core.js — robot virtual.

  Berperilaku seperti firmware Arduino: menerima perintah teks satu baris
  ("MODE A", "DRV 20 80", ...), mengirim telemetri JSON 4x/detik, dan punya
  dead-man timer (gerak manual berhenti kalau perintah DRV tidak diperbarui).
  Dipakai di dua tempat:
    - mode Demo di browser (lewat fireguard/sim.js dan ecobot/sim.js)
    - tools/mock-robot (server WebSocket/MQTT palsu untuk pengujian)
  Makanya file ini ditulis supaya bisa jalan di browser maupun Node.
*/
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rnd = (amp) => (Math.random() * 2 - 1) * amp;

  const MIN_PWM = 70;
  const DEADMAN_MS = 600;
  const TEL_EVERY_MS = 250;
  const STEP_MS = 50;

  class VirtualRobot {
    /**
     * @param {function(string)} emit  dipanggil dengan satu baris JSON
     * @param {{robot:string, mode:string, bootMs?:number}} o
     */
    constructor(emit, o) {
      this.emitLine = emit;
      this.robot = o.robot;
      this.fw = '1.0.0-sim';
      this.mode = o.mode || 'M';
      this.cap = 160;
      this.vx = 0;
      this.vy = 0;
      this.lastDrv = 0;
      this.sp = 0;                       // kecepatan motor nyata (0..255)
      this.batMv = 7900 + rnd(40);
      this.t0 = Date.now();
      this._telAcc = 0;
      this._last = Date.now();
      this._timer = setInterval(() => this._loop(), STEP_MS);
    }

    now() { return Date.now(); }
    uptime() { return Math.floor((Date.now() - this.t0) / 1000); }

    stop() { clearInterval(this._timer); this._timer = null; }

    emit(obj) { this.emitLine(JSON.stringify(obj)); }

    // ---------- perintah ----------
    handle(line) {
      const parts = String(line).trim().split(/\s+/);
      const cmd = (parts[0] || '').toUpperCase();
      const a = parts.slice(1);
      const num = (i, d) => { const v = Number(a[i]); return isFinite(v) ? v : d; };

      switch (cmd) {
        case 'PING':
          this.emit({ t: 'pong', n: num(0, 0), rssi: -52 + Math.round(rnd(4)), up: this.uptime() });
          return;
        case 'INFO':
          this.emit(this.info());
          return;
        case 'GET':
          this.emit(this.telemetry());
          return;
        case 'MODE':
          if (a[0] === 'A' || a[0] === 'M') {
            this.mode = a[0];
            this.vx = 0; this.vy = 0;
            this.onModeChange();
            this.emit(this.telemetry());
          }
          return;
        case 'DRV':
          if (this.mode === 'M') {
            this.vx = clamp(Math.round(num(0, 0)), -100, 100);
            this.vy = clamp(Math.round(num(1, 0)), -100, 100);
            this.lastDrv = this.now();
          }
          return;
        case 'SPD':
          this.cap = clamp(Math.round(num(0, this.cap)), 0, 255);
          return;
        case 'STOP':
          this.mode = 'M';
          this.vx = 0; this.vy = 0;
          this.onStop();
          this.emit(this.telemetry());
          return;
        default:
          if (this.command(cmd, a)) this.emit(this.telemetry());
      }
    }

    // ---------- hook untuk subclass ----------
    info() { return { t: 'info', robot: this.robot, fw: this.fw }; }
    telemetry() { return { t: 'tel' }; }
    command() { return false; }
    onModeChange() {}
    onStop() {}
    step() {}

    /** PWM dari vektor joystick (mirip firmware: zona minimal supaya motor tidak stall) */
    manualPwm() {
      const mag = Math.min(100, Math.hypot(this.vx, this.vy));
      return mag > 0 ? Math.round(MIN_PWM + (Math.max(MIN_PWM, this.cap) - MIN_PWM) * (mag / 100)) : 0;
    }

    commonTel() {
      return {
        t: 'tel',
        up: this.uptime(),
        m: this.mode,
        sp: Math.round(this.sp),
        cap: this.cap,
        bat: Math.round(this.batMv),
      };
    }

    _loop() {
      const now = Date.now();
      const dt = Math.min(0.25, (now - this._last) / 1000);
      this._last = now;

      if (this.mode === 'M' && (this.vx !== 0 || this.vy !== 0) && now - this.lastDrv > DEADMAN_MS) {
        this.vx = 0; this.vy = 0;           // dead-man: tidak ada perintah baru -> berhenti
      }
      this.batMv = Math.max(6200, this.batMv - dt * 0.8);

      this.step(dt, now);

      this._telAcc += dt * 1000;
      if (this._telAcc >= TEL_EVERY_MS) {
        this._telAcc = 0;
        this.emit(this.telemetry());
      }
    }
  }

  const api = { VirtualRobot, clamp, rnd, MIN_PWM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Kopak = root.Kopak || {}; root.Kopak.sim = Object.assign(root.Kopak.sim || {}, api); }
})(typeof window !== 'undefined' ? window : globalThis);
