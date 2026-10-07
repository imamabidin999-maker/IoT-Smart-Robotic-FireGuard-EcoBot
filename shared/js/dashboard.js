/*
  dashboard.js — kerangka dashboard yang sama untuk FireGuard dan EcoBot.

  Yang diurus di sini (sama untuk kedua robot):
    koneksi ke robot, jam, indikator koneksi & baterai, toggle Otomatis/Manual,
    joystick + WASD, slider kecepatan, tombol berhenti darurat, panel kamera,
    kartu status sistem, log aktivitas, banner peringatan, dialog pengaturan.

  Yang diurus file robot masing-masing (fireguard.js / ecobot.js):
    kartu sensor, aktuator (pompa / sapu), grafik, dan aturan alarm — lewat hook:
      onInfo(info, dash)        robot mengirim info (nama sensor, ambang batas, dst)
      onTel(tel, prev, dash)    telemetri baru masuk
      render(ctx, dash)         dipanggil tiap telemetri, perubahan koneksi, dan tiap detik
      onEstop(dash)             tombol berhenti darurat ditekan
      onConfig(cfg, dash)       konfigurasi berubah (ganti mode, alamat, dst)
    Objek dashboard (`dash`) selalu dikirim sebagai argumen terakhir, karena hook bisa
    dipanggil sebelum konstruktor selesai.
*/
(function (global) {
  'use strict';

  const K = global.Kopak;

  const MODES = ['demo', 'ws', 'mqtt'];
  const LOW_BATTERY = 20;

  class KopakDashboard {
    /**
     * @param {{
     *   robot:string, title:string, simFactory:function,
     *   defaults?:{host?:string, camera?:string},
     *   onInfo?:function, onTel?:function, render?:function, onEstop?:function, onConfig?:function
     * }} o
     */
    constructor(o) {
      this.o = o;
      this.robot = o.robot;
      this.title = o.title;
      this.cfgKey = `kopak.${o.robot}.cfg.v1`;
      this.cfg = this._loadConfig();

      this.tel = null;
      this.prevTel = null;
      this.info = null;
      this.bridge = {};
      this.pendingMode = null;
      this._pendingTimer = null;
      this._spdSynced = false;
      this._spdTimer = null;
      this._lowBatLogged = false;
      this._lastSummary = null;
      this._alerts = new Map();

      const need = (id) => {
        const el = K.$(id);
        if (!el) throw new Error(`Elemen #${id} tidak ada di halaman`);
        return el;
      };
      this.el = {
        connDot: need('connDot'), connText: need('connText'), demoChip: need('demoChip'),
        batText: need('batText'), batFill: need('batFill'), clock: need('clock'),
        btnSettings: need('btnSettings'), btnEstop: need('btnEstop'),
        btnAuto: need('btnAuto'), btnManual: need('btnManual'),
        joyBase: need('joyBase'), joyKnob: need('joyKnob'), dirLabel: need('dirLabel'), intensityLabel: need('intensityLabel'),
        speedValue: need('speedValue'), speedFill: need('speedFill'),
        speedCap: need('speedCap'), speedCapValue: need('speedCapValue'),
        alertStack: need('alertStack'),
        logList: need('logList'), btnLogExport: need('btnLogExport'), btnLogClear: need('btnLogClear'),
        sysConn: need('sysConn'), sysRtt: need('sysRtt'), sysRssi: need('sysRssi'), sysUptime: need('sysUptime'),
        sysIp: need('sysIp'), sysFw: need('sysFw'), sysBat: need('sysBat'),
        camViewport: need('camViewport'),
      };

      this._buildToastRegion();
      this.alarm = new K.Alarm(document.title);
      this.log = new K.ActivityLog({ list: this.el.logList, storageKey: `kopak.${o.robot}.log.v1` });
      this.camera = new K.CameraPanel(this.el.camViewport, { toast: (t, l) => this.toast(t, l) });

      this.link = new K.RobotLink({ robot: o.robot, simFactory: o.simFactory });
      this.link.on('state', () => this._onLinkState());
      this.link.on('msg', (m) => this._onMessage(m));
      this.link.on('pong', () => this._renderSystem());

      this.drive = new K.DriveSender((line) => this.link.send(line));
      this.joystick = new K.Joystick(this.el.joyBase, this.el.joyKnob, {
        onChange: (v) => { this.drive.set(v.x, v.y); this._renderJoy(); },
      });

      this.settings = new K.SettingsDialog({
        title: o.title,
        suggestions: o.defaults || {},
        onSave: (patch) => this._saveConfig(patch),
        onReset: () => this._resetConfig(),
      });

      this._bindUi();
      this.log.add('info', 'Dashboard dibuka');
      this.applyConfig();
      this._tick();
      setInterval(() => this._tick(), 1000);
    }

    // ================= konfigurasi =================

    _defaults() {
      // host & kamera sengaja kosong: nilai saran (mis. fireguard.local) hanya muncul di dialog pengaturan,
      // supaya dashboard tidak mencoba tersambung ke alamat yang belum pernah dikonfirmasi pengguna.
      return {
        mode: 'demo',
        host: '',
        camera: '',
        mqttUrl: 'wss://broker.hivemq.com:8884/mqtt',
        mqttPrefix: 'kopak',
        mqttUser: '',
        mqttPass: '',
        cells: 2,
        sound: true,
        notify: false,
        speedCap: 160,
      };
    }

    _loadConfig() {
      const def = this._defaults();
      const saved = K.store.get(this.cfgKey, null);
      if (!saved || typeof saved !== 'object') return def;
      const cfg = Object.assign({}, def, saved);
      if (!MODES.includes(cfg.mode)) cfg.mode = 'demo';
      cfg.cells = K.clamp(parseInt(cfg.cells, 10) || 2, 1, 4);
      cfg.speedCap = K.clamp(parseInt(cfg.speedCap, 10) || 160, 40, 255);
      ['host', 'camera', 'mqttUrl', 'mqttPrefix', 'mqttUser', 'mqttPass'].forEach((k) => { if (typeof cfg[k] !== 'string') cfg[k] = def[k]; });
      cfg.sound = cfg.sound !== false;
      cfg.notify = !!cfg.notify;
      return cfg;
    }

    _saveConfig(patch) {
      this.cfg = Object.assign({}, this.cfg, patch);
      K.store.set(this.cfgKey, this.cfg);
      const label = { demo: 'Demo', ws: 'Langsung (WebSocket)', mqtt: 'MQTT' }[this.cfg.mode];
      this.log.add('info', `Pengaturan disimpan — mode ${label}`);
      this.applyConfig();
    }

    _resetConfig() {
      this.cfg = this._defaults();
      K.store.remove(this.cfgKey);
      this.log.add('info', 'Pengaturan dikembalikan ke Demo');
      this.applyConfig();
    }

    /** Terapkan this.cfg ke koneksi, kamera, alarm, dan tampilan. */
    applyConfig() {
      const cfg = this.cfg;
      document.body.dataset.linkMode = cfg.mode;
      this.el.demoChip.hidden = cfg.mode !== 'demo';

      this.alarm.configure({ sound: cfg.sound, notify: cfg.notify });

      this.el.speedCap.value = String(cfg.speedCap);
      this.el.speedCapValue.textContent = String(cfg.speedCap);

      if (cfg.mode === 'demo') this.camera.configure('demo');
      else this.camera.configure(cfg.camera ? 'stream' : 'none', cfg.camera);

      // koneksi baru = telemetri lama tidak berlaku lagi
      this.joystick.release();
      this.tel = null;
      this.prevTel = null;
      this.info = null;
      this.bridge = {};
      this.pendingMode = null;
      this._spdSynced = false;
      this._lowBatLogged = false;
      this._lastSummary = null;

      this.link.connect(cfg);
      if (this.o.onConfig) this.o.onConfig(cfg, this);
      this.renderAll();
    }

    get isDemo() { return this.cfg.mode === 'demo'; }
    get alive() { return this.link.alive; }

    // ================= UI umum =================

    _buildToastRegion() {
      const r = document.createElement('div');
      r.className = 'toast-region';
      r.setAttribute('role', 'status');
      r.setAttribute('aria-live', 'polite');
      document.body.appendChild(r);
      this._toastRegion = r;
    }

    toast(text, level) {
      const t = document.createElement('div');
      t.className = 'toast';
      if (level) t.dataset.level = level;
      t.textContent = text;
      this._toastRegion.appendChild(t);
      while (this._toastRegion.children.length > 3) this._toastRegion.firstChild.remove();
      setTimeout(() => t.remove(), level === 'danger' ? 6000 : 3500);
    }

    /** Kirim perintah; kalau gagal dan notify=true, beri tahu pengguna. */
    send(cmd, notify) {
      const ok = this.link.send(cmd);
      if (!ok && notify) this.toast('Belum tersambung ke robot. Cek pengaturan koneksi.', 'warn');
      return ok;
    }

    _bindUi() {
      const e = this.el;
      e.btnSettings.addEventListener('click', () => this.settings.open(this.cfg));
      e.btnAuto.addEventListener('click', () => this.setMode('A'));
      e.btnManual.addEventListener('click', () => this.setMode('M'));
      e.btnEstop.addEventListener('click', () => this.estop());
      e.btnLogExport.addEventListener('click', () => {
        K.downloadText(`${this.robot}-log-${K.stamp()}.csv`, this.log.exportCsv(), 'text/csv;charset=utf-8');
      });
      e.btnLogClear.addEventListener('click', () => { this.log.clear(); this.toast('Log dibersihkan.'); });

      e.speedCap.addEventListener('input', () => {
        const v = parseInt(e.speedCap.value, 10);
        e.speedCapValue.textContent = String(v);
        clearTimeout(this._spdTimer);
        this._spdTimer = setTimeout(() => this.send(`SPD ${v}`), 150);
      });
      e.speedCap.addEventListener('change', () => {
        this.cfg.speedCap = parseInt(e.speedCap.value, 10);
        K.store.set(this.cfgKey, this.cfg);
      });

      // Spasi = berhenti darurat (kecuali sedang mengetik / dialog terbuka)
      document.addEventListener('keydown', (ev) => {
        if (ev.key !== ' ' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        const t = ev.target;
        if (t && t.tagName && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
        if (this.settings.isOpen) return;
        ev.preventDefault();
        if (!ev.repeat) this.estop();
      });
      document.addEventListener('keyup', (ev) => {
        if (ev.key === ' ' && !this.settings.isOpen && !/^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '')) ev.preventDefault();
      });

      // tab ditutup / pindah halaman: minta robot berhenti (jaga-jaga, dead-man timer juga jalan)
      global.addEventListener('pagehide', () => { this.drive.stop(); });
    }

    setMode(m) {
      if (this.tel && this.tel.m === m && this.alive) return;
      if (!this.send(`MODE ${m}`, true)) return;
      this.pendingMode = m;
      this._renderCommon();
      clearTimeout(this._pendingTimer);
      this._pendingTimer = setTimeout(() => {
        if (this.pendingMode === m) {
          this.pendingMode = null;
          this.toast('Robot tidak mengonfirmasi perubahan mode. Cek koneksi Arduino ↔ ESP.', 'warn');
          this.renderAll();
        }
      }, 2000);
    }

    estop() {
      this.joystick.release();
      this.drive.stop();
      if (this.o.onEstop) this.o.onEstop(this);
      const ok = this.link.send('STOP');
      if (ok) { setTimeout(() => this.link.send('STOP'), 120); setTimeout(() => this.link.send('STOP'), 260); }
      this.log.add('danger', 'Berhenti darurat ditekan — robot dihentikan, masuk mode manual');
      if (ok) this.toast('BERHENTI DARURAT — robot dihentikan.', 'danger');
      else this.toast('Tidak tersambung! Perintah berhenti TIDAK terkirim ke robot.', 'danger');
    }

    // ---------- banner peringatan ----------
    /** level: 'danger' | 'warn'; text=null untuk menghapus banner */
    setAlert(id, level, text) {
      let node = this._alerts.get(id);
      if (text == null) {
        if (node) { node.remove(); this._alerts.delete(id); }
        return;
      }
      if (!node) {
        node = document.createElement('div');
        node.className = 'alert-banner';
        node.setAttribute('role', 'alert');
        const inner = document.createElement('div');
        inner.className = 'alert-inner';
        inner.innerHTML = K.icons.warn(17);
        const span = document.createElement('span');
        inner.appendChild(span);
        node.appendChild(inner);
        this.el.alertStack.appendChild(node);
        this._alerts.set(id, node);
      }
      node.dataset.level = level;
      const span = node.querySelector('span');
      if (span.textContent !== text) span.textContent = text;
    }

    // ================= pesan dari robot =================

    _onLinkState() {
      const s = this.link.summary;
      if (s !== this._lastSummary) {
        const prev = this._lastSummary;
        this._lastSummary = s;
        if (s === 'online') this.log.add('ok', `Tersambung ke robot (${this.cfg.mode === 'mqtt' ? 'MQTT' : 'WebSocket'})`);
        else if (s === 'demo') this.log.add('info', 'Mode demo aktif — semua data adalah simulasi');
        else if (s === 'silent') this.log.add('warn', 'ESP tersambung, tetapi Arduino belum mengirim data. Cek kabel TX/RX dan baud rate.');
        else if (s === 'connecting' && (prev === 'online' || prev === 'silent' || prev === 'demo')) this.log.add('warn', 'Koneksi terputus, mencoba menyambung ulang…');
        if (s !== 'online' && s !== 'demo') { this._spdSynced = false; this.drive.stop(); }
      }
      this.renderAll();
    }

    _onMessage(m) {
      if (!m || typeof m !== 'object') return;
      switch (m.t) {
        case 'tel': this._onTel(m); break;
        case 'info':
          this.info = m;
          this._spdSynced = false;
          this.send(`SPD ${this.cfg.speedCap}`);
          if (this.o.onInfo) this.o.onInfo(m, this);
          this.renderAll();
          break;
        case 'bridge':
          this.bridge = Object.assign({}, this.bridge, m);
          this._renderSystem();
          break;
        case 'pong':
          if (typeof m.rssi === 'number') this.bridge = Object.assign({}, this.bridge, { rssi: m.rssi });
          break;
        case 'local':
          if (m.k === 'mqtt-missing') this.toast('Library MQTT tidak termuat (shared/vendor/mqtt.min.js).', 'danger');
          break;
        default: break;
      }
    }

    _onTel(m) {
      this.prevTel = this.tel;
      this.tel = m;
      const prev = this.prevTel;

      if (prev && typeof m.up === 'number' && typeof prev.up === 'number' && m.up + 2 < prev.up) {
        this.log.add('warn', 'Robot restart (uptime kembali ke awal)');
        this._spdSynced = false;
      }
      if (!this._spdSynced) {
        this._spdSynced = true;
        if (typeof m.cap === 'number' && m.cap !== this.cfg.speedCap) this.send(`SPD ${this.cfg.speedCap}`);
      }
      if (this.pendingMode && m.m === this.pendingMode) { this.pendingMode = null; clearTimeout(this._pendingTimer); }
      if (prev && prev.m && m.m && prev.m !== m.m) {
        this.log.add('info', m.m === 'A' ? 'Mode diubah ke Otomatis' : 'Mode diubah ke Manual');
      }

      const pct = K.batteryPercent(m.bat, this.cfg.cells);
      if (pct !== null && pct < LOW_BATTERY && !this._lowBatLogged) {
        this._lowBatLogged = true;
        this.log.add('warn', `Baterai rendah (${pct}%) — segera isi daya`);
      } else if (pct !== null && pct >= LOW_BATTERY + 5) {
        this._lowBatLogged = false;
      }

      if (this.o.onTel) this.o.onTel(m, prev, this);
      this.renderAll();
    }

    // ================= render =================

    _tick() {
      this.el.clock.textContent = K.fmtClock(new Date());
      this.renderAll();
    }

    renderAll() {
      this._renderConn();
      this._renderCommon();
      this._renderSystem();
      if (this.o.render) this.o.render({ alive: this.alive, tel: this.tel, info: this.info, isDemo: this.isDemo }, this);
    }

    _renderConn() {
      const s = this.link.summary;
      const text = {
        demo: 'Demo',
        online: 'Terhubung',
        silent: this.link.bridgeOnline ? 'Robot belum merespons' : 'Robot offline',
        connecting: 'Menyambung…',
        offline: this.cfg.mode === 'ws' && !K.parseRobotAddress(this.cfg.host) ? 'Belum dikonfigurasi' : 'Terputus',
      }[s];
      this.el.connDot.dataset.state = s;
      if (this.el.connText.textContent !== text) this.el.connText.textContent = text;
    }

    _renderJoy() {
      const { dirLabel, intensityLabel } = this.el;
      const auto = this.tel && this.tel.m === 'A';
      let dir;
      if (!this.alive) dir = 'Tidak terhubung';
      else if (auto) dir = 'Mode Otomatis Aktif';
      else if (!this.joystick.enabled) dir = 'Berhenti';
      else dir = K.directionLabel(this.joystick.x, this.joystick.y, 0.08 * 100);
      if (dirLabel.textContent !== dir) dirLabel.textContent = dir;
      const inten = this.joystick.enabled ? Math.round(Math.min(100, Math.hypot(this.joystick.x, this.joystick.y))) : 0;
      const itxt = `Intensitas ${inten}%`;
      if (intensityLabel.textContent !== itxt) intensityLabel.textContent = itxt;
    }

    _renderCommon() {
      const e = this.el;
      const alive = this.alive;
      const robotMode = alive && this.tel ? this.tel.m : null;
      const shown = this.pendingMode || robotMode;

      e.btnAuto.classList.toggle('active', shown === 'A');
      e.btnManual.classList.toggle('active', shown === 'M');
      e.btnAuto.classList.toggle('pending', this.pendingMode === 'A');
      e.btnManual.classList.toggle('pending', this.pendingMode === 'M');
      e.btnAuto.setAttribute('aria-pressed', String(shown === 'A'));
      e.btnManual.setAttribute('aria-pressed', String(shown === 'M'));

      this.joystick.setEnabled(alive && robotMode === 'M');
      this._renderJoy();

      // meter kecepatan: pakai angka nyata dari robot
      const sp = alive && this.tel && typeof this.tel.sp === 'number' ? K.clamp(this.tel.sp, 0, 255) : 0;
      const vtxt = `${sp}/255`;
      if (e.speedValue.textContent !== vtxt) e.speedValue.textContent = vtxt;
      e.speedFill.style.width = `${(sp / 255) * 100}%`;

      // baterai
      const pct = alive && this.tel ? K.batteryPercent(this.tel.bat, this.cfg.cells) : null;
      if (pct === null) {
        e.batText.textContent = '—';
        e.batFill.setAttribute('width', '0');
      } else {
        e.batText.textContent = `${pct}%`;
        e.batFill.setAttribute('width', String(Math.max(0.5, (pct / 100) * 11.5)));
        e.batFill.setAttribute('fill', pct < LOW_BATTERY ? '#FF5D3A' : (pct < 40 ? '#F2A93B' : '#2FD9A8'));
      }
    }

    _renderSystem() {
      const e = this.el;
      const set = (el, txt) => { if (el.textContent !== txt) el.textContent = txt; };
      const mode = { demo: 'Demo (simulasi)', ws: 'WebSocket', mqtt: 'MQTT' }[this.cfg.mode];
      set(e.sysConn, `${mode} · ${{ demo: 'aktif', online: 'tersambung', silent: 'tanpa data', connecting: 'menyambung', offline: 'putus' }[this.link.summary]}`);
      set(e.sysRtt, this.cfg.mode !== 'demo' && this.link.rtt != null && this.link.transport === 'open' ? `${this.link.rtt} ms` : '—');
      set(e.sysRssi, typeof this.bridge.rssi === 'number' ? `${this.bridge.rssi} dBm` : '—');
      set(e.sysUptime, this.alive && this.tel && typeof this.tel.up === 'number' ? K.fmtDuration(this.tel.up) : '—');
      set(e.sysIp, this.bridge.ip ? String(this.bridge.ip) : (this.cfg.mode === 'ws' ? (K.parseRobotAddress(this.cfg.host) || '—').replace(/^wss?:\/\//, '') : '—'));
      set(e.sysFw, this.info && this.info.fw ? `v${this.info.fw}` : '—');
      const bat = this.alive && this.tel && typeof this.tel.bat === 'number' && this.tel.bat > 0 ? `${(this.tel.bat / 1000).toFixed(2)} V` : '—';
      set(e.sysBat, bat);
    }
  }

  K.KopakDashboard = KopakDashboard;
})(window);
