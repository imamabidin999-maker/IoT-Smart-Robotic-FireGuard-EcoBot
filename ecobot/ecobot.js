/*
  ecobot.js — logika dashboard khusus EcoBot.
  Kerangka umum (koneksi, joystick, log, kamera, pengaturan) ada di shared/js/dashboard.js.

  Urutan 6 sensor ultrasonik di telemetri (array `d` dan `l`):
    0 Depan · 1 Belakang · 2 Kiri · 3 Kanan · 4 Capit · 5 Bin
  Lima pertama dipakai untuk deteksi objek. Sensor ke-6 (Bin) menghadap ke dalam
  penampung dan diukur sebagai jarak ke permukaan sampah -> jadi persen kapasitas bin.
*/
(function () {
  'use strict';

  const K = window.Kopak;
  const $ = K.$;

  const LEVEL_KEY = ['ok', 'warn', 'danger'];
  const SENSORS = [
    { key: 'depan',    label: 'Depan',    texts: ['Kosong', 'Terdeteksi', 'Jangkauan'] },
    { key: 'belakang', label: 'Belakang', texts: ['Kosong', 'Terdeteksi', 'Dekat'] },
    { key: 'kiri',     label: 'Kiri',     texts: ['Kosong', 'Terdeteksi', 'Dekat'] },
    { key: 'kanan',    label: 'Kanan',    texts: ['Kosong', 'Terdeteksi', 'Dekat'] },
    { key: 'capit',    label: 'Capit',    texts: ['Kosong', 'Terdeteksi', 'Jangkauan'] },
  ];
  const DEFAULT_PINS = ['A0', 'A1', 'A2', 'A3', 'A4', 'D13'];
  const STATE_TEXT = {
    roam: 'Menjelajah', approach: 'Mendekati objek', align: 'Membidik objek', avoid: 'Menghindar',
    pick: 'Mengambil sampah', full: 'Bin penuh', manual: 'Kendali manual', idle: 'Siaga',
  };
  const BIN_WARN = 70;
  const BIN_FULL = 95;
  const SERIES = [
    { idx: 0, label: 'Depan', color: '#3987e5' },
    { idx: 2, label: 'Kiri', color: '#d95926' },
    { idx: 3, label: 'Kanan', color: '#199e70' },
  ];

  const el = {
    sensorList: $('sensorList'),
    gripBox: $('gripBox'), gripText: $('gripText'), clawLabel: $('clawLabel'), armLabel: $('armLabel'),
    clawBtn: $('clawBtn'), armBtn: $('armBtn'), pickBtn: $('pickBtn'),
    binValue: $('binLevelValue'), binFill: $('binFill'), binTrack: $('binTrack'),
    pickCount: $('pickCount'), binResetDemo: $('binResetDemo'), robotState: $('robotState'),
    chartMount: $('chartMount'), win60: $('win60'), win300: $('win300'), btnTable: $('btnTable'), btnCsv: $('btnCsv'),
  };

  let dash = null;
  let th = { det: 60, reach: 15, grab: 12 };
  let pins = DEFAULT_PINS.slice();
  let cards = [];
  let chart = null;
  const lastObjLog = {};

  const setText = (node, txt) => { if (node.textContent !== txt) node.textContent = txt; };
  const setAttr = (node, name, val) => { if (node.getAttribute(name) !== val) node.setAttribute(name, val); };

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
      short.textContent = s.label;
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

      // demo: klik kartu = paksa level (kosong -> terdeteksi -> jangkauan)
      const cycle = () => {
        if (!dash || !dash.isDemo || !dash.link.sim) return;
        const sim = dash.link.sim;
        const next = (sim.forced[i] + 1) % 3;
        sim.force(i, next);
        dash.toast(`Simulasi: sensor ${s.label} → ${s.texts[next]}`);
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
        setAttr(c.root, 'title', 'Demo: klik untuk mensimulasikan objek');
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
      thresholds: [{ y: th.det, label: 'terdeteksi' }, { y: th.reach, label: 'jangkauan' }],
      ariaLabel: 'Grafik jarak sensor ultrasonik depan, kiri, dan kanan',
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

  // ---------- tombol aktuator ----------

  const isManual = () => !!(dash && dash.alive && dash.tel && dash.tel.m === 'M' && dash.tel.st !== 'pick');

  el.clawBtn.addEventListener('click', () => {
    if (!isManual()) return;
    dash.send(`CLAW ${dash.tel.cl ? 0 : 1}`, true);
  });
  el.armBtn.addEventListener('click', () => {
    if (!isManual()) return;
    dash.send(`ARM ${dash.tel.ar ? 0 : 1}`, true);
  });
  el.pickBtn.addEventListener('click', () => {
    if (!dash.alive || !dash.tel || dash.tel.st === 'pick') return;
    if ((dash.tel.bin | 0) >= BIN_FULL) { dash.toast('Bin penuh. Kosongkan bin dulu sebelum mengambil sampah.', 'warn'); return; }
    dash.send('PICK', true);
  });
  el.binResetDemo.addEventListener('click', () => {
    if (dash.isDemo && dash.link.sim) { dash.link.sim.resetBin(); dash.toast('Simulasi: bin dikosongkan.'); }
  });

  // ---------- kejadian -> log & banner ----------

  function logEvents(tel, prev, d) {
    const n = tel.n | 0, pn = prev && typeof prev.n === 'number' ? prev.n : n;
    if (n > pn) d.log.add('ok', `Sampah ke-${n} masuk ke penampung (bin ${tel.bin}%)`);
    if (prev && tel.st === 'pick' && prev.st !== 'pick') d.log.add('accent', 'Mulai mengambil sampah…');

    const bin = tel.bin | 0, pbin = prev && typeof prev.bin === 'number' ? prev.bin : bin;
    if (bin >= BIN_FULL && pbin < BIN_FULL) d.log.add('danger', `Bin penuh (${bin}%) — pemungutan otomatis dihentikan`);
    else if (bin >= BIN_WARN && pbin < BIN_WARN) d.log.add('warn', `Bin terisi ${bin}%`);
    else if (bin < 50 && pbin >= BIN_WARN) d.log.add('ok', 'Bin sudah dikosongkan');

    const l = tel.l || [], pl = (prev && prev.l) || [];
    const now = Date.now();
    SENSORS.forEach((s, i) => {
      const cur = l[i] | 0, was = pl[i] | 0;
      const key = s.key + cur;
      if (cur >= 1 && cur > was && now - (lastObjLog[key] || 0) > 5000) {
        lastObjLog[key] = now;
        d.log.add(cur === 2 ? 'warn' : 'info', `Objek ${cur === 2 ? 'sangat dekat' : 'terdeteksi'} — sensor ${s.label} (${tel.d[i]} cm)`);
      }
    });

    if (prev && tel.m === 'A' && tel.st !== prev.st && tel.st !== 'pick' && STATE_TEXT[tel.st]) {
      d.log.add('accent', `Status robot: ${STATE_TEXT[tel.st]}`);
    }
    if (tel.m === 'M' && prev && prev.m === 'M' && typeof tel.cl === 'number' && tel.cl !== prev.cl && tel.st !== 'pick') {
      d.log.add('info', tel.cl ? 'Capit ditutup oleh operator' : 'Capit dibuka oleh operator');
    }
    if (tel.m === 'M' && prev && prev.m === 'M' && typeof tel.ar === 'number' && tel.ar !== prev.ar && tel.st !== 'pick') {
      d.log.add('info', tel.ar ? 'Lengan dinaikkan oleh operator' : 'Lengan diturunkan oleh operator');
    }
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
        text = c.spec.texts[lv];
        value = tel.d[i] >= 0 ? `${tel.d[i]} cm` : '—';
      }
      setAttr(c.root, 'data-status', status);
      setText(c.value, value);
      setText(c.status, text);
    });

    // capit & lengan
    const busy = alive && tel && tel.st === 'pick';
    const manual = !!(alive && tel && tel.m === 'M' && tel.st !== 'pick');
    let gStatus = 'off', gText = 'OFFLINE';
    if (alive && tel) {
      if (tel.st === 'pick') { gStatus = 'warn'; gText = 'MENGAMBIL SAMPAH'; }
      else if (tel.st === 'full') { gStatus = 'danger'; gText = 'BIN PENUH'; }
      else { gStatus = 'ok'; gText = (STATE_TEXT[tel.st] || 'SIAGA').toUpperCase(); }
    }
    setAttr(el.gripBox, 'data-status', gStatus);
    setText(el.gripText, gText);

    if (alive && tel && typeof tel.ca === 'number') {
      setText(el.clawLabel, `${tel.cl ? 'Tertutup' : 'Terbuka'} · ${tel.ca}°`);
      setText(el.armLabel, `${tel.ar ? 'Naik' : 'Turun'} · ${tel.aa}°`);
    } else {
      setText(el.clawLabel, '—');
      setText(el.armLabel, '—');
    }

    const offlineTxt = alive ? 'Nonaktif' : 'Tidak terhubung';
    el.clawBtn.disabled = !manual;
    el.armBtn.disabled = !manual;
    setText(el.clawBtn, manual ? (tel.cl ? 'Buka Capit' : 'Tutup Capit') : offlineTxt);
    setText(el.armBtn, manual ? (tel.ar ? 'Turunkan Lengan' : 'Naikkan Lengan') : offlineTxt);
    el.clawBtn.classList.toggle('active', !!(manual && tel.cl));
    el.armBtn.classList.toggle('active', !!(manual && tel.ar));

    const binFull = alive && tel && (tel.bin | 0) >= BIN_FULL;
    el.pickBtn.disabled = !alive || !tel || busy || binFull;
    setText(el.pickBtn, busy ? 'Sedang mengambil…' : (binFull ? 'Bin penuh' : 'Jalankan Urutan Ambil Sampah'));

    // bin
    if (alive && tel && typeof tel.bin === 'number') {
      const pct = K.clamp(tel.bin, 0, 100);
      const color = pct >= BIN_FULL ? 'var(--danger)' : (pct >= BIN_WARN ? 'var(--warn)' : 'var(--accent)');
      setText(el.binValue, `${pct}%`);
      el.binFill.style.width = `${pct}%`;
      el.binFill.style.background = color;
      el.binValue.style.color = color;
      setAttr(el.binTrack, 'aria-valuenow', String(pct));
      setText(el.pickCount, String(tel.n | 0));
    } else {
      setText(el.binValue, '—');
      el.binFill.style.width = '0%';
      el.binValue.style.color = '';
      setAttr(el.binTrack, 'aria-valuenow', '0');
      setText(el.pickCount, '—');
    }
    setText(el.robotState, alive && tel ? (STATE_TEXT[tel.st] || String(tel.st || '—')) : '—');

    // banner bin hampir penuh (sama seperti mockup)
    if (binFull) {
      d.setAlert('bin', 'warn', `KAPASITAS BIN HAMPIR PENUH — ${tel.bin}% · Segera kembali ke titik pembuangan${tel.m === 'A' ? ' (pemungutan otomatis dihentikan)' : ''}`);
    } else {
      d.setAlert('bin', null);
    }
  }

  function onInfo(info) {
    if (Array.isArray(info.pins)) { pins = info.pins.map(String); refreshSubs(); }
    if (info.th && typeof info.th === 'object') {
      th = { det: +info.th.det || th.det, reach: +info.th.reach || th.reach, grab: +info.th.grab || th.grab };
      chart.o.thresholds = [{ y: th.det, label: 'terdeteksi' }, { y: th.reach, label: 'jangkauan' }];
      chart.render();
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
