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

  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1; }
    return 0;
  }

  // Perintah yang tetap boleh lewat saat firmware ESP sedang diperbarui / diperiksa (sama dengan
  // isSafeCommand() di firmware/esp_bridge/esp_bridge.ino).
  function safeDuringOta(cmd, a) {
    if (['GET', 'INFO', 'STOP', 'SPD', 'HELP', 'PING', 'OTA'].includes(cmd)) return true;
    if (cmd === 'MODE') return a[0] === 'M';
    if (cmd === 'PUMP' || cmd === 'BRUSH') return a[0] === '0';
    if (cmd === 'DRV') return Number(a[0]) === 0 && Number(a[1]) === 0;
    return false;
  }

  /*
    ESP bridge virtual: update firmware lewat WiFi (OTA). Meniru alur firmware/esp_bridge/ota_esp32.h
    (cek manifest -> menunggu tombol Pasang -> syarat robot diam -> unduh -> periksa -> restart ->
    masa percobaan -> VALID / rollback), dengan waktu yang dipercepat. Dipakai supaya panel
    "Update Firmware ESP" bisa dicoba di mode Demo dan diuji dengan robot palsu.
  */
  class VirtualOta {
    constructor(robot, o) {
      o = o || {};
      this.r = robot;
      this.cur = o.version || '1.2.0';
      this.next = o.next || '1.3.0';
      this.speed = o.speed || 1;
      this.failNext = false;           // pengujian: versi berikutnya gagal health check -> rollback
      this.st = 'idle';
      this.ver = '';
      this.pct = -1;
      this.msg = '';
      this.good = this.cur;
      this.black = '';
      this.last = null;
      this.timers = [];
      this._lockNoteAt = 0;
    }

    get locked() { return ['downloading', 'verifying', 'rebooting', 'trial', 'rolling_back'].includes(this.st); }

    status() {
      const o = { t: 'ota', st: this.st, cur: this.cur };
      if (this.ver) o.ver = this.ver;
      if (this.pct >= 0) o.pct = this.pct;
      if (this.msg) o.msg = this.msg;
      return o;
    }

    bridgeFields() {
      const ota = { push: 1, pull: 1, sig: 1, rb: 'app', st: this.st, good: this.good, host: this.r.robot, group: 'kel00' };
      if (this.black) ota.black = this.black;
      if (this.last) Object.assign(ota, this.last);
      return { fw: this.cur, ota };
    }

    _set(st, ver, pct, msg) {
      this.st = st; this.ver = ver || ''; this.pct = pct == null ? -1 : pct; this.msg = msg || '';
      this.r.emit(this.status());
    }

    _later(ms, fn) { this.timers.push(setTimeout(fn, ms / this.speed)); }
    stop() { this.timers.forEach(clearTimeout); this.timers = []; }

    lockedNote() {
      const now = Date.now();
      if (now - this._lockNoteAt < 2000) return;
      this._lockNoteAt = now;
      this.r.emit({ t: 'ota', st: this.st, cur: this.cur,
        msg: this.st === 'trial' ? 'Perintah gerak ditolak: firmware baru sedang diperiksa (paling lama 30 detik).' : 'Perintah gerak ditolak: firmware sedang diperbarui.' });
    }

    handle(a) {
      const sub = String(a[0] || 'STATUS').toUpperCase();
      if (sub === 'CHECK') this.check();
      else if (sub === 'INSTALL') this.install();
      else this.r.emit(this.status());
    }

    _verdict() {
      if (cmpVersion(this.next, this.cur) <= 0) return ['uptodate', `Sudah versi terbaru (perangkat v${this.cur}, server v${this.next}).`];
      if (this.next === this.black) return ['blocked', `v${this.next} pernah gagal di robot ini, jadi tidak dipasang lagi. Terbitkan versi perbaikan dengan nomor lebih tinggi.`];
      return ['available', `Ada versi baru v${this.next} (sekarang v${this.cur}).`];
    }

    check() {
      if (this.locked) return;
      this._set('checking', '', null, 'Mengecek server update...');
      this._later(400, () => { const [st, msg] = this._verdict(); this._set(st, this.next, null, msg); });
    }

    install() {
      if (this.locked) return;
      const [st, msg] = this._verdict();
      if (st !== 'available') { this._set(st, this.next, null, msg); return; }
      const gate = this.r.mode !== 'M' ? 'Robot sedang mode Otomatis. Pindahkan ke Manual dulu.'
        : this.r.sp > 0 ? 'Roda masih berputar. Hentikan robot dulu.'
          : this.r.otaBusyReason();
      if (gate) { this._set('blocked', this.next, null, `Update v${this.next} belum dipasang: ${gate}`); return; }

      const ver = this.next;
      this.r.handle('STOP');                         // safe state sebelum menulis flash
      let pct = 0;
      this._set('downloading', ver, 0, 'Mengunduh firmware. Robot dihentikan selama update.');
      const tick = () => {
        pct = Math.min(100, pct + 20);
        if (pct < 100) { this._set('downloading', ver, pct, 'Mengunduh firmware. Robot dihentikan selama update.'); this._later(250, tick); return; }
        this._set('verifying', ver, 100, 'Memeriksa sidik jari, penanda versi, dan tanda tangan...');
        this._later(400, () => {
          this._set('rebooting', ver, 100, `Firmware v${ver} terpasang. Robot restart lalu memeriksa dirinya sendiri.`);
          this._later(700, trial);
        });
      };
      const trial = () => {
        const prev = this.cur;
        this.cur = ver;
        this.r.emit(Object.assign({ t: 'bridge' }, this.bridgeFields()));
        this._set('trial', ver, null, `Masa percobaan v${ver}: memeriksa WiFi, memori, Uno, dan sensor...`);
        this._later(1500, () => {
          if (this.failNext) {
            this.failNext = false;
            const why = `v${ver} dibatalkan: health check gagal (sensor api Kanan tidak tersambung (kabel AO lepas?))`;
            this.black = ver;
            this.cur = prev;
            this.last = { last: 'rolled_back', lastVer: ver, lastMsg: why };
            this._set('rolling_back', ver, null, why);
            this._later(700, () => {
              this.r.emit(Object.assign({ t: 'bridge' }, this.bridgeFields()));
              this._set('rolled_back', ver, null, why);
            });
            return;
          }
          this.good = ver;
          const ok = `v${ver} lolos health check dan dinyatakan VALID`;
          this.last = { last: 'valid', lastVer: ver, lastMsg: ok };
          this._set('valid', ver, null, ok);
          this.r.emit(Object.assign({ t: 'bridge' }, this.bridgeFields()));
        });
      };
      this._later(250, tick);
    }
  }

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
      this.ota = new VirtualOta(this, o.ota);
      this._timer = setInterval(() => this._loop(), STEP_MS);
    }

    now() { return Date.now(); }
    uptime() { return Math.floor((Date.now() - this.t0) / 1000); }

    stop() { clearInterval(this._timer); this._timer = null; this.ota.stop(); }

    emit(obj) { this.emitLine(JSON.stringify(obj)); }

    // ---------- perintah ----------
    handle(line) {
      const parts = String(line).trim().split(/\s+/);
      const cmd = (parts[0] || '').toUpperCase();
      const a = parts.slice(1);
      const num = (i, d) => { const v = Number(a[i]); return isFinite(v) ? v : d; };

      // ESP sedang memperbarui / memeriksa firmware-nya: perintah gerak ditolak di bridge
      if (this.ota.locked && !safeDuringOta(cmd, a)) { this.ota.lockedNote(); return; }

      switch (cmd) {
        case 'OTA':
          this.ota.handle(a);
          return;
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
    /** alasan robot belum boleh di-update selain mode & roda (mis. pompa menyala); null = boleh */
    otaBusyReason() { return null; }
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

  const api = { VirtualRobot, VirtualOta, clamp, rnd, cmpVersion, MIN_PWM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Kopak = root.Kopak || {}; root.Kopak.sim = Object.assign(root.Kopak.sim || {}, api); }
})(typeof window !== 'undefined' ? window : globalThis);
