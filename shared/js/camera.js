/*
  camera.js — panel live feed.

  Mode "stream": menampilkan MJPEG dari ESP32-CAM lewat <img>. Karena stream MJPEG
  bisa macet diam-diam (tanpa event error), kita juga menanyakan /status tiap 2 detik.
  Kalau jumlah frame tidak bertambah, stream dimulai ulang. Kalau /status gagal
  beberapa kali, panel menampilkan "terputus" dan mencoba lagi dengan jeda yang
  makin lama (maks 30 detik) supaya tidak membanjiri jaringan.

  Mode "demo": gambar sintetis di <canvas>, supaya tampilan hidup tanpa kamera.
  Mode "none": kamera belum diatur.
*/
(function (global) {
  'use strict';

  const K = global.Kopak;

  const STATUS_EVERY_MS = 2000;
  const STATUS_TIMEOUT_MS = 2500;
  const STALL_POLLS = 3;          // frame tidak bertambah selama 3 polling = macet
  const FAIL_POLLS = 3;           // status gagal 3x berturut-turut = putus
  const RETRY_MAX_MS = 30000;
  const FIRST_FRAME_MS = 8000;    // batas menunggu gambar pertama setelah tersambung

  class CameraPanel {
    /**
     * @param {HTMLElement} root  elemen .viewport
     * @param {{toast:function(string,string=)}} opts
     */
    constructor(root, opts) {
      this.root = root;
      this.toast = (opts && opts.toast) || (() => {});
      const q = (k) => root.querySelector(`[data-cam="${k}"]`);
      this.img = q('img');
      this.canvas = q('sim');
      this.placeholder = q('placeholder');
      this.phTitle = q('ph-title');
      this.phSub = q('ph-sub');
      this.resEl = q('res');
      this.btnSnap = q('snap');
      this.btnLamp = q('lamp');
      this.btnFull = q('full');
      this.selQuality = q('quality');

      this.mode = 'none';
      this.target = null;             // {base, stream}
      this.state = 'none';            // none | connecting | live | error
      this.fps = null;
      this.lastFrames = null;
      this.stalled = 0;
      this.failed = 0;
      this.retries = 0;
      this.lampOn = false;
      this._t = { status: null, retry: null, sim: null, first: null };
      this._gen = 0;
      this._simT0 = performance.now();
      this.simLabel = 'SIMULASI';

      this.img.addEventListener('load', () => this._onImgLoad());
      this.img.addEventListener('error', () => this._onImgError());

      if (this.btnSnap) this.btnSnap.addEventListener('click', () => this.snapshot());
      if (this.btnLamp) this.btnLamp.addEventListener('click', () => this.toggleLamp());
      if (this.btnFull) {
        const fsOk = document.fullscreenEnabled || document.webkitFullscreenEnabled;
        if (!fsOk) this.btnFull.hidden = true;
        this.btnFull.addEventListener('click', () => this.toggleFullscreen());
      }
      if (this.selQuality) this.selQuality.addEventListener('change', () => this.setQuality(this.selQuality.value));
      document.addEventListener('visibilitychange', () => this._onVisibility());

      this._setState('none');
    }

    // ---------- konfigurasi ----------

    /** @param {'none'|'demo'|'stream'} mode  @param {string=} address alamat kamera (untuk mode stream) */
    configure(mode, address) {
      const target = mode === 'stream' ? K.parseCameraAddress(address) : null;
      if (mode === 'stream' && !target) mode = 'none';
      this._stop();
      this.mode = mode;
      this.target = target;
      this.retries = 0;
      this._noCors = false;
      this.lampOn = false;
      if (this.btnLamp) this.btnLamp.setAttribute('aria-pressed', 'false');
      if (this.selQuality) this.selQuality.hidden = mode !== 'stream';

      if (mode === 'demo') this._startDemo();
      else if (mode === 'stream') this._startStream();
      else this._setState('none');
    }

    _stop() {
      this._gen++;
      clearInterval(this._t.status); clearTimeout(this._t.retry); clearInterval(this._t.sim); clearTimeout(this._t.first);
      this._t.status = this._t.retry = this._t.sim = this._t.first = null;
      if (this.img) { this.img.removeAttribute('src'); this.img.hidden = true; }
      if (this.canvas) this.canvas.hidden = true;
      this.fps = null; this.lastFrames = null; this.stalled = 0; this.failed = 0;
    }

    // ---------- tampilan ----------

    _setState(state, detail) {
      this.state = state;
      this.root.dataset.state = state;
      const live = this.root.querySelector('[data-cam="live-text"]');
      const showPh = state !== 'live';
      this.placeholder.hidden = !showPh;

      if (state === 'none') {
        this.phTitle.textContent = 'Kamera belum diatur';
        this.phSub.textContent = 'Buka Pengaturan, lalu isi alamat ESP32-CAM (mis. fireguard-cam.local) atau pakai mode Demo.';
        if (live) live.textContent = 'OFFLINE';
        this.resEl.textContent = '—';
      } else if (state === 'connecting') {
        this.phTitle.textContent = 'Menyambung ke kamera…';
        this.phSub.textContent = detail || '';
        if (live) live.textContent = 'MENYAMBUNG';
        this.resEl.textContent = '—';
      } else if (state === 'error') {
        this.phTitle.textContent = 'Kamera tidak terjangkau';
        this.phSub.textContent = detail || 'Cek power ESP32-CAM dan pastikan satu jaringan dengan laptop/HP ini.';
        if (live) live.textContent = 'TERPUTUS';
        this.resEl.textContent = '—';
      } else if (state === 'live') {
        if (live) live.textContent = this.mode === 'demo' ? 'DEMO' : 'LIVE';
      }
    }

    _updateRes() {
      if (this.state !== 'live') return;
      let w = 0, h = 0;
      if (this.mode === 'demo') { w = this.canvas.width; h = this.canvas.height; }
      else { w = this.img.naturalWidth; h = this.img.naturalHeight; }
      const dim = w && h ? `${w}×${h}` : '—';
      const fps = this.fps != null ? ` · ${this.fps} FPS` : '';
      this.resEl.textContent = dim + fps;
    }

    // ---------- stream asli ----------

    _startStream() {
      const gen = this._gen;
      this._setState('connecting', this.target.stream);
      this.img.hidden = true;
      // crossOrigin supaya snapshot lewat canvas boleh (firmware kita kirim header CORS)
      if (this._noCors) this.img.removeAttribute('crossorigin');
      else this.img.crossOrigin = 'anonymous';
      const sep = this.target.stream.includes('?') ? '&' : '?';
      this.img.src = `${this.target.stream}${sep}t=${Date.now()}`;
      clearInterval(this._t.status);
      this._t.status = setInterval(() => { if (gen === this._gen) this._pollStatus(gen); }, STATUS_EVERY_MS);
      // ESP32-CAM hanya melayani satu penonton: permintaan kedua bisa "diterima" tapi menggantung tanpa gambar
      clearTimeout(this._t.first);
      this._t.first = setTimeout(() => {
        if (gen === this._gen && this.state === 'connecting') {
          this._fail('Kamera tidak mengirim gambar (mungkin sedang dipakai penonton lain, tutup tab lain yang membuka kamera ini).');
        }
      }, FIRST_FRAME_MS);
    }

    _onImgLoad() {
      if (this.mode !== 'stream') return;
      clearTimeout(this._t.first);
      this.retries = 0;
      this.failed = 0;
      this.img.hidden = false;
      this._setState('live');
      this._updateRes();
    }

    _onImgError() {
      if (this.mode !== 'stream' || !this.img.getAttribute('src')) return;
      // kamera tanpa header CORS menolak permintaan crossOrigin: coba sekali lagi tanpa itu
      if (!this._noCors && this.state !== 'live') { this._noCors = true; this._startStream(); return; }
      this._fail('Stream berhenti atau kamera tidak merespons.');
    }

    _fail(detail) {
      const gen = this._gen;
      clearInterval(this._t.status);
      clearTimeout(this._t.first);
      this._t.status = null;
      this.img.removeAttribute('src');
      this.img.hidden = true;
      this.fps = null;
      const delay = Math.min(RETRY_MAX_MS, 2000 * Math.pow(1.7, this.retries));
      this.retries++;
      this._setState('error', `${detail} Mencoba lagi dalam ${Math.round(delay / 1000)} detik…`);
      clearTimeout(this._t.retry);
      this._t.retry = setTimeout(() => { if (gen === this._gen && this.mode === 'stream') this._startStream(); }, delay);
    }

    async _pollStatus(gen) {
      if (document.hidden || !this.target) return;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS);
      try {
        const res = await fetch(`${this.target.base}/status`, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(to);
        if (gen !== this._gen) return;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const st = await res.json();
        if (gen !== this._gen) return;
        this.failed = 0;
        if (typeof st.fps === 'number') this.fps = Math.round(st.fps);
        if (this.lastFrames !== null && typeof st.frames === 'number' && this.state === 'live') {
          this.stalled = st.frames === this.lastFrames ? this.stalled + 1 : 0;
          if (this.stalled >= STALL_POLLS) {
            this.stalled = 0;
            this.lastFrames = null;
            this._fail('Video macet.');
            return;
          }
        }
        if (typeof st.frames === 'number') this.lastFrames = st.frames;
        this._updateRes();
      } catch (e) {
        clearTimeout(to);
        if (gen !== this._gen) return;
        this.failed++;
        if (this.failed >= FAIL_POLLS) { this.failed = 0; this._fail('Kamera tidak menjawab.'); }
      }
    }

    _onVisibility() {
      // tab disembunyikan: hentikan gambar demo supaya hemat CPU; stream asli dibiarkan
      if (this.mode !== 'demo') return;
      if (document.hidden) { clearInterval(this._t.sim); this._t.sim = null; }
      else if (!this._t.sim) this._t.sim = setInterval(() => this._drawSim(), 100);
    }

    // ---------- demo ----------

    _startDemo() {
      const gen = this._gen;
      this.canvas.width = 640;
      this.canvas.height = 360;
      this.canvas.hidden = false;
      this._simT0 = performance.now();
      this._drawSim();
      this._setState('live');
      this._updateRes();
      this._t.sim = setInterval(() => { if (gen === this._gen) this._drawSim(); }, 100);
    }

    setSimLabel(text) { this.simLabel = text || 'SIMULASI'; }

    _drawSim() {
      const c = this.canvas;
      const g = c.getContext('2d');
      if (!g) return;
      const w = c.width, h = c.height;
      const t = (performance.now() - this._simT0) / 1000;

      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#20282f');
      grad.addColorStop(1, '#0d1013');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);

      // garis perspektif lantai
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.lineWidth = 1;
      const hor = h * 0.52;
      for (let i = -8; i <= 8; i++) {
        g.beginPath(); g.moveTo(w / 2 + i * 26, hor); g.lineTo(w / 2 + i * 120, h); g.stroke();
      }
      for (let i = 1; i < 7; i++) {
        const y = hor + Math.pow(i / 7, 2) * (h - hor);
        g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      }

      // "objek" bergerak pelan, sekadar penanda bahwa feed hidup
      const ox = w / 2 + Math.sin(t * 0.6) * w * 0.28;
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.beginPath(); g.ellipse(ox, hor + 60, 26, 9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(ox - 12, hor + 18, 24, 40);

      // scanline
      const sy = (t * 90) % h;
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, sy, w, 3);

      g.fillStyle = 'rgba(237,238,240,0.85)';
      g.font = '600 13px "IBM Plex Mono", monospace';
      g.fillText(`${this.simLabel} — tidak ada kamera terhubung`, 16, h - 34);
      g.fillStyle = 'rgba(166,175,184,0.9)';
      g.font = '500 12px "IBM Plex Mono", monospace';
      g.fillText(new Date().toLocaleTimeString('id-ID', { hour12: false }), 16, h - 14);

      this.fps = 10;
      this._updateRes();
    }

    // ---------- aksi ----------

    snapshot() {
      if (this.state !== 'live') { this.toast('Kamera belum aktif.', 'warn'); return; }
      try {
        let src = this.mode === 'demo' ? this.canvas : this.img;
        const w = this.mode === 'demo' ? this.canvas.width : this.img.naturalWidth;
        const h = this.mode === 'demo' ? this.canvas.height : this.img.naturalHeight;
        if (!w || !h) throw new Error('ukuran gambar belum diketahui');
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(src, 0, 0, w, h);
        c.toBlob((blob) => {
          if (!blob) { this.toast('Gagal membuat snapshot.', 'danger'); return; }
          K.downloadBlob(`snapshot-${K.stamp()}.png`, blob);
          this.toast('Snapshot tersimpan.');
        }, 'image/png');
      } catch (e) {
        // canvas "tainted" (kamera bukan firmware kita / tanpa header CORS): buka foto langsung
        if (this.mode === 'stream' && this.target) {
          global.open(`${this.target.base}/capture`, '_blank', 'noopener');
          this.toast('Snapshot dibuka di tab baru (browser menolak simpan langsung).', 'warn');
        } else {
          this.toast('Snapshot gagal.', 'danger');
        }
      }
    }

    toggleLamp() {
      if (this.mode === 'none') { this.toast('Kamera belum diatur.', 'warn'); return; }
      this.lampOn = !this.lampOn;
      this.btnLamp.setAttribute('aria-pressed', String(this.lampOn));
      if (this.mode === 'demo') { this.toast(`Lampu kamera ${this.lampOn ? 'menyala' : 'mati'} (simulasi).`); return; }
      fetch(`${this.target.base}/led?on=${this.lampOn ? 1 : 0}`, { mode: 'no-cors', cache: 'no-store' })
        .catch(() => { this.toast('Perintah lampu tidak sampai ke kamera.', 'warn'); });
    }

    setQuality(size) {
      if (this.mode !== 'stream' || !this.target) return;
      const allowed = ['qvga', 'vga', 'svga'];
      if (!allowed.includes(size)) return;
      fetch(`${this.target.base}/res?size=${size}`, { mode: 'no-cors', cache: 'no-store' })
        .then(() => { this.toast(`Resolusi kamera: ${size.toUpperCase()}`); setTimeout(() => this._startStreamIfLive(), 600); })
        .catch(() => this.toast('Gagal mengubah resolusi kamera.', 'warn'));
    }
    _startStreamIfLive() {
      if (this.mode === 'stream' && this.target) { this._stop(); this.mode = 'stream'; this._startStream(); }
    }

    toggleFullscreen() {
      const el = this.root;
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => this.toast('Layar penuh ditolak browser.', 'warn')); }
      }
    }
  }

  K.CameraPanel = CameraPanel;
})(window);
