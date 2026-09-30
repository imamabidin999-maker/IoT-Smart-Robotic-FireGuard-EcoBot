/*
  link.js — satu-satunya tempat dashboard "bicara" dengan robot.

  Tiga mode, satu antarmuka:
    demo  : robot virtual di browser (sim.js). Jalurnya sama persis dengan robot asli,
            jadi kode dashboard tidak perlu tahu sedang demo atau bukan.
    ws    : WebSocket langsung ke ESP bridge di robot (ws://alamat:81).
    mqtt  : lewat broker MQTT (WebSocket), cocok kalau robot & laptop beda jaringan.

  Arah data:
    dashboard -> robot : teks satu baris, mis. "DRV 20 80", "MODE A", "PUMP 1"
    robot -> dashboard : JSON satu baris ({"t":"tel",...}, {"t":"info",...}, {"t":"pong",...})

  Status yang dilaporkan ke UI (summary):
    demo       robot virtual jalan
    online     tersambung & telemetri masih segar
    silent     tersambung ke ESP, tapi Arduino tidak kirim telemetri (cek kabel TX/RX)
    connecting sedang mencoba / menyambung ulang
    offline    tidak tersambung (belum dikonfigurasi atau diputus manual)
*/
(function (global) {
  'use strict';

  const K = global.Kopak;

  const TEL_STALE_MS = 3000;     // lewat dari ini tanpa telemetri = "silent"
  const PING_EVERY_MS = 2000;
  const WS_OPEN_TIMEOUT_MS = 6000;
  const BACKOFF_MAX_MS = 10000;
  const FIRST_TEL_GRACE_MS = 2500; // beri waktu telemetri pertama sebelum dianggap "silent"

  class RobotLink {
    /**
     * @param {{robot:string, simFactory?:function}} opts
     *   simFactory(emitLine) -> { handle(line), stop(), ... }  (dipakai mode demo)
     */
    constructor(opts) {
      this.robot = opts.robot;
      this.simFactory = opts.simFactory || null;
      this.handlers = { state: [], msg: [], pong: [] };

      this.cfg = null;
      this.transport = 'offline';     // offline | connecting | open
      this.lastTelAt = 0;
      this.rtt = null;
      this.badLines = 0;
      this.bridgeOnline = true;       // dari topik status MQTT (LWT)
      this.sim = null;

      this._ws = null;
      this._mqtt = null;
      this._retry = 0;
      this._timers = { retry: null, open: null, ping: null, watch: null };
      this._summary = 'offline';
      this._openedAt = 0;
      this._gen = 0;                  // penanda koneksi aktif, supaya callback lama diabaikan
    }

    // ---------- event kecil-kecilan ----------
    on(evt, fn) { (this.handlers[evt] || (this.handlers[evt] = [])).push(fn); return this; }
    _emit(evt, payload) {
      (this.handlers[evt] || []).forEach((fn) => {
        try { fn(payload); } catch (e) { console.error('[link] handler error:', e); }
      });
    }

    get mode() { return this.cfg ? this.cfg.mode : null; }
    get alive() { return this.transport === 'open' && (Date.now() - this.lastTelAt) < TEL_STALE_MS; }

    get summary() {
      if (this.transport === 'offline') return 'offline';
      if (this.transport === 'connecting') return 'connecting';
      if (!this.alive && Date.now() - this._openedAt < FIRST_TEL_GRACE_MS) return 'connecting';
      if (!this.alive || !this.bridgeOnline) return 'silent';
      return this.mode === 'demo' ? 'demo' : 'online';
    }

    _refreshSummary() {
      const s = this.summary;
      if (s !== this._summary) {
        this._summary = s;
        this._emit('state', this.snapshot());
      }
    }

    snapshot() {
      return { summary: this.summary, transport: this.transport, alive: this.alive, rtt: this.rtt, mode: this.mode };
    }

    // ---------- siklus hidup ----------

    /** Sambung (atau sambung ulang) memakai konfigurasi baru. */
    connect(cfg) {
      this.disconnect(true);
      this.cfg = cfg;
      this._retry = 0;
      this.lastTelAt = 0;
      this.rtt = null;
      this.bridgeOnline = true;
      this._gen++;

      this._timers.watch = setInterval(() => this._refreshSummary(), 500);

      if (cfg.mode === 'demo') this._openDemo();
      else if (cfg.mode === 'ws') this._openWs();
      else if (cfg.mode === 'mqtt') this._openMqtt();
      else this._setTransport('offline');
    }

    /** Putus dan bersihkan semua timer. silent=true kalau cuma mau reset sebelum connect lagi. */
    disconnect(silent) {
      this._gen++;
      Object.keys(this._timers).forEach((k) => { clearTimeout(this._timers[k]); clearInterval(this._timers[k]); this._timers[k] = null; });
      if (this._ws) {
        const ws = this._ws; this._ws = null;
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        try { ws.close(); } catch (e) { /* abaikan */ }
      }
      if (this._mqtt) {
        const c = this._mqtt; this._mqtt = null;
        try { c.removeAllListeners(); c.on('error', () => {}); c.end(true); } catch (e) { /* abaikan */ }
      }
      if (this.sim) {
        try { this.sim.stop(); } catch (e) { /* abaikan */ }
        this.sim = null;
      }
      this.transport = 'offline';
      this.lastTelAt = 0;
      if (!silent) { this.cfg = null; this._refreshSummary(); }
    }

    _setTransport(t) {
      this.transport = t;
      this._refreshSummary();
    }

    // ---------- kirim perintah ----------

    /** Kirim satu baris perintah. Mengembalikan true kalau benar-benar terkirim. */
    send(line) {
      const text = String(line).trim();
      if (!text || this.transport !== 'open') return false;
      try {
        if (this.cfg.mode === 'demo') {
          if (!this.sim) return false;
          this.sim.handle(text);
          return true;
        }
        if (this.cfg.mode === 'ws') {
          if (!this._ws || this._ws.readyState !== 1) return false;
          this._ws.send(text);
          return true;
        }
        if (this.cfg.mode === 'mqtt') {
          if (!this._mqtt || !this._mqtt.connected) return false;
          this._mqtt.publish(this._topic('cmd'), text, { qos: 0 });
          return true;
        }
      } catch (e) {
        console.error('[link] gagal kirim:', e);
      }
      return false;
    }

    // ---------- demo ----------

    _openDemo() {
      if (!this.simFactory) { this._setTransport('offline'); return; }
      const gen = this._gen;
      this.sim = this.simFactory((line) => { if (gen === this._gen) this._handleText(line); });
      this.transport = 'open';
      this._openedAt = Date.now();
      // di demo tidak ada ESP sungguhan; beri data "bridge" tiruan supaya kartu Status Sistem terisi
      this._handleText(JSON.stringify({ t: 'bridge', robot: this.robot, ip: 'simulasi', rssi: -52, mode: 'demo' }));
      this.send('INFO');
      this.send('GET');
    }

    // ---------- WebSocket langsung ----------

    _openWs() {
      const url = K.parseRobotAddress(this.cfg.host);
      if (!url) { this._setTransport('offline'); return; }
      this._setTransport('connecting');
      const gen = this._gen;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this._scheduleRetry(gen, () => this._openWs());
        return;
      }
      this._ws = ws;

      this._timers.open = setTimeout(() => {
        if (gen === this._gen && ws.readyState === 0) { try { ws.close(); } catch (e) { /* abaikan */ } }
      }, WS_OPEN_TIMEOUT_MS);

      ws.onopen = () => {
        if (gen !== this._gen) return;
        clearTimeout(this._timers.open);
        this._retry = 0;
        this.lastTelAt = 0;
        this.transport = 'open';
        this._openedAt = Date.now();
        this._refreshSummary();
        this._startPing();
        this.send('INFO');
        this.send('GET');
      };
      ws.onmessage = (ev) => { if (gen === this._gen && typeof ev.data === 'string') this._handleText(ev.data); };
      ws.onerror = () => { /* onclose menyusul, di sana ditangani */ };
      ws.onclose = () => {
        if (gen !== this._gen) return;
        clearTimeout(this._timers.open);
        clearInterval(this._timers.ping);
        this._ws = null;
        this.lastTelAt = 0;
        this.rtt = null;
        this._setTransport('connecting');
        this._scheduleRetry(gen, () => this._openWs());
      };
    }

    _scheduleRetry(gen, fn) {
      clearTimeout(this._timers.retry);
      const delay = Math.min(BACKOFF_MAX_MS, Math.round(1000 * Math.pow(1.6, this._retry)));
      this._retry++;
      this._timers.retry = setTimeout(() => { if (gen === this._gen) fn(); }, delay);
    }

    _startPing() {
      clearInterval(this._timers.ping);
      this._timers.ping = setInterval(() => {
        this.send('PING ' + Math.round(performance.now()));
      }, PING_EVERY_MS);
      this.send('PING ' + Math.round(performance.now()));
    }

    // ---------- MQTT ----------

    _topic(kind) {
      const prefix = String(this.cfg.mqttPrefix || 'kopak').replace(/^\/+|\/+$/g, '');
      return `${prefix}/${this.robot}/${kind}`;
    }

    _openMqtt() {
      if (typeof global.mqtt === 'undefined' || !global.mqtt.connect) {
        console.error('[link] library MQTT (shared/vendor/mqtt.min.js) tidak termuat');
        this._setTransport('offline');
        this._emit('msg', { t: 'local', k: 'mqtt-missing' });
        return;
      }
      const url = String(this.cfg.mqttUrl || '').trim();
      if (!/^wss?:\/\//i.test(url)) { this._setTransport('offline'); return; }

      this._setTransport('connecting');
      const gen = this._gen;
      const opts = {
        clientId: `kopak-${this.robot}-${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 2000,
        connectTimeout: 8000,
      };
      if (this.cfg.mqttUser) { opts.username = this.cfg.mqttUser; opts.password = this.cfg.mqttPass || ''; }

      let client;
      try {
        client = global.mqtt.connect(url, opts);
      } catch (e) {
        console.error('[link] MQTT connect gagal:', e);
        this._setTransport('offline');
        return;
      }
      this._mqtt = client;

      client.on('connect', () => {
        if (gen !== this._gen) return;
        this.lastTelAt = 0;
        client.subscribe([this._topic('tel'), this._topic('status')], { qos: 0 }, (err) => {
          if (gen !== this._gen) return;
          if (err) { console.error('[link] subscribe gagal:', err); return; }
          this.transport = 'open';
          this._openedAt = Date.now();
          this._refreshSummary();
          this._startPing();
          this.send('INFO');
          this.send('GET');
        });
      });
      client.on('message', (topic, payload) => {
        if (gen !== this._gen) return;
        const text = payload.toString();
        if (topic === this._topic('status')) {
          this.bridgeOnline = text.trim() !== 'offline';
          this._refreshSummary();
          this._emit('msg', { t: 'bridge-status', online: this.bridgeOnline });
          return;
        }
        this._handleText(text);
      });
      const down = () => {
        if (gen !== this._gen) return;
        clearInterval(this._timers.ping);
        this.lastTelAt = 0;
        this.rtt = null;
        this._setTransport('connecting');
      };
      client.on('close', down);
      client.on('offline', down);
      client.on('error', () => { /* mqtt.js akan reconnect sendiri */ });
    }

    // ---------- pesan masuk ----------

    _handleText(text) {
      const lines = String(text).split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.charAt(0) !== '{') { this.badLines++; continue; }
        let obj;
        try { obj = JSON.parse(line); } catch (e) { this.badLines++; continue; }
        if (!obj || typeof obj !== 'object') { this.badLines++; continue; }

        if (obj.t === 'tel') {
          const wasAlive = this.alive;
          this.lastTelAt = Date.now();
          if (!wasAlive) this._refreshSummary();
        } else if (obj.t === 'pong') {
          const n = Number(obj.n);
          if (isFinite(n)) {
            this.rtt = Math.max(0, Math.round(performance.now() - n));
            this._emit('pong', obj);
          }
        }
        this._emit('msg', obj);
      }
    }
  }

  K.RobotLink = RobotLink;
  K.LINK_TEL_STALE_MS = TEL_STALE_MS;
})(window);
