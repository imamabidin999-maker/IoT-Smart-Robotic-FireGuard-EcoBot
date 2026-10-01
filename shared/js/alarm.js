/*
  alarm.js — bunyi peringatan dan notifikasi browser.

  Browser tidak mengizinkan suara sebelum pengguna berinteraksi dengan halaman,
  jadi AudioContext baru dibuat setelah klik/tekan tombol pertama. Kalau belum ada
  interaksi, alarm tetap tampil sebagai banner tapi tanpa suara (tidak error).
*/
(function (global) {
  'use strict';

  const K = global.Kopak;

  class Alarm {
    constructor(baseTitle) {
      this.baseTitle = baseTitle;
      this.sound = true;
      this.notify = false;
      this.active = null;          // {id, text}
      this._ctx = null;
      this._timer = null;
      this._unlock = () => this._ensureContext();
      document.addEventListener('pointerdown', this._unlock, { once: true });
      document.addEventListener('keydown', this._unlock, { once: true });
    }

    configure(o) {
      this.sound = o.sound !== false;
      this.notify = !!o.notify;
      if (!this.sound) this._stopBeeping();
      else if (this.active) this._startBeeping();
    }

    _ensureContext() {
      if (this._ctx) { if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {}); return; }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      try { this._ctx = new AC(); } catch (e) { this._ctx = null; }
    }

    _beep() {
      const ctx = this._ctx;
      if (!ctx || ctx.state !== 'running') return;
      const t0 = ctx.currentTime;
      [[880, 0], [660, 0.22]].forEach(([freq, off]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + off);
        gain.gain.exponentialRampToValueAtTime(0.08, t0 + off + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + off);
        osc.stop(t0 + off + 0.2);
      });
    }

    _startBeeping() {
      // AudioContext TIDAK dibuat di sini: sebelum ada klik/tombol pertama, browser menolaknya dan
      // mencatat peringatan di konsol. Konteks dibuat oleh _unlock (gestur pertama); sebelum itu alarm diam.
      if (this._timer || !this.sound) return;
      this._beep();
      this._timer = setInterval(() => this._beep(), 1600);
    }
    _stopBeeping() {
      clearInterval(this._timer);
      this._timer = null;
    }

    /** Minta izin notifikasi (harus dipanggil dari klik pengguna). Mengembalikan status izin. */
    static async requestPermission() {
      if (!('Notification' in global)) return 'unsupported';
      if (Notification.permission === 'granted' || Notification.permission === 'denied') return Notification.permission;
      try { return await Notification.requestPermission(); } catch (e) { return 'denied'; }
    }

    /** Mulai alarm. Kalau id yang sama sudah aktif, cuma teksnya yang diperbarui. */
    start(id, text) {
      const isNew = !this.active || this.active.id !== id;
      this.active = { id, text };
      document.title = `(!) ${this.baseTitle}`;
      if (isNew) {
        this._startBeeping();
        if (this.notify && 'Notification' in global && Notification.permission === 'granted' && document.hidden) {
          try { new Notification(this.baseTitle, { body: text, tag: 'kopak-' + id }); } catch (e) { /* abaikan */ }
        }
      }
    }

    stop() {
      this.active = null;
      document.title = this.baseTitle;
      this._stopBeeping();
    }
  }

  K.Alarm = Alarm;
})(window);
