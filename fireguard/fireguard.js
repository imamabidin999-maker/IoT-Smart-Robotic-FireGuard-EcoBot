/*
  fireguard.js — logika dashboard khusus FireGuard.
  Kerangka umum (koneksi, joystick, log, kamera, pengaturan) ada di shared/js/dashboard.js.

  Jumlah sensor tidak ditulis mati di sini: robot melaporkan berapa sensor api dan
  gas yang terpasang lewat pesan `info` (dan lewat panjang array di telemetri),
  lalu kartu & grafik menyesuaikan. Jadi kalau di firmware FLAME_COUNT diganti 2 -> 3,
  dashboard tidak perlu diubah.
*/
(function () {
  'use strict';

  const K = window.Kopak;
  const $ = K.$;

  const LEVEL_KEY = ['ok', 'warn', 'danger'];
  const FLAME_TEXT = ['Aman', 'Waspada', 'Bahaya'];
  const GAS_TEXT = ['Normal', 'Waspada', 'Bahaya'];
  const STATE_TEXT = {
    idle: 'Siaga', turn: 'Mengarah ke api', approach: 'Mendekati api',
    spray: 'Memadamkan api', rest: 'Jeda pompa', manual: 'Kendali manual',
  };
  // canvas tidak mengerti var(), jadi warna seri (sama dengan --s1..--s3) ditulis sebagai hex
  const SERIES_HEX = ['#3987e5', '#d95926', '#199e70'];

  const DEFAULT_TH = { fw: 700, fd: 400, gw: 350, gd: 550 };

  const el = {
    flameList: $('flameList'), gasList: $('gasList'), gasSub: $('gasSub'), sensorNote: $('sensorNote'),
    pumpBox: $('pumpBox'), pumpText: $('pumpText'), pumpBtn: $('pumpBtn'),
    nozSlider: $('nozSlider'), nozAngle: $('nozAngle'), robotState: $('robotState'),
    chartMount: $('chartMount'), tabFlame: $('tabFlame'), tabGas: $('tabGas'),
    win60: $('win60'), win300: $('win300'), btnTable: $('btnTable'), btnCsv: $('btnCsv'), chartNote: $('chartNote'),
  };

  let dash = null;                   // diisi setelah KopakDashboard dibuat
  let th = Object.assign({}, DEFAULT_TH);
  let layout = { flame: [], gas: [] };   // [{label, pin}]
  let flameCards = [];
  let gasCards = [];
  let charts = { flame: null, gas: null };
  let activeChart = 'flame';
  let nozDragging = false;
  let nozTimer = null;

  const setText = (node, txt) => { if (node.textContent !== txt) node.textContent = txt; };
  const setAttr = (node, name, val) => { if (node.getAttribute(name) !== val) node.setAttribute(name, val); };

  // ---------- kartu sensor ----------

  function defaultFlameLabels(n) {
    if (n === 2) return ['Kiri', 'Kanan'];
    if (n === 3) return ['Kiri', 'Depan', 'Kanan'];
    return Array.from({ length: n }, (_, i) => `Flame ${i + 1}`);
  }

  function makeCard(kind, label, sub) {
    const root = document.createElement('div');
    root.className = 'sensor-card';
    root.dataset.status = 'off';
    root.setAttribute('role', 'group');

    const main = document.createElement('div');
    main.className = 'sensor-main';
    const icon = document.createElement('span');
    icon.className = 'sensor-icon';
    icon.innerHTML = kind === 'flame' ? K.icons.flame(17) : K.icons.gas(17);
    const info = document.createElement('div');
    info.className = 'sensor-info';
    const lab = document.createElement('div');
    lab.className = 'sensor-label';
    const full = document.createElement('span');
    full.className = 'label-full';
    full.textContent = kind === 'flame' ? `Sensor ${label}` : label;
    const short = document.createElement('span');
    short.className = 'label-short';
    short.textContent = label;
    lab.append(full, short);
    const subEl = document.createElement('div');
    subEl.className = 'sensor-sub';
    subEl.textContent = sub;
    info.append(lab, subEl);
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
    return { root, value, status, label };
  }

  function buildSensors(flame, gas) {
    const sig = JSON.stringify([flame, gas]);
    if (sig === JSON.stringify([layout.flame, layout.gas])) return;
    layout = { flame, gas };

    el.flameList.textContent = '';
    el.gasList.textContent = '';
    flameCards = flame.map((f) => makeCard('flame', f.label, `IR Flame · ${f.pin}`));
    gasCards = gas.map((g) => makeCard('gas', g.label, `Gas · ${g.pin}`));
    flameCards.forEach((c, i) => { c.root.setAttribute('aria-label', `Sensor api ${c.label}`); el.flameList.appendChild(c.root); bindDemoClick(c, 'flame', i); });
    gasCards.forEach((c, i) => { c.root.setAttribute('aria-label', `Sensor gas ${c.label}`); el.gasList.appendChild(c.root); bindDemoClick(c, 'gas', i); });
    el.gasSub.hidden = gas.length === 0;
    el.gasList.hidden = gas.length === 0;

    // hitung kolom grid untuk tampilan HP sesuai jumlah kartu (maks 3 per baris)
    el.flameList.style.setProperty('--cols', String(Math.min(3, Math.max(1, flame.length))));
    el.gasList.style.setProperty('--cols', String(Math.min(3, Math.max(1, gas.length))));

    const fSeries = flame.map((f, i) => ({ label: f.label, color: SERIES_HEX[i % 3] }));
    const gSeries = gas.map((g, i) => ({ label: g.label, color: SERIES_HEX[i % 3] }));
    charts.flame.setSeries(fSeries);
    charts.gas.setSeries(gSeries);
    if (flame.length === 0) selectChart('gas');
  }

  // Di mode demo, klik kartu = paksa level sensor (aman -> waspada -> bahaya). Hanya simulasi.
  function bindDemoClick(card, kind, idx) {
    const cycle = () => {
      if (!dash || !dash.isDemo || !dash.link.sim) return;
      const sim = dash.link.sim;
      const cur = kind === 'flame' ? sim.flForced[idx] : sim.gsForced[idx];
      const next = (cur + 1) % 3;
      sim.force(kind, idx, next);
      dash.toast(`Simulasi: ${card.label} → ${(kind === 'flame' ? FLAME_TEXT : GAS_TEXT)[next]}`);
    };
    card.root.addEventListener('click', cycle);
    card.root.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && card.root.classList.contains('demo-click')) { e.preventDefault(); cycle(); }
    });
  }

  function markDemoClickable(on) {
    [flameCards, gasCards].forEach((list) => list.forEach((c) => {
      c.root.classList.toggle('demo-click', on);
      if (on) {
        setAttr(c.root, 'tabindex', '0');
        setAttr(c.root, 'role', 'button');
        setAttr(c.root, 'title', 'Demo: klik untuk mensimulasikan api / gas');
      } else {
        c.root.removeAttribute('tabindex');
        setAttr(c.root, 'role', 'group');
        c.root.removeAttribute('title');
      }
    }));
  }

  // ---------- grafik ----------

  function applyThresholds() {
    charts.flame.o.thresholds = [{ y: th.fw, label: 'waspada' }, { y: th.fd, label: 'bahaya' }];
    charts.gas.o.thresholds = [{ y: th.gw, label: 'waspada' }, { y: th.gd, label: 'bahaya' }];
    charts.flame.render();
    charts.gas.render();
  }

  function selectChart(which) {
    activeChart = which;
    el.tabFlame.setAttribute('aria-pressed', String(which === 'flame'));
    el.tabGas.setAttribute('aria-pressed', String(which === 'gas'));
    charts.flame.canvas.closest('.chart-holder').hidden = which !== 'flame';
    charts.gas.canvas.closest('.chart-holder').hidden = which !== 'gas';
    el.chartNote.textContent = which === 'flame'
      ? 'Nilai sensor api adalah ADC 0–1023: makin kecil berarti api makin dekat/kuat.'
      : 'Nilai sensor gas adalah ADC 0–1023: makin besar berarti kadar gas/asap makin tinggi. Sensor MQ-2 butuh pemanasan dulu setiap dinyalakan.';
    charts[which].render();
  }

  function initCharts() {
    const holderFlame = document.createElement('div');
    holderFlame.className = 'chart-holder';
    const holderGas = document.createElement('div');
    holderGas.className = 'chart-holder';
    holderGas.hidden = true;
    el.chartMount.append(holderFlame, holderGas);

    const common = { yMin: 0, yMax: 1023, yTicks: [0, 256, 512, 768, 1023], windowSec: 60 };
    charts.flame = K.LineChart.mount(holderFlame, Object.assign({ series: [], thresholds: [], ariaLabel: 'Grafik nilai sensor api' }, common));
    charts.gas = K.LineChart.mount(holderGas, Object.assign({ series: [], thresholds: [], ariaLabel: 'Grafik nilai sensor gas' }, common));

    el.tabFlame.addEventListener('click', () => selectChart('flame'));
    el.tabGas.addEventListener('click', () => selectChart('gas'));
    const setWin = (sec) => {
      el.win60.setAttribute('aria-pressed', String(sec === 60));
      el.win300.setAttribute('aria-pressed', String(sec === 300));
      charts.flame.setWindow(sec); charts.gas.setWindow(sec);
    };
    el.win60.addEventListener('click', () => setWin(60));
    el.win300.addEventListener('click', () => setWin(300));
    el.btnTable.addEventListener('click', () => {
      const on = el.btnTable.getAttribute('aria-pressed') !== 'true';
      el.btnTable.setAttribute('aria-pressed', String(on));
      charts.flame.setTableMode(on); charts.gas.setTableMode(on);
    });
    el.btnCsv.addEventListener('click', () => {
      const c = charts[activeChart];
      if (!c.samples.length) { dash.toast('Belum ada data untuk diunduh.', 'warn'); return; }
      K.downloadText(`fireguard-${activeChart === 'flame' ? 'api' : 'gas'}-${K.stamp()}.csv`, c.exportCsv(), 'text/csv;charset=utf-8');
    });
    applyThresholds();
  }

  // ---------- pompa & nozzle ----------

  const pumpHold = K.holdButton(el.pumpBtn, {
    repeatMs: 200,
    isEnabled: () => !!(dash && dash.alive && dash.tel && dash.tel.m === 'M'),
    onDown: () => { dash.send('PUMP 1', true); },
    onRepeat: () => { dash.send('PUMP 1'); },
    onUp: () => { dash.send('PUMP 0'); setTimeout(() => dash.send('PUMP 0'), 120); },
  });

  el.nozSlider.addEventListener('input', () => {
    nozDragging = true;
    setText(el.nozAngle, `${el.nozSlider.value}°`);
    clearTimeout(nozTimer);
    nozTimer = setTimeout(() => { dash.send(`NOZ ${el.nozSlider.value}`); }, 80);
  });
  el.nozSlider.addEventListener('change', () => { dash.send(`NOZ ${el.nozSlider.value}`); setTimeout(() => { nozDragging = false; }, 400); });

  // ---------- kejadian -> log & alarm ----------

  const joinLabels = (arr, idxs) => idxs.map((i) => arr[i] ? arr[i].label : `#${i + 1}`).join(', ');
  const idxWhere = (arr, pred) => (arr || []).map((v, i) => (pred(v) ? i : -1)).filter((i) => i >= 0);

  function logEvents(tel, prev, d) {
    const fsNow = tel.fs || [], fsPrev = (prev && prev.fs) || [];
    const fireNow = fsNow.some((l) => l === 2), firePrev = fsPrev.some((l) => l === 2);
    const warnNow = fsNow.some((l) => l >= 1), warnPrev = fsPrev.some((l) => l >= 1);

    if (fireNow && !firePrev) {
      const idx = idxWhere(fsNow, (l) => l === 2);
      d.log.add('danger', `Api terdeteksi — sektor ${joinLabels(layout.flame, idx)} (nilai ${idx.map((i) => tel.fl[i]).join(', ')})`);
    } else if (!fireNow && firePrev) {
      d.log.add('ok', 'Api tidak terdeteksi lagi');
    } else if (!fireNow && warnNow && !warnPrev) {
      d.log.add('warn', `Tanda api lemah di sektor ${joinLabels(layout.flame, idxWhere(fsNow, (l) => l >= 1))} (waspada)`);
    }

    const glNow = tel.gl || [], glPrev = (prev && prev.gl) || [];
    const gMax = Math.max(0, ...glNow), gMaxPrev = Math.max(0, ...glPrev);
    if (gMax > gMaxPrev && gMax >= 1) {
      const idx = idxWhere(glNow, (l) => l === gMax);
      d.log.add(gMax === 2 ? 'danger' : 'warn', `Kadar gas ${gMax === 2 ? 'BERBAHAYA' : 'naik'} — ${joinLabels(layout.gas, idx)} (nilai ${idx.map((i) => tel.gs[i]).join(', ')})`);
    } else if (gMax === 0 && gMaxPrev > 0) {
      d.log.add('ok', 'Kadar gas kembali normal');
    }

    const pNow = tel.p ? 1 : 0, pPrev = prev && prev.p ? 1 : 0;
    if (pNow && !pPrev) d.log.add('warn', tel.m === 'A' ? 'Pompa aktif otomatis — memadamkan api' : 'Pompa diaktifkan manual oleh operator');
    else if (!pNow && pPrev) d.log.add('info', 'Pompa dimatikan');

    if (prev && tel.m === 'A' && tel.st !== prev.st && STATE_TEXT[tel.st] && tel.st !== 'spray') {
      d.log.add('accent', `Status robot: ${STATE_TEXT[tel.st]}`);
    }
  }

  function updateAlerts(ctx, d) {
    const tel = ctx.tel;
    if (!ctx.alive || !tel) {
      d.setAlert('fire', null); d.setAlert('gas', null); d.alarm.stop();
      return;
    }
    const fsNow = tel.fs || [];
    const fireIdx = idxWhere(fsNow, (l) => l === 2);
    if (fireIdx.length) {
      const sector = joinLabels(layout.flame, fireIdx);
      const text = tel.m === 'A'
        ? `API TERDETEKSI — Sektor ${sector} · Pompa otomatis ${tel.p ? 'AKTIF memadamkan' : 'bersiap'}`
        : `API TERDETEKSI — Sektor ${sector} · Mode manual: tekan-tahan tombol pompa untuk memadamkan`;
      d.setAlert('fire', 'danger', text);
      d.alarm.start('fire', text);
    } else {
      d.setAlert('fire', null);
    }

    const glNow = tel.gl || [];
    const gMax = Math.max(0, ...glNow);
    if (gMax >= 1) {
      const idx = idxWhere(glNow, (l) => l === gMax);
      const text = gMax === 2
        ? `KADAR GAS BERBAHAYA — ${joinLabels(layout.gas, idx)} · Jauhi area, ventilasi ruangan`
        : `Kadar gas/asap naik — ${joinLabels(layout.gas, idx)} · Pantau terus`;
      d.setAlert('gas', gMax === 2 ? 'danger' : 'warn', text);
      if (!fireIdx.length) { if (gMax === 2) d.alarm.start('gas', text); else d.alarm.stop(); }
    } else {
      d.setAlert('gas', null);
      if (!fireIdx.length) d.alarm.stop();
    }
  }

  // ---------- render ----------

  function render(ctx, d) {
    const { alive, tel } = ctx;
    const manual = alive && tel && tel.m === 'M';
    markDemoClickable(!!ctx.isDemo && alive);

    // sensor api
    flameCards.forEach((c, i) => {
      let status = 'off', value = '—', text = 'Offline';
      if (alive && tel && tel.fl && typeof tel.fl[i] === 'number') {
        const lv = K.clamp((tel.fs && tel.fs[i]) | 0, 0, 2);
        status = LEVEL_KEY[lv]; value = String(Math.round(tel.fl[i])); text = FLAME_TEXT[lv];
      }
      setAttr(c.root, 'data-status', status); setText(c.value, value); setText(c.status, text);
    });

    // sensor gas (MQ-2 perlu pemanasan)
    const warming = alive && tel && tel.gw === 1;
    gasCards.forEach((c, i) => {
      let status = 'off', value = '—', text = 'Offline';
      if (alive && tel && tel.gs && typeof tel.gs[i] === 'number') {
        const lv = K.clamp((tel.gl && tel.gl[i]) | 0, 0, 2);
        value = String(Math.round(tel.gs[i]));
        if (warming) { status = 'off'; text = 'Pemanasan'; }
        else { status = LEVEL_KEY[lv]; text = GAS_TEXT[lv]; }
      }
      setAttr(c.root, 'data-status', status); setText(c.value, value); setText(c.status, text);
    });
    const note = warming ? 'Sensor gas MQ-2 sedang pemanasan. Pembacaan baru bisa dipercaya setelah beberapa puluh detik.' : '';
    el.sensorNote.hidden = !note;
    setText(el.sensorNote, note);

    // pompa
    let pStatus = 'off', pText = 'OFFLINE';
    if (alive && tel) {
      if (tel.p) { pStatus = 'danger'; pText = tel.m === 'A' ? 'AKTIF MEMADAMKAN' : 'AKTIF (MANUAL)'; }
      else if (tel.st === 'rest') { pStatus = 'warn'; pText = 'JEDA PENDINGIN'; }
      else { pStatus = 'ok'; pText = 'STANDBY'; }
    }
    setAttr(el.pumpBox, 'data-status', pStatus);
    setText(el.pumpText, pText);

    el.pumpBtn.disabled = !manual;
    setText(el.pumpBtn, manual ? 'Tahan untuk Menyemprotkan Air' : (alive ? 'Nonaktif — Aktifkan Mode Manual' : 'Tidak terhubung'));
    if (!manual) pumpHold.release();

    // nozzle
    el.nozSlider.disabled = !manual;
    if (alive && tel && typeof tel.na === 'number') {
      if (!nozDragging) { el.nozSlider.value = String(tel.na); setText(el.nozAngle, `${tel.na}°`); }
    } else {
      setText(el.nozAngle, '—');
    }

    setText(el.robotState, alive && tel ? (STATE_TEXT[tel.st] || String(tel.st || '—')) : '—');
    updateAlerts(ctx, d);
  }

  function onInfo(info) {
    if (info.th && typeof info.th === 'object') {
      th = { fw: +info.th.fw || DEFAULT_TH.fw, fd: +info.th.fd || DEFAULT_TH.fd, gw: +info.th.gw || DEFAULT_TH.gw, gd: +info.th.gd || DEFAULT_TH.gd };
      applyThresholds();
    }
    if (info.noz && isFinite(info.noz.min) && isFinite(info.noz.max)) {
      el.nozSlider.min = String(info.noz.min);
      el.nozSlider.max = String(info.noz.max);
    }
    const strs = (a) => (Array.isArray(a) ? a.map(String) : null);
    const fl = strs(info.flame), fp = strs(info.flamePins) || [];
    const gl = strs(info.gas), gp = strs(info.gasPins) || [];
    if (fl && gl) {
      buildSensors(
        fl.map((label, i) => ({ label, pin: fp[i] || `A${i}` })),
        gl.map((label, i) => ({ label, pin: gp[i] || `A${fl.length + i}` })),
      );
    }
  }

  function onTel(tel, prev, d) {
    // robot lama/tanpa info: sesuaikan jumlah kartu dengan panjang array telemetri
    const nf = Array.isArray(tel.fl) ? tel.fl.length : layout.flame.length;
    const ng = Array.isArray(tel.gs) ? tel.gs.length : layout.gas.length;
    if (nf !== layout.flame.length || ng !== layout.gas.length) {
      buildSensors(
        defaultFlameLabels(nf).map((label, i) => ({ label, pin: `A${i}` })),
        Array.from({ length: ng }, (_, i) => ({ label: ng === 1 ? 'MQ-2' : `MQ-2 #${i + 1}`, pin: `A${nf + i}` })),
      );
    }
    charts.flame.push(tel.fl || []);
    charts.gas.push(tel.gs || []);
    logEvents(tel, prev, d);
  }

  // ---------- mulai ----------

  initCharts();
  // tampilan awal (sebelum robot mengirim info): konfigurasi bawaan firmware
  buildSensors(
    defaultFlameLabels(2).map((label, i) => ({ label, pin: `A${i}` })),
    [{ label: 'MQ-2', pin: 'A3' }],
  );

  dash = new K.KopakDashboard({
    robot: 'fireguard',
    title: 'FireGuard',
    simFactory: K.sim.fireguardFactory,
    defaults: { host: 'fireguard.local', camera: 'fireguard-cam.local' },
    onInfo,
    onTel,
    render,
    onEstop: () => { pumpHold.release(); },
    onConfig: () => { charts.flame.clear(); charts.gas.clear(); },
  });

  // grafik ikut bergeser tiap detik walau tidak ada data baru
  setInterval(() => { charts[activeChart].render(); }, 1000);

  dash.renderAll();       // render pertama terjadi sebelum `dash` terisi; ulangi sekarang
  window.fireguard = dash;   // memudahkan debugging dari console & pengujian
})();
