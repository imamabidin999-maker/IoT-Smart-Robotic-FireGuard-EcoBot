/*
  ecobot.js — logika dashboard khusus EcoBot (robot penyapu).
  Kerangka umum (koneksi, joystick, log, kamera, pengaturan) ada di shared/js/dashboard.js.

  Urutan 6 sensor ultrasonik di telemetri (array `d` dan `l`):
    0 Depan · 1 Kiri-depan · 2 Kanan-depan · 3 Kiri · 4 Kanan · 5 Wadah
  Lima pertama untuk mendeteksi rintangan. Sensor ke-6 (Wadah) menghadap ke dalam
  wadah sampah dan diukur sebagai jarak ke permukaan sampah -> jadi persen kapasitas wadah.
*/
(function () {
  'use strict';

  const K = window.Kopak;
  const $ = K.$;

  const LEVEL_KEY = ['ok', 'warn', 'danger'];
  const LEVEL_TEXT = ['Kosong', 'Terdeteksi', 'Dekat'];
  const SENSORS = [
    { key: 'depan',   label: 'Depan',       short: 'Depan' },
    { key: 'kidepan', label: 'Kiri-depan',  short: 'Ki-depan' },
    { key: 'kadepan', label: 'Kanan-depan', short: 'Ka-depan' },
    { key: 'kiri',    label: 'Kiri',        short: 'Kiri' },
    { key: 'kanan',   label: 'Kanan',       short: 'Kanan' },
  ];
  const DEFAULT_PINS = ['A0', 'A1', 'A2', 'A3', 'A4', 'D13'];
  const STATE_TEXT = {
    sweep: 'Menyapu', avoid: 'Menghindar', turn: 'Berbelok', full: 'Wadah penuh', manual: 'Kendali manual',
  };
  const BIN_WARN = 70;
  const BIN_FULL = 95;
  const SERIES = [
    { idx: 0, label: 'Depan', color: '#3987e5' },
    { idx: 1, label: 'Kiri-depan', color: '#d95926' },
    { idx: 2, label: 'Kanan-depan', color: '#199e70' },
  ];

  const el = {
    sensorList: $('sensorList'),
    brushBox: $('brushBox'), brushText: $('brushText'), brushLabel: $('brushLabel'), liftLabel: $('liftLabel'),
    brushBtn: $('brushBtn'), liftBtn: $('liftBtn'),
    brushSpeed: $('brushSpeed'), brushSpeedValue: $('brushSpeedValue'), brushSpeedRow: $('brushSpeedRow'), brushRelayNote: $('brushRelayNote'),
    binValue: $('binLevelValue'), binFill: $('binFill'), binTrack: $('binTrack'),
    sweepTime: $('sweepTime'), binResetDemo: $('binResetDemo'), robotState: $('robotState'),
    chartMount: $('chartMount'), win60: $('win60'), win300: $('win300'), btnTable: $('btnTable'), btnCsv: $('btnCsv'),
  };

  let dash = null;
  let th = { det: 50, near: 20, side: 10 };
  let pins = DEFAULT_PINS.slice();
  let brushPwm = true;                 // false = motor sapu lewat relay (hanya nyala/mati)
  let cards = [];
  let chart = null;
  let speedTimer = null;
  const lastLog = {};

  const setText = (node, txt) => { if (node.textContent !== txt) node.textContent = txt; };
  const setAttr = (node, name, val) => { if (node.getAttribute(name) !== val) node.setAttribute(name, val); };
  /** catat ke log paling sering sekali per `ms` untuk kunci yang sama (supaya log tidak banjir) */
  const logLimited = (d, key, ms, level, text) => {
    const now = Date.now();
    if (now - (lastLog[key] || 0) < ms) return;
    lastLog[key] = now;
    d.log.add(level, text);
  };

  // ---------- kartu sensor ----------

  function buildCards() {
    el.sensorList.textContent = '';
    el.sensorList.style.setProperty('--cols', '3');
    cards = SENSORS.map((s, i) => {
      const root = document.createElement('div');
      root.className = 'sensor-card';
      root.dataset.status = 'off';
      root.setAttribute('role', 'group');
      root.setAttribute('aria-label', `Sensor ultrasonik ${s.label}`);

      const main = document.createElement('div');
      main.className = 'sensor-main';
      const icon = document.createElement('span');
      icon.className = 'sensor-icon';
      icon.innerHTML = K.icons.radar(17);
      const info = document.createElement('div');
      info.className = 'sensor-info';
      const lab = document.createElement('div');
      lab.className = 'sensor-label';
      const full = document.createElement('span');
      full.className = 'label-full';
      full.textContent = `Sensor ${s.label}`;
      const short = document.createElement('span');
      short.className = 'label-short';
      short.textContent = s.short;
      lab.append(full, short);
      const sub = document.createElement('div');
      sub.className = 'sensor-sub';
      info.append(lab, sub);
      main.append(icon, info);

      const read = document.createElement('div');
      read.className = 'sensor-readout';
      const value = document.createElement('div');
      value.className = 'sensor-value mono';
      value.textContent = '—';
      const status = document.createElement('div');
      status.className = 'sensor-status';
      status.textContent = 'Offline';
      read.append(value, status);

      root.append(main, read);
      el.sensorList.appendChild(root);

      // demo: klik kartu = paksa level (kosong -> terdeteksi -> dekat)
      const cycle = () => {
        if (!dash || !dash.isDemo || !dash.link.sim) return;
        const sim = dash.link.sim;
        const next = (sim.forced[i] + 1) % 3;
        sim.force(i, next);
        dash.toast(`Simulasi: sensor ${s.label} → ${LEVEL_TEXT[next]}`);
      };
      root.addEventListener('click', cycle);
      root.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && root.classList.contains('demo-click')) { e.preventDefault(); cycle(); }
      });
      return { root, value, status, sub, spec: s };
    });
    refreshSubs();
  }

  function refreshSubs() {
    cards.forEach((c, i) => setText(c.sub, `Ultrasonik · ${pins[i] || '—'}`));
  }

  function markDemoClickable(on) {
    cards.forEach((c) => {
      c.root.classList.toggle('demo-click', on);
      if (on) {
        setAttr(c.root, 'tabindex', '0');
        setAttr(c.root, 'role', 'button');
        setAttr(c.root, 'title', 'Demo: klik untuk mensimulasikan rintangan');
      } else {
        c.root.removeAttribute('tabindex');
        setAttr(c.root, 'role', 'group');
        c.root.removeAttribute('title');
      }
    });
  }

  // ---------- grafik ----------

  function initChart() {
    chart = K.LineChart.mount(el.chartMount, {
      series: SERIES.map((s) => ({ label: s.label, color: s.color })),
      yMin: 0, yMax: 200, yTicks: [0, 50, 100, 150, 200], unit: 'cm', windowSec: 60,
      thresholds: [{ y: th.det, label: 'terdeteksi' }, { y: th.near, label: 'dekat' }],
      ariaLabel: 'Grafik jarak sensor ultrasonik depan, kiri-depan, dan kanan-depan',
    });
    const setWin = (sec) => {
      el.win60.setAttribute('aria-pressed', String(sec === 60));
      el.win300.setAttribute('aria-pressed', String(sec === 300));
      chart.setWindow(sec);
    };
    el.win60.addEventListener('click', () => setWin(60));
    el.win300.addEventListener('click', () => setWin(300));
    el.btnTable.addEventListener('click', () => {
      const on = el.btnTable.getAttribute('aria-pressed') !== 'true';
      el.btnTable.setAttribute('aria-pressed', String(on));
      chart.setTableMode(on);
    });
    el.btnCsv.addEventListener('click', () => {
      if (!chart.samples.length) { dash.toast('Belum ada data untuk diunduh.', 'warn'); return; }
      K.downloadText(`ecobot-jarak-${K.stamp()}.csv`, chart.exportCsv(), 'text/csv;charset=utf-8');
    });
  }

  // ---------- tombol sapu ----------

  const isManual = () => !!(dash && dash.alive && dash.tel && dash.tel.m === 'M');
  const sliderPct = () => parseInt(el.brushSpeed.value, 10) || 70;

  el.brushBtn.addEventListener('click', () => {
    if (!isManual()) return;
    const on = (dash.tel.bt | 0) > 0;
    dash.send(`BRUSH ${on ? 0 : (brushPwm ? sliderPct() : 100)}`, true);
  });
  el.liftBtn.addEventListener('click', () => {
    if (!isManual()) return;
    dash.send(`LIFT ${dash.tel.lf ? 0 : 1}`, true);
  });
  el.brushSpeed.addEventListener('input', () => {
    setText(el.brushSpeedValue, `${sliderPct()}%`);
    // kalau sapu sedang berputar, kecepatan baru langsung dikirim (dibatasi supaya tidak membanjiri)
    clearTimeout(speedTimer);
    speedTimer = setTimeout(() => {
      if (isManual() && (dash.tel.bt | 0) > 0) dash.send(`BRUSH ${sliderPct()}`);
    }, 150);
  });
  el.binResetDemo.addEventListener('click', () => {
    if (dash.isDemo && dash.link.sim) { dash.link.sim.resetBin(); dash.toast('Simulasi: wadah dikosongkan.'); }
  });

  // ---------- kejadian -> log & banner ----------

  function logEvents(tel, prev, d) {
    const bin = tel.bin | 0, pbin = prev && typeof prev.bin === 'number' ? prev.bin : bin;
    if (bin >= BIN_FULL && pbin < BIN_FULL) d.log.add('danger', `Wadah penuh (${bin}%)${tel.m === 'A' ? ' — menyapu otomatis dihentikan' : ''}`);
    else if (bin >= BIN_WARN && pbin < BIN_WARN) d.log.add('warn', `Wadah terisi ${bin}%`);
    else if (bin < 50 && pbin >= BIN_WARN) d.log.add('ok', 'Wadah sudah dikosongkan');

    if (!prev) return;

    if (tel.m === 'A') {
      if (tel.st === 'sweep' && prev.st !== 'sweep' && prev.st !== 'avoid' && prev.st !== 'turn') d.log.add('accent', 'Mulai menyapu otomatis');
      if (tel.st === 'avoid' && prev.st !== 'avoid') {
        const front = [0, 1, 2].map((i) => tel.d[i]).filter((v) => v >= 0);
        const near = front.length ? Math.min(...front) : null;
        logLimited(d, 'avoid', 8000, 'info', `Rintangan di depan${near != null ? ` (${near} cm)` : ''} — mundur dan berbelok`);
      }
    }

    // sapu & pengangkat: dicatat saat dikendalikan operator (di mode otomatis berubah terlalu sering)
    if (tel.m === 'M' && prev.m === 'M') {
      const bt = tel.bt | 0, pbt = prev.bt | 0;
      if (bt > 0 && pbt === 0) d.log.add('info', `Sapu dinyalakan (${bt}%)`);
      else if (bt === 0 && pbt > 0) d.log.add('info', 'Sapu dimatikan');
      if (typeof tel.lf === 'number' && tel.lf !== prev.lf) d.log.add('info', tel.lf ? 'Sapu diangkat' : 'Sapu diturunkan');
    }

    const l = tel.l || [], pl = (prev && prev.l) || [];
    SENSORS.forEach((s, i) => {
      if ((l[i] | 0) === 2 && (pl[i] | 0) < 2) {
        logLimited(d, 'near-' + s.key, 10000, 'warn', `Rintangan dekat — sensor ${s.label} (${tel.d[i]} cm)`);
      }
    });
  }

  // ---------- render ----------

  function render(ctx, d) {
    const { alive, tel } = ctx;
    markDemoClickable(!!ctx.isDemo && alive);
    el.binResetDemo.hidden = !ctx.isDemo;

    cards.forEach((c, i) => {
      let status = 'off', value = '—', text = 'Offline';
      if (alive && tel && Array.isArray(tel.d) && typeof tel.d[i] === 'number') {
        const lv = K.clamp((tel.l && tel.l[i]) | 0, 0, 2);
        status = LEVEL_KEY[lv];
        text = LEVEL_TEXT[lv];
        value = tel.d[i] >= 0 ? `${tel.d[i]} cm` : '—';
      }
      setAttr(c.root, 'data-status', status);
      setText(c.value, value);
      setText(c.status, text);
    });

    // kotak status sapu
    const manual = !!(alive && tel && tel.m === 'M');
    const br = alive && tel ? tel.br | 0 : 0;
    const bt = alive && tel ? tel.bt | 0 : 0;
    let bStatus = 'off', bText = 'OFFLINE';
    if (alive && tel) {
      if (tel.st === 'full') { bStatus = 'danger'; bText = 'WADAH PENUH'; }
      else if (tel.st === 'avoid') { bStatus = 'warn'; bText = 'MENGHINDAR RINTANGAN'; }
      else if (br > 0) { bStatus = 'ok'; bText = tel.m === 'A' ? 'MENYAPU' : 'SAPU BERPUTAR'; }
      else if (tel.m === 'A') { bStatus = 'ok'; bText = 'MENYIAPKAN SAPU'; }
      else { bStatus = 'off'; bText = 'SAPU MATI'; }
    }
    setAttr(el.brushBox, 'data-status', bStatus);
    setText(el.brushText, bText);

    if (alive && tel && typeof tel.la === 'number') {
      setText(el.brushLabel, br > 0 ? `Berputar · ${br}%` : (bt > 0 ? `Mulai berputar…` : 'Mati'));
      setText(el.liftLabel, `${tel.lf ? 'Terangkat' : 'Turun'} · ${tel.la}°`);
    } else {
      setText(el.brushLabel, '—');
      setText(el.liftLabel, '—');
    }

    const offlineTxt = alive ? 'Nonaktif' : 'Tidak terhubung';
    el.brushBtn.disabled = !manual;
    el.liftBtn.disabled = !manual;
    setText(el.brushBtn, manual ? (bt > 0 ? 'Matikan Sapu' : 'Nyalakan Sapu') : offlineTxt);
    setText(el.liftBtn, manual ? (tel.lf ? 'Turunkan Sapu' : 'Angkat Sapu') : offlineTxt);
    el.brushBtn.classList.toggle('active', manual && bt > 0);
    el.liftBtn.classList.toggle('active', !!(manual && !tel.lf));
    el.brushSpeed.disabled = !manual || !brushPwm;
    el.brushSpeedRow.hidden = !brushPwm;
    el.brushRelayNote.hidden = brushPwm;

    // wadah
    if (alive && tel && typeof tel.bin === 'number') {
      const pct = K.clamp(tel.bin, 0, 100);
      const color = pct >= BIN_FULL ? 'var(--danger)' : (pct >= BIN_WARN ? 'var(--warn)' : 'var(--accent)');
      setText(el.binValue, `${pct}%`);
      el.binFill.style.width = `${pct}%`;
      el.binFill.style.background = color;
      el.binValue.style.color = color;
      setAttr(el.binTrack, 'aria-valuenow', String(pct));
      setText(el.sweepTime, typeof tel.sw === 'number' ? K.fmtDuration(tel.sw) : '—');
    } else {
      setText(el.binValue, '—');
      el.binFill.style.width = '0%';
      el.binValue.style.color = '';
      setAttr(el.binTrack, 'aria-valuenow', '0');
      setText(el.sweepTime, '—');
    }
    setText(el.robotState, alive && tel ? (STATE_TEXT[tel.st] || String(tel.st || '—')) : '—');

    // banner wadah hampir penuh
    const binFull = alive && tel && (tel.bin | 0) >= BIN_FULL;
    if (binFull) {
      d.setAlert('bin', 'warn', `KAPASITAS WADAH HAMPIR PENUH — ${tel.bin}% · Kosongkan wadah sampah${tel.m === 'A' ? ' (menyapu otomatis dihentikan)' : ''}`);
    } else {
      d.setAlert('bin', null);
    }
  }

  function onInfo(info) {
    if (Array.isArray(info.pins)) { pins = info.pins.map(String); refreshSubs(); }
    if (info.th && typeof info.th === 'object') {
      th = { det: +info.th.det || th.det, near: +info.th.near || th.near, side: +info.th.side || th.side };
      chart.o.thresholds = [{ y: th.det, label: 'terdeteksi' }, { y: th.near, label: 'dekat' }];
      chart.render();
    }
    if (info.brush && typeof info.brush === 'object') {
      brushPwm = info.brush.pwm !== 0;
      const min = +info.brush.min;
      if (isFinite(min) && min > 0 && min < 100) {
        el.brushSpeed.min = String(min);
        if (sliderPct() < min) el.brushSpeed.value = String(min);
        setText(el.brushSpeedValue, `${sliderPct()}%`);
      }
    }
  }

  function onTel(tel, prev, d) {
    if (Array.isArray(tel.d)) chart.push(SERIES.map((s) => (tel.d[s.idx] >= 0 ? tel.d[s.idx] : null)));
    logEvents(tel, prev, d);
  }

  // ---------- mulai ----------

  buildCards();
  initChart();

  dash = new K.KopakDashboard({
    robot: 'ecobot',
    title: 'EcoBot',
    simFactory: K.sim.ecobotFactory,
    defaults: { host: 'ecobot.local', camera: 'ecobot-cam.local' },
    onInfo,
    onTel,
    render,
    onConfig: () => { chart.clear(); },
  });

  setInterval(() => { chart.render(); }, 1000);

  dash.renderAll();       // render pertama terjadi sebelum `dash` terisi; ulangi sekarang
  window.ecobot = dash;   // memudahkan debugging dari console & pengujian
})();
