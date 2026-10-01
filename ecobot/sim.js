/*
  ecobot/sim.js — robot EcoBot virtual untuk mode Demo dan pengujian.
  Urutan sensor dan ambang batas sama dengan firmware (firmware/ecobot_uno):
    0 Depan, 1 Belakang, 2 Kiri, 3 Kanan, 4 Capit, 5 Bin (jarak ke permukaan sampah)
*/
(function (root) {
  'use strict';

  const core = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('../shared/js/sim-core.js')
    : root.Kopak.sim;
  const { VirtualRobot, clamp, rnd } = core;

  const TH = { det: 60, reach: 15, binE: 20, binF: 4, binFull: 95 };
  const FAR = [142, 180, 156, 138, 150];         // jarak "kosong" tiap sensor (cm)
  const NEAR_BY_LEVEL = [null, 55, 11];          // jarak saat level 1 dan 2
  const ANG = { clawOpen: 90, clawClosed: 25, armDown: 10, armUp: 150 };

  // urutan pengambilan: [waktu (detik), aksi]
  const PICK_STEPS = [
    [0.0, 'armDown'], [0.0, 'clawOpen'],
    [0.9, 'clawClose'],
    [1.6, 'armUp'],
    [2.9, 'clawOpen'],
    [3.6, 'armDown'], [3.6, 'clawClose'],
    [4.4, 'done'],
  ];

  function level(d, reach) {
    if (d <= 0) return 0;
    if (d <= reach) return 2;
    if (d <= TH.det) return 1;
    return 0;
  }

  class EcoBotSim extends VirtualRobot {
    constructor(emit) {
      super(emit, { robot: 'ecobot', mode: 'M' });
      this.forced = [0, 0, 0, 0, 0];            // paksa level sensor 0..4 (demo)
      this.d = FAR.slice();                      // jarak terukur 0..4
      this.binPct = 38;
      this.count = 0;
      this.state = 'manual';
      this.stT = 0;
      this.claw = ANG.clawClosed;               // posisi istirahat: capit tertutup, lengan turun
      this.arm = ANG.armDown;
      this.clawTarget = ANG.clawClosed;
      this.armTarget = ANG.armDown;
      this.clawClosedCmd = true;
      this.armUpCmd = false;
      this.picking = false;
      this.pickT = 0;
      this.pickIdx = 0;
    }

    info() {
      return {
        t: 'info', robot: 'ecobot', fw: this.fw,
        us: ['Depan', 'Belakang', 'Kiri', 'Kanan', 'Capit', 'Bin'],
        pins: ['A0', 'A1', 'A2', 'A3', 'A4', 'D13'],
        th: { det: TH.det, reach: TH.reach, grab: 12, binE: TH.binE, binF: TH.binF },
        ang: ANG,
      };
    }

    get binDist() { return TH.binE - (this.binPct / 100) * (TH.binE - TH.binF); }

    telemetry() {
      const t = this.commonTel();
      t.st = this.mode === 'M' ? (this.picking ? 'pick' : 'manual') : this.state;
      t.d = this.d.map((v) => (v > 0 ? Math.round(v) : -1)).concat([Math.round(this.binDist)]);
      t.l = this.d.map((v, i) => level(v, i === 4 ? 12 : TH.reach)).concat([0]);
      t.bin = Math.round(this.binPct);
      t.cl = this.clawTarget === ANG.clawClosed ? 1 : 0;
      t.ar = this.armTarget === ANG.armUp ? 1 : 0;
      t.ca = Math.round(this.claw);
      t.aa = Math.round(this.arm);
      t.n = this.count;
      return t;
    }

    /** dipakai demo: klik kartu sensor -> paksa level 0/1/2 */
    force(idx, lvl) { if (idx >= 0 && idx < this.forced.length) this.forced[idx] = lvl; }
    /** dipakai demo: kosongkan bin */
    resetBin() { this.binPct = 4; }

    command(cmd, a) {
      if (cmd === 'CLAW') {
        if (this.mode !== 'M' || this.picking) return true;
        this.clawClosedCmd = a[0] === '1';
        this.clawTarget = this.clawClosedCmd ? ANG.clawClosed : ANG.clawOpen;
        return true;
      }
      if (cmd === 'ARM') {
        if (this.mode !== 'M' || this.picking) return true;
        this.armUpCmd = a[0] === '1';
        this.armTarget = this.armUpCmd ? ANG.armUp : ANG.armDown;
        return true;
      }
      if (cmd === 'PICK') {
        if (!this.picking && this.binPct < TH.binFull) this._startPick();
        return true;
      }
      return false;
    }

    onModeChange() {
      if (this.picking) { this.armTarget = ANG.armDown; this.clawTarget = ANG.clawClosed; }
      this.picking = false;
      this.state = this.mode === 'M' ? 'manual' : 'roam';
      this.stT = 0;
      this.sp = 0;
    }
    onStop() {
      this.onModeChange();
      this.clawTarget = this.claw; this.armTarget = this.arm;   // berhenti di posisi sekarang
    }

    _startPick() {
      this.picking = true;
      this.pickT = 0;
      this.pickIdx = 0;
      this.sp = 0;
    }

    _pickStep(dt) {
      this.pickT += dt;
      while (this.pickIdx < PICK_STEPS.length && this.pickT >= PICK_STEPS[this.pickIdx][0]) {
        const act = PICK_STEPS[this.pickIdx][1];
        if (act === 'armDown') this.armTarget = ANG.armDown;
        else if (act === 'armUp') this.armTarget = ANG.armUp;
        else if (act === 'clawOpen') this.clawTarget = ANG.clawOpen;
        else if (act === 'clawClose') this.clawTarget = ANG.clawClosed;
        else if (act === 'done') {
          this.picking = false;
          this.count++;
          this.binPct = Math.min(100, this.binPct + 6 + Math.floor(Math.random() * 4));
          this.forced = this.forced.map(() => 0);        // objeknya sudah diambil
          this.clawTarget = ANG.clawClosed;
          this.state = 'roam';
        }
        this.pickIdx++;
      }
    }

    step(dt) {
      // sensor: nilai target tergantung level paksa
      for (let i = 0; i < 5; i++) {
        const lv = this.forced[i];
        const target = lv === 0 ? FAR[i] : (i === 4 && lv === 2 ? 10 : NEAR_BY_LEVEL[lv]);
        this.d[i] += (target + rnd(1.5) - this.d[i]) * Math.min(1, dt * 6);
      }

      // servo bergerak halus (tidak lompat, meniru firmware)
      const sMove = 240 * dt;
      this.claw += clamp(this.clawTarget - this.claw, -sMove, sMove);
      this.arm += clamp(this.armTarget - this.arm, -sMove, sMove);

      this.stT += dt;
      if (this.picking) { this.sp = 0; this._pickStep(dt); return; }

      if (this.mode === 'M') { this.sp = this.manualPwm(); return; }

      // ---------- otomatis ----------
      const lv = this.d.map((v, i) => level(v, i === 4 ? 12 : TH.reach));
      if (this.binPct >= TH.binFull) { this.state = 'full'; this.sp = 0; return; }
      if (this.state === 'full') this.state = 'roam';

      if (lv[0] === 2 || lv[4] === 2) { this.state = 'pick'; this._startPick(); return; }
      if (lv[0] === 1 || lv[4] === 1) { this.state = 'approach'; this.sp = 120; return; }
      if (lv[2] >= 1 || lv[3] >= 1) { this.state = 'align'; this.sp = 130; return; }
      this.state = 'roam';
      this.sp = 110;
    }
  }

  const api = { EcoBotSim, factory: (emit) => new EcoBotSim(emit) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Kopak = root.Kopak || {}; root.Kopak.sim = Object.assign(root.Kopak.sim || {}, { EcoBotSim, ecobotFactory: api.factory }); }
})(typeof window !== 'undefined' ? window : globalThis);
