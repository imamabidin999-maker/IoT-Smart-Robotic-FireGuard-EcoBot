/*
  activity-log.js — riwayat kejadian ("Aktivitas Terbaru").
  Isinya kejadian nyata (koneksi, mode, api terdeteksi, sampah diambil, dst),
  bukan data contoh. Disimpan di localStorage supaya tidak hilang saat halaman
  di-refresh. Teks selalu dimasukkan lewat textContent, jadi aman dari injeksi HTML.
*/
(function (global) {
  'use strict';

  const K = global.Kopak;
  const MAX_ENTRIES = 300;
  const DEDUPE_MS = 1500;

  class ActivityLog {
    /**
     * @param {{list:HTMLElement, storageKey:string}} o
     */
    constructor(o) {
      this.list = o.list;
      this.key = o.storageKey;
      const saved = K.store.get(this.key, []);
      this.entries = Array.isArray(saved)
        ? saved.filter((e) => e && typeof e.ts === 'number' && typeof e.text === 'string').slice(-MAX_ENTRIES)
        : [];
      this._saveT = null;
      this.render();
    }

    /** @param {'info'|'ok'|'warn'|'danger'|'accent'} level */
    add(level, text) {
      const now = Date.now();
      const last = this.entries[this.entries.length - 1];
      if (last && last.text === text && now - last.ts < DEDUPE_MS) return;
      this.entries.push({ ts: now, level, text });
      if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      this.render();
      this._scheduleSave();
    }

    clear() {
      this.entries = [];
      K.store.remove(this.key);
      this.render();
    }

    exportCsv() {
      const rows = this.entries.map((e) => [new Date(e.ts).toISOString(), e.level, e.text].map(K.csvCell).join(','));
      return ['waktu,level,kejadian'].concat(rows).join('\n');
    }

    _scheduleSave() {
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => K.store.set(this.key, this.entries), 400);
    }

    _timeLabel(ts) {
      const d = new Date(ts);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) return K.fmtClock(d);
      return `${K.pad2(d.getDate())}/${K.pad2(d.getMonth() + 1)} ${K.pad2(d.getHours())}:${K.pad2(d.getMinutes())}`;
    }

    render() {
      const list = this.list;
      list.textContent = '';
      if (!this.entries.length) {
        const p = document.createElement('div');
        p.className = 'log-empty';
        p.textContent = 'Belum ada aktivitas.';
        list.appendChild(p);
        return;
      }
      const frag = document.createDocumentFragment();
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i];
        const row = document.createElement('div');
        row.className = 'log-row';
        row.dataset.level = e.level || 'info';
        const dot = document.createElement('span');
        dot.className = 'log-dot';
        const time = document.createElement('span');
        time.className = 'log-time mono';
        time.textContent = this._timeLabel(e.ts);
        const text = document.createElement('span');
        text.className = 'log-text';
        text.textContent = e.text;
        row.append(dot, time, text);
        frag.appendChild(row);
      }
      list.appendChild(frag);
    }
  }

  K.ActivityLog = ActivityLog;
})(window);
