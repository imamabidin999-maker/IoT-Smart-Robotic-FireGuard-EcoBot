/*
  chart.js — grafik garis waktu-nyata tanpa library.

  Mengikuti pedoman grafik yang dipakai di proyek ini:
    - garis 2px, grid tipis & redup, satu sumbu Y
    - satu sensor = satu warna (urutan tetap), nama sensor selalu ada di legenda
    - crosshair + tooltip mengikuti pointer; bisa juga lewat keyboard (panah kiri/kanan)
    - ada tampilan tabel sebagai alternatif (aksesibilitas) dan ekspor CSV
    - teks memakai warna teks biasa, bukan warna seri
*/
(function (global) {
  'use strict';

  const K = global.Kopak;

  const GRID = '#23282D';
  const AXIS = '#2B3137';
  const MUTED = '#838C96';
  const SURFACE = '#1B1F23';
  const MAX_SAMPLES = 1200;       // ~10 menit pada 2 sampel/detik
  const MIN_INTERVAL_MS = 500;
  const PAD = { l: 38, r: 12, t: 10, b: 22 };

  class LineChart {
    /**
     * @param {{
     *   canvas:HTMLCanvasElement, legend:HTMLElement, tip:HTMLElement,
     *   tableWrap:HTMLElement, table:HTMLTableElement,
     *   series:Array<{label:string,color:string,decimals?:number}>,
     *   yMin:number, yMax:number, yTicks:number[], unit?:string,
     *   thresholds?:Array<{y:number,label:string}>, windowSec?:number
     * }} o
     */
    constructor(o) {
      this.o = o;
      this.canvas = o.canvas;
      this.ctx = o.canvas.getContext('2d');
      this.series = o.series.slice();
      this.samples = [];
      this.windowMs = (o.windowSec || 60) * 1000;
      this.hover = null;          // indeks sampel yang sedang disorot
      this.tableMode = false;
      this._raf = 0;
      this._lastPush = 0;

      this._buildLegend();

      o.canvas.addEventListener('pointermove', (e) => this._pointer(e));
      o.canvas.addEventListener('pointerdown', (e) => this._pointer(e));
      o.canvas.addEventListener('pointerleave', () => this._setHover(null));
      o.canvas.addEventListener('blur', () => this._setHover(null));
      o.canvas.addEventListener('keydown', (e) => this._key(e));

      if (global.ResizeObserver) new ResizeObserver(() => this.render()).observe(o.canvas.parentElement);
      else global.addEventListener('resize', () => this.render());
    }

    // ---------- data ----------

    /** values: array sejajar dengan series (angka atau null) */
    push(values, now) {
      now = now || Date.now();
      if (now - this._lastPush < MIN_INTERVAL_MS) return;
      this._lastPush = now;
      this.samples.push({ t: now, v: this.series.map((_, i) => (typeof values[i] === 'number' && isFinite(values[i]) ? values[i] : null)) });
      if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
      this.render();
    }

    clear() { this.samples = []; this.hover = null; this.render(); }

    /** Ganti daftar seri (mis. jumlah sensor berubah). Riwayat lama dibuang karena kolomnya tidak cocok lagi. */
    setSeries(series) {
      this.series = series.slice();
      this.samples = [];
      this.hover = null;
      this._buildLegend();
      this.render();
    }

    setWindow(sec) { this.windowMs = sec * 1000; this.render(); }

    setTableMode(on) {
      this.tableMode = !!on;
      this.canvas.parentElement.hidden = this.tableMode;
      this.o.tableWrap.hidden = !this.tableMode;
      this.o.tip.hidden = true;
      this.render();
    }

    exportCsv() {
      const head = ['waktu'].concat(this.series.map((s) => s.label)).map(K.csvCell).join(',');
      const rows = this.samples.map((s) => [new Date(s.t).toISOString()].concat(s.v.map((v) => (v == null ? '' : v))).map(K.csvCell).join(','));
      return [head].concat(rows).join('\n');
    }

    // ---------- legenda ----------

    _buildLegend() {
      const lg = this.o.legend;
      lg.textContent = '';
      this._legendVals = this.series.map((s) => {
        const key = document.createElement('span');
        key.className = 'key';
        key.style.color = s.color;
        const line = document.createElement('i');
        const name = document.createElement('b');
        name.textContent = s.label;
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = '—';
        key.append(line, name, val);
        lg.appendChild(key);
        return val;
      });
    }

    _fmt(i, v) {
      if (v == null) return '—';
      const d = this.series[i].decimals || 0;
      return v.toFixed(d) + (this.o.unit ? ' ' + this.o.unit : '');
    }

    _updateLegend() {
      const s = this.hover != null ? this.samples[this.hover] : this.samples[this.samples.length - 1];
      this._legendVals.forEach((el, i) => { el.textContent = s ? this._fmt(i, s.v[i]) : '—'; });
    }

    // ---------- interaksi ----------

    _geom() {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      return { w, h, pw: Math.max(1, w - PAD.l - PAD.r), ph: Math.max(1, h - PAD.t - PAD.b) };
    }

    _visibleRange() {
      const now = Date.now();
      return { now, from: now - this.windowMs };
    }

    _pointer(e) {
      if (!this.samples.length) return;
      const rect = this.canvas.getBoundingClientRect();
      const { pw } = this._geom();
      const { now, from } = this._visibleRange();
      const t = from + ((e.clientX - rect.left - PAD.l) / pw) * this.windowMs;
      let best = null, bestD = Infinity;
      for (let i = 0; i < this.samples.length; i++) {
        const s = this.samples[i];
        if (s.t < from - 1000 || s.t > now + 1000) continue;
        const d = Math.abs(s.t - t);
        if (d < bestD) { bestD = d; best = i; }
      }
      this._setHover(best, e.clientX - rect.left, e.clientY - rect.top);
    }

    _key(e) {
      if (!this.samples.length) return;
      const { from } = this._visibleRange();
      const first = this.samples.findIndex((s) => s.t >= from);
      if (first < 0) return;
      const last = this.samples.length - 1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        let i = this.hover == null ? last : this.hover + (e.key === 'ArrowLeft' ? -1 : 1);
        i = K.clamp(i, first, last);
        this._setHover(i);
      } else if (e.key === 'Escape') {
        this._setHover(null);
      }
    }

    _setHover(idx, px, py) {
      this.hover = idx;
      this._px = px; this._py = py;
      this.render();
    }

    _drawTip() {
      const tip = this.o.tip;
      if (this.hover == null || this.tableMode) { tip.hidden = true; return; }
      const s = this.samples[this.hover];
      if (!s) { tip.hidden = true; return; }

      tip.textContent = '';
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = K.fmtClock(new Date(s.t));
      tip.appendChild(t);
      this.series.forEach((ser, i) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.style.color = ser.color;
        const line = document.createElement('i');
        const name = document.createElement('span');
        name.textContent = ser.label;
        name.style.color = 'var(--text-2)';
        const val = document.createElement('strong');
        val.textContent = this._fmt(i, s.v[i]);
        row.append(line, name, val);
        tip.appendChild(row);
      });
      tip.hidden = false;

      const { w, h, pw } = this._geom();
      const { from } = this._visibleRange();
      const x = PAD.l + ((s.t - from) / this.windowMs) * pw;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = x + 14;
      if (left + tw > w - 4) left = x - tw - 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.max(4, Math.min(h - th - 4, (this._py != null ? this._py : h / 3) - th / 2)) + 'px';
    }

    // ---------- gambar ----------

    render() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
    }

    _draw() {
      this._updateLegend();
      if (this.tableMode) { this._drawTable(); return; }

      const cvs = this.canvas;
      const dpr = Math.min(3, global.devicePixelRatio || 1);
      const { w, h, pw, ph } = this._geom();
      if (w < 10 || h < 10) return;                // belum terlihat (mis. tab tersembunyi)
      if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
        cvs.width = Math.round(w * dpr);
        cvs.height = Math.round(h * dpr);
      }
      const g = this.ctx;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const { yMin, yMax } = this.o;
      const yOf = (v) => PAD.t + ph * (1 - (v - yMin) / (yMax - yMin));
      const { now, from } = this._visibleRange();
      const xOf = (t) => PAD.l + ((t - from) / this.windowMs) * pw;

      // grid + label sumbu Y
      g.font = '10px "IBM Plex Mono", monospace';
      g.textBaseline = 'middle';
      g.textAlign = 'right';
      g.lineWidth = 1;
      this.o.yTicks.forEach((v) => {
        const y = Math.round(yOf(v)) + 0.5;
        g.strokeStyle = v === yMin ? AXIS : GRID;
        g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(w - PAD.r, y); g.stroke();
        g.fillStyle = MUTED;
        g.fillText(String(v), PAD.l - 6, y);
      });

      // label sumbu X (detik lalu)
      g.textBaseline = 'alphabetic';
      const span = this.windowMs / 1000;
      const marks = [[0, 'sekarang'], [0.5, `-${Math.round(span / 2)}d`], [1, `-${Math.round(span)}d`]];
      marks.forEach(([f, label]) => {
        const x = PAD.l + pw * (1 - f);
        g.textAlign = f === 0 ? 'right' : (f === 1 ? 'left' : 'center');
        g.fillStyle = MUTED;
        g.fillText(label, x, h - 6);
      });

      // garis ambang (putus-putus, label redup di kiri dalam plot)
      (this.o.thresholds || []).forEach((th) => {
        if (th.y < yMin || th.y > yMax) return;
        const y = Math.round(yOf(th.y)) + 0.5;
        g.save();
        g.setLineDash([4, 4]);
        g.strokeStyle = '#3A4048';
        g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(w - PAD.r, y); g.stroke();
        g.restore();
        g.textAlign = 'left';
        g.textBaseline = 'bottom';
        g.fillStyle = MUTED;
        g.fillText(th.label, PAD.l + 4, y - 2);
      });

      // data
      const visible = this.samples.filter((s) => s.t >= from - 2000);
      if (visible.length === 0) {
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = MUTED;
        g.font = '12px "IBM Plex Sans", sans-serif';
        g.fillText('Menunggu data sensor…', PAD.l + pw / 2, PAD.t + ph / 2);
        this._drawTip();
        return;
      }

      g.save();
      g.beginPath(); g.rect(PAD.l, PAD.t - 2, pw + 2, ph + 4); g.clip();
      this.series.forEach((ser, i) => {
        g.strokeStyle = ser.color;
        g.lineWidth = 2;
        g.lineJoin = 'round';
        g.lineCap = 'round';
        g.beginPath();
        let pen = false;
        let prevT = 0;
        visible.forEach((s) => {
          const v = s.v[i];
          if (v == null || (pen && s.t - prevT > 3000)) { pen = false; }   // celah data = garis putus
          if (v == null) return;
          const x = xOf(s.t), y = yOf(K.clamp(v, yMin, yMax));
          if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
          prevT = s.t;
        });
        g.stroke();
      });
      g.restore();

      // titik ujung (nilai terbaru) dengan cincin warna permukaan
      const lastS = visible[visible.length - 1];
      if (this.hover == null && now - lastS.t < 3000) {
        this.series.forEach((ser, i) => {
          const v = lastS.v[i];
          if (v == null) return;
          this._dot(xOf(lastS.t), yOf(K.clamp(v, yMin, yMax)), ser.color);
        });
      }

      // crosshair
      if (this.hover != null && this.samples[this.hover]) {
        const s = this.samples[this.hover];
        const x = Math.round(xOf(s.t)) + 0.5;
        g.strokeStyle = '#4A525B';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, PAD.t + ph); g.stroke();
        this.series.forEach((ser, i) => {
          if (s.v[i] == null) return;
          this._dot(xOf(s.t), yOf(K.clamp(s.v[i], yMin, yMax)), ser.color);
        });
      }
      this._drawTip();
    }

    _dot(x, y, color) {
      const g = this.ctx;
      g.fillStyle = SURFACE;
      g.beginPath(); g.arc(x, y, 5.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = color;
      g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
    }

    _drawTable() {
      const tb = this.o.table;
      tb.textContent = '';
      const thead = tb.createTHead().insertRow();
      ['Waktu'].concat(this.series.map((s) => s.label)).forEach((t) => {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = t;
        thead.appendChild(th);
      });
      const body = tb.createTBody();
      const rows = this.samples.slice(-30).reverse();
      if (!rows.length) {
        const r = body.insertRow();
        const c = r.insertCell();
        c.colSpan = this.series.length + 1;
        c.textContent = 'Belum ada data.';
        return;
      }
      rows.forEach((s) => {
        const r = body.insertRow();
        r.insertCell().textContent = K.fmtClock(new Date(s.t));
        s.v.forEach((v, i) => { r.insertCell().textContent = this._fmt(i, v); });
      });
    }
  }

  /**
   * Buat seluruh DOM grafik (legenda, kanvas, tooltip, tabel) di dalam `container`
   * lalu kembalikan instance LineChart-nya.
   */
  LineChart.mount = function (container, o) {
    container.textContent = '';
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    const box = document.createElement('div');
    box.className = 'chart-box';
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', o.ariaLabel || 'Grafik riwayat sensor. Gunakan panah kiri dan kanan untuk membaca nilai.');
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    box.append(canvas, tip);
    const tableWrap = document.createElement('div');
    tableWrap.className = 'chart-table-wrap';
    tableWrap.hidden = true;
    const table = document.createElement('table');
    table.className = 'chart-table';
    tableWrap.appendChild(table);
    container.append(legend, box, tableWrap);
    return new LineChart(Object.assign({}, o, { canvas, legend, tip, tableWrap, table }));
  };

  K.LineChart = LineChart;
})(window);
