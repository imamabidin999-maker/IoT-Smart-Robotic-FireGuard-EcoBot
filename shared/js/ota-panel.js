/*
  ota-panel.js — kartu "Update Firmware ESP" (sama untuk FireGuard dan EcoBot).

  Menampilkan versi firmware ESP bridge, status update (pesan {"t":"ota"} dari ESP), dan dua
  tombol: "Cek update" (OTA CHECK) dan "Pasang" (OTA INSTALL). Update tidak pernah dipasang
  sendiri: ESP menunggu tombol Pasang ditekan dua kali (klik kedua = konfirmasi). Pasang hanya
  bisa lewat koneksi langsung (WebSocket), tidak lewat MQTT, supaya selalu ada orang di dekat
  robot saat firmware diganti. Penjelasan alurnya ada di docs/OTA.md.
*/
(function (global) {
  'use strict';

  const K = global.Kopak;

  // status dari ESP -> [teks lencana, warna]
  const STATES = {
    idle: ['Siap', 'off'],
    off: ['Pull OTA mati', 'off'],
    checking: ['Mengecek…', 'info'],
    uptodate: ['Terbaru', 'ok'],
    available: ['Update tersedia', 'accent'],
    blocked: ['Ditahan', 'warn'],
    downloading: ['Mengunduh', 'info'],
    verifying: ['Memeriksa', 'info'],
    rebooting: ['Restart', 'info'],
    push: ['Push OTA', 'info'],
    installed: ['Terpasang', 'info'],
    trial: ['Masa percobaan', 'warn'],
    valid: ['VALID', 'ok'],
    rolling_back: ['Rollback…', 'danger'],
    rolled_back: ['Dikembalikan', 'danger'],
    error: ['Gagal', 'danger'],
  };
  const BUSY = ['checking', 'downloading', 'verifying', 'rebooting', 'push', 'trial', 'rolling_back'];

  class OtaPanel {
    /**
     * @param {HTMLElement} root  elemen <section class="card" id="cardOta">
     * @param {{send:function(string):boolean, log:function(string,string), toast:function(string,string)}} o
     */
    constructor(root, o) {
      this.root = root;
      this.o = o;
      this.st = null;              // pesan ota terakhir
      this.availVer = '';          // versi yang ditawarkan server dan masih boleh dipasang
      this.bridge = {};
      this.armed = false;          // klik pertama tombol Pasang
      this._armTimer = null;
      this._build();
      this.reset('demo');
    }

    _build() {
      const r = this.root;
      r.textContent = '';
      r.setAttribute('aria-labelledby', 'ttlOta');
      r.innerHTML = `
        <div class="card-title-row">
          <h2 class="card-title" id="ttlOta">Update Firmware ESP</h2>
          <span class="ota-badge mono" id="otaBadge" data-status="off">—</span>
        </div>
        <dl class="sys-grid">
          <dt>Versi ESP</dt><dd id="otaCur">—</dd>
          <dt>Pengaman</dt><dd id="otaGuard">—</dd>
          <dt>Terakhir</dt><dd id="otaLast">—</dd>
        </dl>
        <div class="ota-msg" id="otaMsg" role="status" aria-live="polite"></div>
        <div class="meter-track ota-bar" id="otaBar" hidden><div class="meter-fill" id="otaFill"></div></div>
        <div class="ota-actions">
          <button type="button" class="text-btn" id="otaCheck">Cek update</button>
          <button type="button" class="act-btn ota-install" id="otaInstall" disabled>Pasang</button>
        </div>
        <div class="ota-hint" id="otaHint"></div>`;
      const q = (id) => r.querySelector(`#${id}`);
      this.el = {
        badge: q('otaBadge'), cur: q('otaCur'), guard: q('otaGuard'), last: q('otaLast'), msg: q('otaMsg'),
        bar: q('otaBar'), fill: q('otaFill'), check: q('otaCheck'), install: q('otaInstall'), hint: q('otaHint'),
      };
      this.el.check.addEventListener('click', () => {
        if (this.o.send('OTA CHECK')) this.o.log('info', 'Cek update firmware ESP');
      });
      this.el.install.addEventListener('click', () => this._onInstall());
    }

    reset(mode) {
      this.mode = mode;
      this.st = null;
      this.availVer = '';
      this.bridge = {};
      this._disarm();
      this.render({ open: false, mode });
    }

    _disarm() {
      this.armed = false;
      clearTimeout(this._armTimer);
    }

    _canInstall() {
      const ctx = this._ctx || {};
      const code = this.st ? this.st.st : null;
      // "blocked" karena syarat robot (mis. masih Otomatis): boleh dicoba lagi setelah robot dihentikan
      return !!(ctx.open && ctx.mode !== 'mqtt' && this.availVer && (code === 'available' || code === 'blocked'));
    }

    _onInstall() {
      if (!this._canInstall()) return;
      if (!this.armed) {
        // klik pertama: minta konfirmasi, supaya update tidak terpasang karena salah klik
        this.armed = true;
        clearTimeout(this._armTimer);
        this._armTimer = setTimeout(() => { this.armed = false; this.render(this._ctx); }, 4000);
        this.render(this._ctx);
        return;
      }
      this._disarm();
      if (this.o.send('OTA INSTALL')) this.o.log('warn', `Memasang firmware ESP v${this.availVer} — robot akan berhenti dan ESP restart`);
      this.render(this._ctx);
    }

    onBridge(b) {
      this.bridge = b || {};
      if (!this.st && b && b.ota && b.ota.last) {
        // baru tersambung: tampilkan hasil update terakhir yang diingat ESP
        this.st = { t: 'ota', st: b.ota.st || 'idle', cur: b.fw, ver: b.ota.lastVer, msg: b.ota.lastMsg };
      }
      this.render(this._ctx);
    }

    onStatus(m) {
      const prev = this.st ? this.st.st : null;
      const next = Object.assign({}, m);
      // balasan "perintah ditolak" tidak membawa versi: pertahankan versi yang sedang diproses
      if (!next.ver && this.st && this.st.st === next.st) next.ver = this.st.ver;
      this.st = next;
      if (m.st === 'available' && m.ver) this.availVer = m.ver;
      else if (['uptodate', 'valid', 'rolled_back', 'error', 'off', 'rebooting'].includes(m.st)) this.availVer = '';
      if (m.st !== 'available' && m.st !== 'blocked') this._disarm();
      if (m.st !== prev) this._logChange(m);
      this.render(this._ctx);
    }

    _logChange(m) {
      const v = m.ver ? `v${m.ver}` : '';
      switch (m.st) {
        case 'available': this.o.log('accent', `Update firmware ESP ${v} tersedia — tekan Pasang kalau robot sudah aman`); break;
        case 'blocked': this.o.log('warn', m.msg || 'Update ditahan'); break;
        case 'downloading': this.o.log('info', `Mengunduh firmware ESP ${v}`); break;
        case 'push': this.o.log('info', 'Menerima firmware dari Arduino IDE (Push OTA) — robot dihentikan'); break;
        case 'rebooting': this.o.log('info', `Firmware ESP ${v} terpasang, ESP restart`); break;
        case 'trial': this.o.log('info', `Firmware ESP ${v} masa percobaan (health check)`); break;
        case 'valid':
          this.o.log('ok', m.msg || `Firmware ESP ${v} VALID`);
          this.o.toast(`Firmware ESP ${v} lolos pemeriksaan dan dinyatakan VALID.`);
          break;
        case 'rolled_back':
          this.o.log('danger', m.msg || `Firmware ESP ${v} dibatalkan, kembali ke versi lama`);
          this.o.toast(`Firmware ESP ${v} gagal pemeriksaan — robot kembali ke versi lama.`, 'danger');
          break;
        case 'error': this.o.log('danger', m.msg || 'Update firmware ESP gagal'); break;
        default: break;
      }
    }

    /** ctx: { open: transport ke ESP terbuka, mode: 'demo'|'ws'|'mqtt' } */
    render(ctx) {
      this._ctx = ctx || this._ctx || { open: false, mode: this.mode };
      const { open, mode } = this._ctx;
      const e = this.el;
      const set = (node, txt) => { if (node.textContent !== txt) node.textContent = txt; };
      const b = this.bridge || {};
      const ota = b.ota || {};
      const st = this.st;

      // versi & pengaman
      const cur = (st && st.cur) || b.fw;
      set(e.cur, cur ? `v${cur}` : '—');
      const guard = [];
      if (ota.pull) guard.push('MD5 + SHA-256');
      if (ota.sig) guard.push('tanda tangan');
      if (ota.rb && ota.rb !== 'none') guard.push(ota.rb === 'boot' ? 'rollback bootloader' : 'rollback otomatis');
      if (ota.push && !ota.pull) guard.push('Push OTA');
      set(e.guard, Object.keys(ota).length ? (guard.join(' · ') || 'Push OTA saja') : '—');
      const lastTxt = ota.last ? `${(STATES[ota.last] || [ota.last])[0]} v${ota.lastVer || '?'}` : (ota.good ? `VALID v${ota.good}` : '—');
      set(e.last, lastTxt);

      // lencana & pesan
      const code = st ? st.st : (open ? 'idle' : null);
      const [label, color] = code ? (STATES[code] || [code, 'off']) : ['—', 'off'];
      const pct = st && typeof st.pct === 'number' && st.pct >= 0 ? st.pct : null;
      set(e.badge, pct !== null && (code === 'downloading' || code === 'push') ? `${label} ${pct}%` : label);
      if (e.badge.dataset.status !== color) e.badge.dataset.status = color;
      let msg = st && st.msg ? st.msg : (open ? 'Tekan "Cek update" untuk melihat apakah ada firmware baru di server.' : 'Belum tersambung ke ESP.');
      if (!open && st && (code === 'rebooting' || code === 'trial')) msg = 'ESP sedang restart. Menunggu tersambung lagi…';
      if (st && st.notes && code === 'available') msg = `${msg} Catatan: ${st.notes}`;
      set(e.msg, msg);
      if (e.msg.dataset.status !== color) e.msg.dataset.status = color;

      // progres
      const showBar = pct !== null && ['downloading', 'verifying', 'push', 'rebooting'].includes(code);
      e.bar.hidden = !showBar;
      if (showBar) e.fill.style.width = `${pct}%`;

      // tombol
      const busy = code && BUSY.includes(code);
      e.check.disabled = !open || !!busy;
      const canInstall = this._canInstall();
      e.install.disabled = !canInstall;
      e.install.classList.toggle('armed', canInstall && this.armed);
      set(e.install, canInstall && this.armed ? `Yakin? Klik lagi untuk memasang v${this.availVer}` : (this.availVer ? `Pasang v${this.availVer}` : 'Pasang'));

      let hint = '';
      if (mode === 'mqtt') hint = 'Lewat MQTT hanya bisa mengecek. Pasang update dari koneksi langsung (WebSocket) di dekat robot.';
      else if (code === 'available' || (code === 'blocked' && this.availVer)) hint = 'Robot harus diam di mode Manual. Selama update, robot dihentikan dan ESP restart sekitar 20–40 detik.';
      else if (mode === 'demo' && open) hint = 'Mode demo: alur update hanya simulasi.';
      set(e.hint, hint);
      e.hint.hidden = !hint;
    }
  }

  K.OtaPanel = OtaPanel;
})(window);
