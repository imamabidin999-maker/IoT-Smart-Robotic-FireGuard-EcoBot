/*
  controls.js — joystick, tombol tekan-tahan, dan pengirim perintah gerak.

  Prinsip keselamatan yang dipegang semua kontrol di sini:
    1. Perintah gerak dikirim berulang (10x/detik) selama dipegang. Robot punya
       dead-man timer; kalau kiriman berhenti, robot berhenti sendiri.
    2. Begitu kontrol dilepas / tab disembunyikan / jendela kehilangan fokus /
       pointer dibatalkan, perintah "berhenti" langsung dikirim.
*/
(function (global) {
  'use strict';

  const K = global.Kopak;
  const DRIVE_REPEAT_MS = 100;

  // ---------- Joystick ----------
  class Joystick {
    /**
     * @param {HTMLElement} base
     * @param {HTMLElement} knob
     * @param {{onChange:function({x:number,y:number,mag:number,active:boolean})}} opts
     *   x, y dalam -100..100 (x: kanan positif, y: maju positif)
     */
    constructor(base, knob, opts) {
      this.base = base;
      this.knob = knob;
      this.onChange = opts.onChange || (() => {});
      this.enabled = false;
      this.dragging = false;
      this.pointerId = null;
      this.keys = new Set();
      this.x = 0;
      this.y = 0;

      base.addEventListener('pointerdown', (e) => this._down(e));
      base.addEventListener('pointermove', (e) => this._move(e));
      base.addEventListener('pointerup', (e) => this._up(e));
      base.addEventListener('pointercancel', (e) => this._up(e));
      base.addEventListener('lostpointercapture', (e) => this._up(e));
      base.addEventListener('contextmenu', (e) => e.preventDefault());

      document.addEventListener('keydown', (e) => this._keydown(e));
      document.addEventListener('keyup', (e) => this._keyup(e));
      global.addEventListener('blur', () => this.release());
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.release(); });
    }

    setEnabled(on) {
      on = !!on;
      if (on === this.enabled) return;
      this.enabled = on;
      this.base.classList.toggle('disabled', !on);
      this.base.setAttribute('aria-disabled', on ? 'false' : 'true');
      if (!on) this.release();
    }

    /** radius gerak knob dalam px, menyesuaikan ukuran di layar */
    get radius() {
      const r = (this.base.clientWidth - this.knob.offsetWidth) / 2;
      return r > 4 ? r : 40;
    }

    release() {
      this.dragging = false;
      this.pointerId = null;
      this.keys.clear();
      this._set(0, 0);
    }

    _set(x, y) {
      x = Math.round(K.clamp(x, -100, 100));
      y = Math.round(K.clamp(y, -100, 100));
      const changed = x !== this.x || y !== this.y;
      this.x = x; this.y = y;
      const r = this.radius;
      this.knob.style.transform = `translate(${(x / 100) * r}px, ${(-y / 100) * r}px)`;
      this.base.classList.toggle('dragging', this.dragging || this.keys.size > 0);
      if (changed) this.onChange({ x, y, mag: Math.min(100, Math.hypot(x, y)), active: x !== 0 || y !== 0 });
    }

    _fromPointer(e) {
      const rect = this.base.getBoundingClientRect();
      const r = this.radius;
      let dx = e.clientX - (rect.left + rect.width / 2);
      let dy = e.clientY - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist > r) { dx = (dx / dist) * r; dy = (dy / dist) * r; }
      // zona mati kecil supaya sentuhan di tengah tidak membuat robot merayap
      const nx = dx / r, ny = -dy / r;
      if (Math.hypot(nx, ny) < 0.12) return this._set(0, 0);
      this._set(nx * 100, ny * 100);
    }

    _down(e) {
      if (!this.enabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      this.keys.clear();
      this.dragging = true;
      this.pointerId = e.pointerId;
      try { this.base.setPointerCapture(e.pointerId); } catch (err) { /* abaikan */ }
      this._fromPointer(e);
    }
    _move(e) {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      e.preventDefault();
      this._fromPointer(e);
    }
    _up(e) {
      if (!this.dragging || (this.pointerId !== null && e.pointerId !== this.pointerId)) return;
      this.dragging = false;
      this.pointerId = null;
      this._set(0, 0);
    }

    // ---------- keyboard: WASD + panah, aktif di seluruh halaman selama mode manual ----------
    _typing(e) {
      const t = e.target;
      if (!t || !t.tagName) return false;
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
      return !!(t.closest && t.closest('dialog[open]'));
    }
    static keyName(e) {
      const k = e.key;
      if (k === 'ArrowUp') return 'w';
      if (k === 'ArrowDown') return 's';
      if (k === 'ArrowLeft') return 'a';
      if (k === 'ArrowRight') return 'd';
      const l = k && k.length === 1 ? k.toLowerCase() : '';
      return 'wasd'.includes(l) && l ? l : '';
    }
    _keydown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = Joystick.keyName(e);
      if (!k || !this.enabled || this._typing(e) || this.dragging) return;
      e.preventDefault();
      this.keys.add(k);
      this._fromKeys();
    }
    _keyup(e) {
      const k = Joystick.keyName(e);
      if (!k || !this.keys.has(k)) return;
      this.keys.delete(k);
      this._fromKeys();
    }
    _fromKeys() {
      let dx = 0, dy = 0;
      if (this.keys.has('w')) dy += 1;
      if (this.keys.has('s')) dy -= 1;
      if (this.keys.has('a')) dx -= 1;
      if (this.keys.has('d')) dx += 1;
      const len = Math.hypot(dx, dy);
      if (len === 0) return this._set(0, 0);
      this._set((dx / len) * 100, (dy / len) * 100);
    }
  }

  // ---------- Pengirim perintah gerak ----------
  class DriveSender {
    /** @param {function(string):boolean} send */
    constructor(send) {
      this.send = send;
      this.x = 0;
      this.y = 0;
      this.timer = null;
      this.tailTimers = [];
    }
    _clearTail() { this.tailTimers.forEach(clearTimeout); this.tailTimers = []; }

    set(x, y) {
      this.x = x; this.y = y;
      if (x !== 0 || y !== 0) {
        this._clearTail();
        this.send(`DRV ${x} ${y}`);
        if (!this.timer) {
          this.timer = setInterval(() => this.send(`DRV ${this.x} ${this.y}`), DRIVE_REPEAT_MS);
        }
      } else {
        this.stop();
      }
    }

    /** kirim "berhenti" beberapa kali (jaga-jaga kalau ada paket hilang, mis. MQTT QoS 0) */
    stop() {
      this.x = 0; this.y = 0;
      clearInterval(this.timer); this.timer = null;
      this._clearTail();
      this.send('DRV 0 0');
      [120, 260].forEach((ms) => this.tailTimers.push(setTimeout(() => { if (!this.timer) this.send('DRV 0 0'); }, ms)));
    }
  }

  // ---------- Tombol tekan-tahan ----------
  /**
   * @param {HTMLElement} btn
   * @param {{onDown:function, onUp:function, onRepeat?:function, repeatMs?:number, isEnabled?:function}} o
   * @returns {{release:function, isDown:function}}
   */
  function holdButton(btn, o) {
    let down = false;
    let timer = null;
    const enabled = () => !btn.disabled && (o.isEnabled ? o.isEnabled() : true);

    function press() {
      if (down || !enabled()) return;
      down = true;
      btn.classList.add('active');
      o.onDown();
      if (o.onRepeat) timer = setInterval(() => { if (down) o.onRepeat(); }, o.repeatMs || 200);
    }
    function release() {
      if (!down) return;
      down = false;
      clearInterval(timer); timer = null;
      btn.classList.remove('active');
      o.onUp();
    }

    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* abaikan */ }
      press();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, release));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keyboard: hanya Enter. Spasi dipakai sebagai STOP darurat global di seluruh dashboard.
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); press(); }
    });
    btn.addEventListener('keyup', (e) => { if (e.key === 'Enter') { e.preventDefault(); release(); } });
    btn.addEventListener('blur', release);
    global.addEventListener('blur', release);
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

    return { release, isDown: () => down };
  }

  K.Joystick = Joystick;
  K.DriveSender = DriveSender;
  K.holdButton = holdButton;
})(window);
