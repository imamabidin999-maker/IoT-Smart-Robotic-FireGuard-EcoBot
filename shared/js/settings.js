/*
  settings.js — dialog pengaturan koneksi (dibuat lewat JS supaya kedua dashboard
  memakai isi yang persis sama). Semua isian divalidasi dulu sebelum disimpan,
  pesan kesalahan muncul tepat di bawah isian yang salah.
*/
(function (global) {
  'use strict';

  const K = global.Kopak;

  const TEMPLATE = `
<form id="settingsForm" novalidate>
  <div class="dlg-head">
    <h2 class="dlg-title" id="dlgTitle"></h2>
    <button type="button" class="icon-btn" id="dlgClose" aria-label="Tutup pengaturan">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>
  </div>

  <div class="dlg-body">
    <div class="field">
      <span class="label" id="lblMode">Mode koneksi</span>
      <div class="seg" role="radiogroup" aria-labelledby="lblMode">
        <input type="radio" name="mode" id="modeDemo" value="demo"><label for="modeDemo">Demo</label>
        <input type="radio" name="mode" id="modeWs" value="ws"><label for="modeWs">Langsung</label>
        <input type="radio" name="mode" id="modeMqtt" value="mqtt"><label for="modeMqtt">MQTT</label>
      </div>
      <div class="hint" id="modeHint"></div>
    </div>

    <div class="field-group" id="grpWs" hidden>
      <div class="field">
        <label for="fHost">Alamat robot</label>
        <input type="text" id="fHost" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="errHost">
        <div class="hint">Alamat ESP bridge di robot. Port bawaan 81. Kalau <span class="mono">.local</span> tidak jalan di perangkat ini, pakai alamat IP yang tampil di Serial Monitor.</div>
        <div class="err" id="errHost" role="alert"></div>
      </div>
    </div>

    <div class="field-group" id="grpMqtt" hidden>
      <div class="field">
        <label for="fMqttUrl">Alamat broker (WebSocket)</label>
        <input type="text" id="fMqttUrl" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="errMqttUrl">
        <div class="hint">Contoh: <span class="mono">wss://broker.hivemq.com:8884/mqtt</span></div>
        <div class="err" id="errMqttUrl" role="alert"></div>
      </div>
      <div class="field">
        <label for="fMqttPrefix">Awalan topik</label>
        <input type="text" id="fMqttPrefix" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="errMqttPrefix">
        <div class="hint">Harus sama dengan <span class="mono">MQTT_PREFIX</span> di firmware. Broker publik bisa dibaca siapa saja, jadi pakai awalan yang unik (mis. <span class="mono">kopak-v3925008</span>).</div>
        <div class="err" id="errMqttPrefix" role="alert"></div>
      </div>
      <div class="field">
        <label for="fMqttUser">Username (opsional)</label>
        <input type="text" id="fMqttUser" autocomplete="off" autocapitalize="off" spellcheck="false">
      </div>
      <div class="field">
        <label for="fMqttPass">Password (opsional)</label>
        <input type="password" id="fMqttPass" autocomplete="off">
      </div>
    </div>

    <div class="field-group" id="grpCam" hidden>
      <div class="field">
        <label for="fCam">Alamat kamera ESP32-CAM</label>
        <input type="text" id="fCam" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="errCam">
        <div class="hint">Kosongkan kalau belum ada kamera. Stream diambil dari port 81 (<span class="mono">/stream</span>).</div>
        <div class="err" id="errCam" role="alert"></div>
      </div>
    </div>

    <div class="field" id="mixedWarn" hidden>
      <div class="hint" style="color: var(--warn)">Halaman ini dibuka lewat https. Browser akan memblokir koneksi ws:// dan kamera http:// ke robot. Buka dashboard lewat file:// atau http:// (mis. <span class="mono">python3 -m http.server</span>), atau pakai mode MQTT tanpa kamera.</div>
    </div>

    <div class="field">
      <label for="fCells">Baterai Li-ion di robot</label>
      <select id="fCells">
        <option value="1">1 sel (3,7 V)</option>
        <option value="2">2 sel seri (7,4 V)</option>
        <option value="3">3 sel seri (11,1 V)</option>
      </select>
      <div class="hint">Dipakai untuk mengubah tegangan baterai jadi persen. Nilainya muncul kalau sensor tegangan sudah dipasang dan diaktifkan di firmware.</div>
    </div>

    <label class="check"><input type="checkbox" id="fSound"><span>Bunyikan alarm saat ada bahaya (butuh sekali klik di halaman dulu supaya browser mengizinkan suara)</span></label>
    <label class="check"><input type="checkbox" id="fNotify"><span>Tampilkan notifikasi browser saat bahaya dan tab sedang tidak dibuka</span></label>
    <div class="err" id="errNotify" role="alert"></div>
  </div>

  <div class="dlg-foot">
    <button type="button" class="btn btn-ghost" id="btnReset">Kembalikan ke Demo</button>
    <button type="button" class="btn" id="btnCancel">Batal</button>
    <button type="submit" class="btn btn-primary">Simpan &amp; Sambungkan</button>
  </div>
</form>`;

  const MODE_HINTS = {
    demo: 'Robot virtual di browser. Cocok untuk mencoba tampilan dan presentasi tanpa perangkat keras.',
    ws: 'Sambung langsung ke ESP bridge di robot lewat WiFi yang sama (paling simpel dan paling cepat).',
    mqtt: 'Lewat broker MQTT, jadi dashboard dan robot boleh beda jaringan. Butuh internet di dua sisi.',
  };

  class SettingsDialog {
    /**
     * @param {{title:string, onSave:function(object), onReset:function()}} o
     */
    constructor(o) {
      this.o = o;
      const dlg = document.createElement('dialog');
      dlg.className = 'settings';
      dlg.setAttribute('aria-labelledby', 'dlgTitle');
      dlg.innerHTML = TEMPLATE;
      document.body.appendChild(dlg);
      this.dlg = dlg;
      const $ = (id) => dlg.querySelector('#' + id);
      this.f = {
        form: $('settingsForm'), title: $('dlgTitle'), hint: $('modeHint'),
        host: $('fHost'), cam: $('fCam'), url: $('fMqttUrl'), prefix: $('fMqttPrefix'),
        user: $('fMqttUser'), pass: $('fMqttPass'), cells: $('fCells'),
        sound: $('fSound'), notify: $('fNotify'),
        grpWs: $('grpWs'), grpMqtt: $('grpMqtt'), grpCam: $('grpCam'), mixed: $('mixedWarn'),
        errHost: $('errHost'), errUrl: $('errMqttUrl'), errPrefix: $('errMqttPrefix'), errCam: $('errCam'), errNotify: $('errNotify'),
      };
      this.f.title.textContent = `Pengaturan — ${o.title}`;
      const sug = o.suggestions || {};
      this.suggestedHost = sug.host || '';
      this.f.host.placeholder = sug.host ? `${sug.host} atau 192.168.1.20` : '192.168.1.20';
      this.f.cam.placeholder = sug.camera ? `${sug.camera} (kosongkan kalau belum ada kamera)` : 'kosongkan kalau belum ada kamera';
      this.f.url.placeholder = 'wss://broker.hivemq.com:8884/mqtt';

      dlg.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => this._syncMode()));
      $('dlgClose').addEventListener('click', () => dlg.close());
      $('btnCancel').addEventListener('click', () => dlg.close());
      $('btnReset').addEventListener('click', () => { dlg.close(); o.onReset(); });
      this.f.form.addEventListener('submit', (e) => { e.preventDefault(); this._save(); });
      this.f.cam.addEventListener('input', () => this._syncMode());
      this.f.notify.addEventListener('change', async () => {
        this.f.errNotify.textContent = '';
        if (!this.f.notify.checked) return;
        const perm = await K.Alarm.requestPermission();
        if (perm !== 'granted') {
          this.f.notify.checked = false;
          this.f.errNotify.textContent = perm === 'unsupported'
            ? 'Browser ini tidak mendukung notifikasi.'
            : 'Izin notifikasi ditolak. Aktifkan lewat pengaturan situs di browser.';
        }
      });
      // klik di luar kotak dialog (backdrop) menutup dialog
      dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.close(); });
    }

    get isOpen() { return this.dlg.open; }

    open(cfg) {
      const f = this.f;
      this.dlg.querySelector(`input[name="mode"][value="${cfg.mode}"]`).checked = true;
      f.host.value = cfg.host || this.suggestedHost;     // saran awal: tinggal klik Simpan kalau cocok
      f.cam.value = cfg.camera || '';
      f.url.value = cfg.mqttUrl || '';
      f.prefix.value = cfg.mqttPrefix || '';
      f.user.value = cfg.mqttUser || '';
      f.pass.value = cfg.mqttPass || '';
      f.cells.value = String(cfg.cells || 2);
      f.sound.checked = cfg.sound !== false;
      f.notify.checked = !!cfg.notify && 'Notification' in global && Notification.permission === 'granted';
      this._clearErrors();
      this._syncMode();
      if (!this.dlg.open) this.dlg.showModal();
    }

    _mode() {
      const r = this.dlg.querySelector('input[name="mode"]:checked');
      return r ? r.value : 'demo';
    }

    _syncMode() {
      const m = this._mode();
      const f = this.f;
      f.grpWs.hidden = m !== 'ws';
      f.grpMqtt.hidden = m !== 'mqtt';
      f.grpCam.hidden = m === 'demo';
      f.hint.textContent = MODE_HINTS[m];
      const https = global.location && global.location.protocol === 'https:';
      f.mixed.hidden = !(https && (m === 'ws' || (m !== 'demo' && f.cam.value.trim())));
    }

    _clearErrors() {
      const f = this.f;
      [f.errHost, f.errUrl, f.errPrefix, f.errCam, f.errNotify].forEach((e) => { e.textContent = ''; });
      [f.host, f.url, f.prefix, f.cam].forEach((i) => i.removeAttribute('aria-invalid'));
    }

    _fail(input, errEl, msg) {
      errEl.textContent = msg;
      input.setAttribute('aria-invalid', 'true');
    }

    _save() {
      const f = this.f;
      this._clearErrors();
      const mode = this._mode();
      let bad = null;

      const host = f.host.value.trim();
      const url = f.url.value.trim();
      const prefix = f.prefix.value.trim().replace(/^\/+|\/+$/g, '');
      const cam = f.cam.value.trim();

      if (mode === 'ws' && !K.parseRobotAddress(host)) {
        this._fail(f.host, f.errHost, 'Alamat tidak valid. Contoh: fireguard.local atau 192.168.1.20 (boleh pakai :port).');
        bad = bad || f.host;
      }
      if (mode === 'mqtt') {
        if (!/^wss?:\/\/[^\s/]+/i.test(url)) {
          this._fail(f.url, f.errUrl, 'Harus diawali ws:// atau wss://, mis. wss://broker.hivemq.com:8884/mqtt');
          bad = bad || f.url;
        }
        if (!prefix || !/^[A-Za-z0-9_\-/]+$/.test(prefix)) {
          this._fail(f.prefix, f.errPrefix, 'Hanya huruf, angka, garis bawah, strip, dan garis miring. Tidak boleh kosong.');
          bad = bad || f.prefix;
        }
      }
      if (mode !== 'demo' && cam && !K.parseCameraAddress(cam)) {
        this._fail(f.cam, f.errCam, 'Alamat kamera tidak valid. Contoh: fireguard-cam.local atau http://192.168.1.50');
        bad = bad || f.cam;
      }
      if (bad) { bad.focus(); return; }

      this.dlg.close();
      this.o.onSave({
        mode,
        host,
        camera: cam,
        mqttUrl: url,
        mqttPrefix: prefix || 'kopak',
        mqttUser: f.user.value.trim(),
        mqttPass: f.pass.value,
        cells: parseInt(f.cells.value, 10) || 2,
        sound: f.sound.checked,
        notify: f.notify.checked,
      });
    }
  }

  K.SettingsDialog = SettingsDialog;
})(window);
