/*
  util.js — fungsi-fungsi kecil yang dipakai semua modul lain.
  Semua file JS di proyek ini sengaja pakai <script> biasa (bukan ES module),
  karena ES module diblokir browser kalau halaman dibuka lewat file://
  dan kita mau dashboard ini bisa langsung di-double-click.
*/
(function (global) {
  'use strict';

  const K = global.Kopak = global.Kopak || {};

  K.$ = (id) => document.getElementById(id);
  K.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  K.pad2 = (n) => String(n).padStart(2, '0');

  K.fmtClock = (d) => `${K.pad2(d.getHours())}:${K.pad2(d.getMinutes())}:${K.pad2(d.getSeconds())}`;

  K.fmtDuration = (sec) => {
    if (!isFinite(sec) || sec < 0) return '—';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h} j ${m} mnt`;
    if (m > 0) return `${m} mnt ${s} dtk`;
    return `${s} dtk`;
  };

  // ---------- localStorage yang tidak pernah melempar error ----------
  // (mode private, storage diblokir, atau quota penuh -> diam saja, halaman tetap jalan)
  K.store = {
    get(key, fallback) {
      try {
        const raw = global.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { global.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove(key) {
      try { global.localStorage.removeItem(key); } catch (e) { /* abaikan */ }
    },
  };

  // ---------- Alamat robot & kamera ----------

  const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*$/i;

  function splitHostPort(text) {
    // "192.168.1.5:81" -> {host, port}; IPv6 tidak didukung (jarang dipakai di ESP)
    const m = /^([^:/\s]+)(?::(\d{1,5}))?$/.exec(text);
    if (!m) return null;
    const port = m[2] ? parseInt(m[2], 10) : null;
    if (port !== null && (port < 1 || port > 65535)) return null;
    if (!HOST_RE.test(m[1])) return null;
    return { host: m[1], port };
  }

  /**
   * Ubah isian "Alamat robot" jadi URL WebSocket.
   *   "fireguard.local"        -> ws://fireguard.local:81
   *   "192.168.4.1:8080"       -> ws://192.168.4.1:8080
   *   "ws://10.0.0.5:81"       -> dipakai apa adanya
   * Hasil null kalau formatnya salah.
   */
  K.parseRobotAddress = (input) => {
    const text = String(input || '').trim();
    if (!text) return null;
    if (/^wss?:\/\//i.test(text)) {
      try {
        const u = new URL(text);
        return u.hostname ? u.href.replace(/\/$/, '') : null;
      } catch (e) { return null; }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null; // skema lain (http:// dll) tidak cocok
    const hp = splitHostPort(text.replace(/\/+$/, ''));
    if (!hp) return null;
    return `ws://${hp.host}:${hp.port || 81}`;
  };

  /**
   * Ubah isian "Alamat kamera" jadi kumpulan URL ESP32-CAM.
   * Firmware kita (dan contoh CameraWebServer bawaan Espressif) memakai dua port:
   * kontrol di port 80 (/status, /capture, ...) dan stream di port 81 (/stream).
   *   "fireguard-cam.local"            -> stream http://fireguard-cam.local:81/stream,  base http://fireguard-cam.local
   *   "http://192.168.1.50:81/stream"  -> stream sesuai isian,                         base http://192.168.1.50
   * Kalau port selain 81 diberikan, dianggap server tunggal (semua di satu port),
   * mis. server tiruan untuk pengujian:
   *   "127.0.0.1:8090"                 -> stream http://127.0.0.1:8090/stream,          base http://127.0.0.1:8090
   * Hasil null kalau formatnya salah / kosong.
   */
  K.parseCameraAddress = (input) => {
    let text = String(input || '').trim();
    if (!text) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text;
    let u;
    try { u = new URL(text); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || !HOST_RE.test(u.hostname)) return null;

    const port = u.port ? parseInt(u.port, 10) : null;
    const singleServer = port !== null && port !== 81;
    const base = `${u.protocol}//${u.hostname}${singleServer ? ':' + port : ''}`;
    const isStreamPath = /\/stream\/?$/.test(u.pathname);
    let stream;
    if (isStreamPath) stream = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}${u.search}`;
    else stream = singleServer ? `${base}/stream` : `${u.protocol}//${u.hostname}:81/stream`;
    return { base, stream };
  };

  // ---------- Baterai Li-ion ----------

  // Kurva tegangan per sel (kira-kira, tanpa beban berat). Cukup untuk indikator kasar.
  const CELL_CURVE = [
    [4.20, 100], [4.10, 90], [4.00, 80], [3.90, 65], [3.80, 50],
    [3.70, 35], [3.60, 20], [3.50, 10], [3.30, 5], [3.00, 0],
  ];

  K.batteryPercent = (mv, cells) => {
    if (typeof mv !== 'number' || !isFinite(mv) || mv <= 0) return null;
    const perCell = (mv / 1000) / Math.max(1, cells || 1);
    if (perCell >= CELL_CURVE[0][0]) return 100;
    if (perCell <= CELL_CURVE[CELL_CURVE.length - 1][0]) return 0;
    for (let i = 0; i < CELL_CURVE.length - 1; i++) {
      const [v1, p1] = CELL_CURVE[i];
      const [v2, p2] = CELL_CURVE[i + 1];
      if (perCell <= v1 && perCell >= v2) {
        return Math.round(p2 + ((perCell - v2) / (v1 - v2)) * (p1 - p2));
      }
    }
    return null;
  };

  // ---------- Arah joystick (8 arah) ----------
  // x: kanan positif, y: maju positif (skala bebas, yang penting sama)
  K.directionLabel = (x, y, deadzone) => {
    const dz = deadzone == null ? 0.08 : deadzone;
    if (Math.hypot(x, y) < dz) return 'Berhenti';
    const a = (Math.atan2(y, x) * 180) / Math.PI; // 0 = kanan, 90 = maju
    if (a >= 67.5 && a < 112.5) return 'Maju';
    if (a >= 22.5 && a < 67.5) return 'Maju-Kanan';
    if (a >= -22.5 && a < 22.5) return 'Kanan';
    if (a >= -67.5 && a < -22.5) return 'Mundur-Kanan';
    if (a >= -112.5 && a < -67.5) return 'Mundur';
    if (a >= -157.5 && a < -112.5) return 'Mundur-Kiri';
    if (a >= 112.5 && a < 157.5) return 'Maju-Kiri';
    return 'Kiri';
  };

  // ---------- Unduh file dari string ----------
  K.downloadText = (filename, text, mime) => {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    K.downloadBlob(filename, blob);
  };
  K.downloadBlob = (filename, blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  K.csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  K.stamp = (d) => {
    d = d || new Date();
    return `${d.getFullYear()}${K.pad2(d.getMonth() + 1)}${K.pad2(d.getDate())}-${K.pad2(d.getHours())}${K.pad2(d.getMinutes())}${K.pad2(d.getSeconds())}`;
  };

  // ---------- Ikon (SVG inline, gaya garis seperti di mockup) ----------
  const svg = (inner, size) => `<svg width="${size || 17}" height="${size || 17}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  K.icons = {
    flame: (s) => svg('<path d="M12 2c1.4 3.6-2.2 5-2.2 8.4a4.2 4.2 0 1 0 8.4 0c0-1.3-.6-2.5-1.3-3.3.5 2-.6 3.3-2 3.3-1.8 0-2.1-2-1.1-3.8C14.9 5.1 13 2 12 2Z"/><path d="M8.8 17.3a3.2 3.2 0 0 0 6.4 0c0-1.5-1-2.2-1.6-3.1-.2 1-1 1.3-1.6.5"/>', s),
    gas: (s) => svg('<path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/>', s),
    radar: (s) => svg('<circle cx="12" cy="17" r="1.3" fill="currentColor" stroke="none"/><path d="M8.5 14.5a5 5 0 0 1 7 0"/><path d="M6 11.5a9 9 0 0 1 12 0"/>', s),
    camera: (s) => svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>', s),
    warn: (s) => svg('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>', s),
    gear: (s) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>', s),
    home: (s) => svg('<path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/>', s),
    download: (s) => svg('<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>', s),
    expand: (s) => svg('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>', s),
    bulb: (s) => svg('<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3Z"/>', s),
    stop: (s) => svg('<polygon points="7.9 2 16.1 2 22 7.9 22 16.1 16.1 22 7.9 22 2 16.1 2 7.9"/><path d="M8 8l8 8"/><path d="M16 8l-8 8"/>', s),
  };
})(window);
