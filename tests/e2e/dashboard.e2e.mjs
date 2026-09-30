// Uji end-to-end dashboard FireGuard & EcoBot di Chromium sungguhan.
//
// Yang diuji: mode Demo, koneksi WebSocket dan MQTT ke robot palsu (tools/mock-robot),
// kamera (stream, macet, putus), sambung ulang otomatis, tampilan di beberapa ukuran layar,
// dan yang terpenting: TIDAK ADA error/warning konsol, error halaman, atau request gagal.
//
// Jalankan:  cd tests && npm install && npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  launch, openDashboard, pageUrl, spySend, sent, clearSent, waitMode, setManual, text,
  joystickCenter, sleep, ROOT, SHOTS,
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const mock = require(path.join(ROOT, 'tools/mock-robot/index.js'));

const ROBOTS = ['fireguard', 'ecobot'];
const DEFAULT_MODE = { fireguard: 'A', ecobot: 'M' };
const NET_NOISE = [/WebSocket connection to/, /Failed to load resource/, /ERR_CONNECTION/, /ERR_ABORTED/, /ERR_EMPTY_RESPONSE/, /ERR_INVALID_HTTP_RESPONSE/, /ERR_INCOMPLETE_CHUNKED_ENCODING/];

let browser;
before(async () => { browser = await launch(); fs.mkdirSync(SHOTS, { recursive: true }); });
after(async () => { await browser.close(); });

let portSeed = 20000 + (process.pid % 2000) * 8;    // acak per proses supaya dua kali jalan tidak bentrok
const ports = () => { const p = { ws: portSeed, cam: portSeed + 1, mqttWs: portSeed + 2 }; portSeed += 4; return p; };

/** buka dashboard, jalankan fn, pastikan tidak ada error, tutup */
async function run(robot, o, fn) {
  const { ctx, page, watch } = await openDashboard(browser, robot, o);
  try {
    await fn({ page, watch });
    if (!o.skipClean) watch.assertClean(assert, `${robot} (${o.label || 'uji'})`);
  } finally {
    await ctx.close();
  }
}

const logTexts = (page) => page.$$eval('#logList .log-text', (els) => els.map((e) => e.textContent));
const attr = (page, sel, name) => page.locator(sel).first().getAttribute(name);
const waitText = (page, sel, re, timeout = 5000) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout });
const waitAttr = (page, sel, name, val, timeout = 5000) => page.waitForFunction(([s, n, v]) => document.querySelector(s).getAttribute(n) === v, [sel, name, val], { timeout });
const waitLog = (page, re, timeout = 6000) => page.waitForFunction((src) => [...document.querySelectorAll('#logList .log-text')].some((e) => new RegExp(src).test(e.textContent)), re.source, { timeout });

// =====================================================================
//  Tampilan & layout
// =====================================================================
const VIEWPORTS = [
  ['desktop-1440', 1440, 900], ['laptop-1024', 1024, 768], ['tablet-820', 820, 1180],
  ['hp-390', 390, 844], ['hp-kecil-360', 360, 740],
];

for (const robot of ROBOTS) {
  test(`${robot}: bersih dari error & tidak ada scroll horizontal di semua ukuran layar`, async () => {
    for (const [name, width, height] of VIEWPORTS) {
      await run(robot, { viewport: { width, height }, label: name }, async ({ page }) => {
        await sleep(2300);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 1, `${name}: halaman melebar ${overflow}px keluar layar`);
        await page.screenshot({ path: path.join(SHOTS, `${robot}-${name}.png`), fullPage: true });
      });
    }
  });

  test(`${robot}: susunan kartu sesuai ukuran layar (3 kolom / 2 kolom / 1 kolom)`, async () => {
    const tops = async (page) => page.evaluate(() => {
      const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.left, y: b.top + scrollY, w: b.width, h: b.height }; };
      return { feed: r('cardFeed'), move: r('cardMovement'), sens: r('cardSensors'), act: r('cardActuator'), chart: r('cardChart'), log: r('cardLog'), sys: r('cardSystem') };
    });
    await run(robot, { viewport: { width: 1440, height: 900 }, label: 'desktop' }, async ({ page }) => {
      const t = await tops(page);
      assert.ok(t.move.x < t.feed.x && t.feed.x < t.sens.x, 'desktop: kiri=kontrol, tengah=kamera, kanan=sensor');
      assert.ok(Math.abs(t.move.y - t.feed.y) < 2 && Math.abs(t.feed.y - t.sens.y) < 2, 'desktop: ketiga kolom mulai sejajar di atas');
      assert.ok(t.act.y > t.move.y + t.move.h - 1, 'desktop: kartu aktuator di bawah kontrol');
    });
    await run(robot, { viewport: { width: 820, height: 1180 }, label: 'tablet' }, async ({ page }) => {
      const t = await tops(page);
      assert.ok(t.feed.w > t.move.w * 1.6, 'tablet: kamera selebar dua kolom');
      assert.ok(Math.abs(t.move.y - t.sens.y) < 2 && t.move.x < t.sens.x, 'tablet: kontrol dan sensor berdampingan');
    });
    await run(robot, { viewport: { width: 390, height: 844 }, label: 'hp' }, async ({ page }) => {
      const t = await tops(page);
      const order = ['feed', 'move', 'sens', 'act', 'chart', 'log', 'sys'].map((k) => t[k].y);
      assert.deepEqual([...order].sort((a, b) => a - b), order, 'HP: urutan kamera, kontrol, sensor, aktuator, grafik, log, status');
      assert.ok(t.feed.w <= 390 && t.move.w <= 390, 'HP: kartu tidak melebihi lebar layar');
    });
  });

  test(`${robot}: semua tombol, tautan, dan isian punya nama yang terbaca pembaca layar`, async () => {
    await run(robot, {}, async ({ page }) => {
      await page.click('#btnSettings');
      const bad = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('button, a[href], input, select').forEach((el) => {
          if (el.type === 'hidden' || el.closest('[hidden]')) return;
          const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent.trim()
            || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label') || el.title;
          if (!label) out.push(el.outerHTML.slice(0, 90));
        });
        return out;
      });
      assert.deepEqual(bad, [], 'elemen tanpa nama');
    });
  });
}

// =====================================================================
//  Mode Demo (umum)
// =====================================================================
for (const robot of ROBOTS) {
  test(`${robot} demo: status koneksi, chip demo, kamera simulasi`, async () => {
    await run(robot, {}, async ({ page }) => {
      await waitText(page, '#connText', /^Demo$/);
      assert.equal(await attr(page, '#connDot', 'data-state'), 'demo');
      assert.equal(await page.locator('#demoChip').isVisible(), true);
      await waitAttr(page, '#camViewport', 'data-state', 'live');
      assert.match(await text(page, '[data-cam="res"]'), /640×360 · \d+ FPS/);
      assert.equal(await page.locator('#camViewport canvas').isVisible(), true);
      assert.match(await text(page, '#sysConn'), /Demo \(simulasi\) · aktif/);
      assert.match(await text(page, '#sysFw'), /^v1\.0\.0-sim$/);
      assert.match(await text(page, '#batText'), /^\d+%$/, 'baterai simulasi tampil sebagai persen');
    });
  });

  test(`${robot} demo: toggle Otomatis/Manual mengikuti konfirmasi robot`, async () => {
    await run(robot, {}, async ({ page }) => {
      const first = DEFAULT_MODE[robot];
      await waitMode(page, first);
      const other = first === 'A' ? 'M' : 'A';
      await page.click(other === 'A' ? '#btnAuto' : '#btnManual');
      await waitMode(page, other);
      assert.equal(await attr(page, other === 'A' ? '#btnAuto' : '#btnManual', 'aria-pressed'), 'true');
      assert.equal(await attr(page, first === 'A' ? '#btnAuto' : '#btnManual', 'aria-pressed'), 'false');
      await waitLog(page, other === 'A' ? /Mode diubah ke Otomatis/ : /Mode diubah ke Manual/);
      const joyDisabled = await page.locator('#joyBase').evaluate((e) => e.classList.contains('disabled'));
      assert.equal(joyDisabled, other === 'A', 'joystick hanya aktif di mode manual');
    });
  });

  test(`${robot} demo: joystick (mouse), WASD/panah, dan perintah gerak dikirim berulang lalu berhenti`, async () => {
    await run(robot, {}, async ({ page }) => {
      await spySend(page, robot);
      // di mode otomatis joystick mati
      if (DEFAULT_MODE[robot] === 'A') {
        const { cx, cy } = await joystickCenter(page);
        await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx, cy - 50); await page.mouse.up();
        await page.keyboard.down('w'); await sleep(250); await page.keyboard.up('w');
        assert.equal((await sent(page)).filter((l) => l.startsWith('DRV')).length, 0, 'mode otomatis: tidak boleh ada perintah DRV');
      }
      await setManual(page);
      await clearSent(page);

      // drag mouse ke atas = maju
      const { cx, cy, r } = await joystickCenter(page);
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx, cy - r, { steps: 4 });
      await waitText(page, '#dirLabel', /^Maju$/);
      assert.match(await text(page, '#intensityLabel'), /Intensitas (9\d|100)%/);
      await sleep(700);
      const speed = parseInt((await text(page, '#speedValue')).split('/')[0], 10);
      assert.ok(speed > 0, `meter kecepatan harus naik saat maju, nilai ${speed}`);
      await page.mouse.move(cx + r, cy, { steps: 4 });
      await waitText(page, '#dirLabel', /^Kanan$/);
      await page.mouse.up();
      await waitText(page, '#dirLabel', /^Berhenti$/);
      await sleep(400);
      const s = await sent(page);
      const drv = s.filter((l) => l.startsWith('DRV'));
      assert.ok(drv.length >= 8, `perintah DRV harus dikirim berulang (~10/detik), dapat ${drv.length}`);
      assert.ok(drv.includes('DRV 0 100'), 'maju penuh = DRV 0 100');
      assert.ok(drv.some((l) => /^DRV 100 0$/.test(l)), 'kanan penuh = DRV 100 0');
      assert.equal(drv[drv.length - 1], 'DRV 0 0', 'perintah terakhir harus berhenti');
      assert.ok(drv.filter((l) => l === 'DRV 0 0').length >= 2, 'berhenti dikirim beberapa kali (jaga-jaga paket hilang)');

      // keyboard
      await clearSent(page);
      await page.keyboard.down('w'); await waitText(page, '#dirLabel', /^Maju$/);
      await page.keyboard.down('d'); await waitText(page, '#dirLabel', /^Maju-Kanan$/);
      await page.keyboard.up('w'); await waitText(page, '#dirLabel', /^Kanan$/);
      await page.keyboard.up('d'); await waitText(page, '#dirLabel', /^Berhenti$/);
      await page.keyboard.down('ArrowLeft'); await waitText(page, '#dirLabel', /^Kiri$/);
      await page.keyboard.up('ArrowLeft');
      await page.keyboard.down('s'); await waitText(page, '#dirLabel', /^Mundur$/);
      await page.keyboard.up('s');
      await waitText(page, '#dirLabel', /^Berhenti$/);
      await sleep(400);
      const k = (await sent(page)).filter((l) => l.startsWith('DRV'));
      assert.ok(k.some((l) => l === 'DRV 71 71') || k.some((l) => l === 'DRV 70 71') || k.some((l) => l === 'DRV 71 70'), `diagonal harus dinormalisasi, dapat ${[...new Set(k)]}`);
      assert.ok(k.includes('DRV -100 0') && k.includes('DRV 0 -100'));
      assert.equal(k[k.length - 1], 'DRV 0 0');
    });
  });

  test(`${robot} demo: kontrol terhenti saat tab kehilangan fokus / dilepas di luar joystick`, async () => {
    await run(robot, {}, async ({ page }) => {
      await setManual(page);
      await spySend(page, robot);
      const { cx, cy, r } = await joystickCenter(page);
      // lepas tombol mouse jauh di luar joystick: pointer capture harus tetap melepas
      await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx, cy - r);
      await waitText(page, '#dirLabel', /^Maju$/);
      await page.mouse.move(cx + 400, cy + 200); await page.mouse.up();
      await waitText(page, '#dirLabel', /^Berhenti$/);
      // jendela kehilangan fokus saat tombol ditahan
      await page.keyboard.down('w'); await waitText(page, '#dirLabel', /^Maju$/);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await waitText(page, '#dirLabel', /^Berhenti$/);
      await page.keyboard.up('w');
      const last = (await sent(page)).filter((l) => l.startsWith('DRV')).pop();
      assert.equal(last, 'DRV 0 0');
    });
  });

  test(`${robot} demo: tombol STOP dan tombol Spasi menghentikan robot & masuk manual`, async () => {
    await run(robot, {}, async ({ page }) => {
      await spySend(page, robot);
      await page.click('#btnEstop');
      await waitMode(page, 'M');
      assert.ok((await sent(page)).includes('STOP'));
      await waitLog(page, /Berhenti darurat/);
      assert.match(await text(page, '.toast'), /BERHENTI DARURAT/);

      await page.click('#btnAuto'); await waitMode(page, 'A');
      await clearSent(page);
      await page.locator('body').click({ position: { x: 5, y: 400 } });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.keyboard.press('Space');
      await waitMode(page, 'M');
      assert.ok((await sent(page)).includes('STOP'), 'Spasi harus mengirim STOP');
      const y = await page.evaluate(() => window.scrollY);
      assert.equal(y, 0, 'Spasi tidak boleh menggulung halaman');
    });
  });

  test(`${robot} demo: mengetik di pengaturan tidak menggerakkan robot atau memicu STOP`, async () => {
    await run(robot, {}, async ({ page }) => {
      await setManual(page);
      await spySend(page, robot);
      await page.click('#btnSettings');
      await page.click('label[for="modeWs"]');
      await page.fill('#fHost', '');
      await page.locator('#fHost').press('w');
      await page.locator('#fHost').type('wasd robot ');
      await page.keyboard.press('Space');
      await sleep(300);
      const s = await sent(page);
      assert.deepEqual(s.filter((l) => l.startsWith('DRV') || l === 'STOP'), [], 'tidak boleh ada DRV/STOP dari ketikan');
      assert.equal(await page.locator('#fHost').inputValue(), 'wwasd robot  ', 'semua ketikan (termasuk Spasi) masuk ke isian');
      await page.click('#btnCancel');
    });
  });

  test(`${robot} demo: slider batas kecepatan mengirim SPD dan tersimpan setelah reload`, async () => {
    await run(robot, {}, async ({ page }) => {
      await spySend(page, robot);
      await page.locator('#speedCap').fill('220');
      await sleep(400);
      assert.ok((await sent(page)).includes('SPD 220'));
      assert.equal(await page.evaluate((r) => window[r].link.sim.cap, robot), 220);
      assert.equal(await text(page, '#speedCapValue'), '220');
      await page.reload();
      await waitText(page, '#connText', /^Demo$/);
      assert.equal(await page.locator('#speedCap').inputValue(), '220');
      await page.waitForFunction((r) => window[r].link.sim && window[r].link.sim.cap === 220, robot, { timeout: 4000 });
    });
  });

  test(`${robot} demo: dialog pengaturan memvalidasi isian dan bisa dibatalkan`, async () => {
    await run(robot, {}, async ({ page }) => {
      await page.click('#btnSettings');
      assert.equal(await page.locator('dialog.settings').evaluate((d) => d.open), true);
      // WebSocket: alamat salah
      await page.click('label[for="modeWs"]');
      await page.fill('#fHost', 'alamat salah!!');
      await page.click('button[type="submit"]');
      assert.match(await text(page, '#errHost'), /Alamat tidak valid/);
      assert.equal(await attr(page, '#fHost', 'aria-invalid'), 'true');
      assert.equal(await page.locator('dialog.settings').evaluate((d) => d.open), true, 'dialog tetap terbuka kalau ada kesalahan');
      // MQTT: url & prefix salah
      await page.click('label[for="modeMqtt"]');
      await page.fill('#fMqttUrl', 'http://salah');
      await page.fill('#fMqttPrefix', 'a b#');
      await page.click('button[type="submit"]');
      assert.match(await text(page, '#errMqttUrl'), /ws:\/\/ atau wss:\/\//);
      assert.match(await text(page, '#errMqttPrefix'), /Hanya huruf/);
      // kamera salah
      await page.fill('#fCam', 'ftp://x');
      await page.click('button[type="submit"]');
      assert.match(await text(page, '#errCam'), /tidak valid/);
      // batal: tidak ada yang berubah
      await page.click('#btnCancel');
      assert.equal(await page.locator('dialog.settings').evaluate((d) => d.open), false);
      assert.equal(await attr(page, 'body', 'data-link-mode'), 'demo');
      // Esc juga menutup
      await page.click('#btnSettings');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog.settings').evaluate((d) => d.open), false);
    });
  });

  test(`${robot} demo: log aktivitas (tersimpan, ekspor CSV, bersihkan)`, async () => {
    await run(robot, {}, async ({ page }) => {
      await page.click('#btnAuto'); await waitMode(page, 'A');
      await page.click('#btnManual'); await waitMode(page, 'M');
      const logs = await logTexts(page);
      assert.ok(logs.some((t) => /Dashboard dibuka/.test(t)));
      assert.ok(logs.some((t) => /Mode demo aktif/.test(t)));
      assert.ok(logs.some((t) => /Mode diubah ke Manual/.test(t)));
      await sleep(600);                                        // penyimpanan di-debounce
      await page.reload();
      await waitText(page, '#connText', /^Demo$/);
      assert.ok((await logTexts(page)).filter((t) => /Dashboard dibuka/.test(t)).length >= 2, 'log lama harus bertahan setelah reload');

      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnLogExport')]);
      assert.match(dl.suggestedFilename(), new RegExp(`^${robot}-log-\\d{8}-\\d{6}\\.csv$`));
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      assert.match(csv.split('\n')[0], /^waktu,level,kejadian$/);
      assert.ok(csv.split('\n').length >= 4);

      await page.click('#btnLogClear');
      assert.match(await text(page, '#logList'), /Belum ada aktivitas/);
      await sleep(600);
      await page.reload();
      await waitText(page, '#connText', /^Demo$/);
      assert.ok(!(await logTexts(page)).some((t) => /Mode diubah/.test(t)), 'setelah dibersihkan, log lama tidak kembali');
    });
  });

  test(`${robot} demo: grafik (data, tooltip, tabel, CSV, keyboard)`, async () => {
    await run(robot, {}, async ({ page }) => {
      await sleep(3200);
      const canvas = page.locator('#chartMount canvas').first();
      assert.equal(await canvas.isVisible(), true);
      const box = await canvas.boundingBox();
      assert.ok(box.width > 200 && box.height > 100);
      const hasInk = await canvas.evaluate((c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let colored = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (Math.abs(d[i] - d[i + 2]) > 40)) colored++;
        return colored;
      });
      assert.ok(hasInk > 30, 'grafik harus menggambar garis berwarna');

      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      await page.waitForSelector('.chart-tip:not([hidden])');
      const tip = await text(page, '.chart-tip');
      assert.match(tip, /\d\d:\d\d:\d\d/);
      assert.ok((tip.match(/\d/g) || []).length > 6, 'tooltip memuat nilai tiap sensor');
      await page.mouse.move(5, 5);
      await page.waitForSelector('.chart-tip', { state: 'hidden' });

      await canvas.focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForSelector('.chart-tip:not([hidden])');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.chart-tip', { state: 'hidden' });

      await page.click('#btnTable');
      await page.waitForSelector('.chart-table tbody tr');
      assert.ok((await page.locator('.chart-table tbody tr').count()) >= 3);
      assert.equal(await canvas.isVisible(), false);
      await page.click('#btnTable');
      assert.equal(await canvas.isVisible(), true);

      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnCsv')]);
      const csv = fs.readFileSync(await dl.path(), 'utf8').split('\n');
      assert.match(csv[0], /^waktu,/);
      assert.ok(csv.length >= 4);
      await page.click('#win300');
      assert.equal(await attr(page, '#win300', 'aria-pressed'), 'true');
    });
  });

  test(`${robot} demo: kamera simulasi (snapshot, lampu)`, async () => {
    await run(robot, {}, async ({ page }) => {
      await waitAttr(page, '#camViewport', 'data-state', 'live');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-cam="snap"]')]);
      assert.match(dl.suggestedFilename(), /^snapshot-\d{8}-\d{6}\.png$/);
      assert.ok(fs.statSync(await dl.path()).size > 1000, 'file snapshot harus berisi gambar');
      await page.click('[data-cam="lamp"]');
      assert.equal(await attr(page, '[data-cam="lamp"]', 'aria-pressed'), 'true');
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Lampu kamera menyala/.test(t.textContent)));
    });
  });
}

// =====================================================================
//  FireGuard — perilaku khusus (demo)
// =====================================================================
test('fireguard demo: api -> banner, alarm, pompa otomatis, log; padam -> kembali normal', async () => {
  await run('fireguard', {}, async ({ page }) => {
    const flame = page.locator('#flameList .sensor-card').first();
    assert.equal(await page.locator('#flameList .sensor-card').count(), 2, 'bawaan: 2 sensor api (Kiri, Kanan)');
    assert.equal(await page.locator('#gasList .sensor-card').count(), 1);
    await waitAttr(page, '#flameList .sensor-card', 'data-status', 'ok');
    assert.match(await text(page, '#flameList .sensor-card .sensor-label'), /Sensor Kiri/);

    await flame.click();                       // waspada
    await waitAttr(page, '#flameList .sensor-card', 'data-status', 'warn');
    assert.equal(await page.locator('#alertStack .alert-banner').count(), 0, 'waspada belum membunyikan alarm');
    await waitText(page, '#robotState', /Mengarah ke api|Mendekati api/);
    await flame.click();                       // bahaya
    await waitAttr(page, '#flameList .sensor-card', 'data-status', 'danger');
    await page.waitForSelector('#alertStack .alert-banner[data-level="danger"]');
    assert.match(await text(page, '#alertStack .alert-banner'), /API TERDETEKSI — Sektor Kiri · Pompa otomatis AKTIF memadamkan/);
    assert.equal(await attr(page, '#pumpBox', 'data-status'), 'danger');
    assert.equal(await text(page, '#pumpText'), 'AKTIF MEMADAMKAN');
    assert.match(await page.title(), /^\(!\)/, 'judul tab berubah saat alarm');
    await waitLog(page, /Api terdeteksi — sektor Kiri/);
    await waitLog(page, /Pompa aktif otomatis/);
    const ang = await page.locator('#nozAngle').innerText();
    assert.match(ang, /°$/);

    await flame.click();                       // kembali aman
    await waitAttr(page, '#flameList .sensor-card', 'data-status', 'ok', 4000);
    await waitLog(page, /Api tidak terdeteksi lagi/);
    await page.waitForFunction(() => document.getElementById('pumpText').textContent !== 'AKTIF MEMADAMKAN', null, { timeout: 7000 });
    await page.waitForFunction(() => !document.querySelector('#alertStack .alert-banner'), null, { timeout: 3000 });
    assert.doesNotMatch(await page.title(), /^\(!\)/);
  });
});

test('fireguard demo: sensor gas pemanasan lalu normal, lalu waspada & bahaya', async () => {
  await run('fireguard', {}, async ({ page }) => {
    const gas = page.locator('#gasList .sensor-card').first();
    assert.match(await text(page, '#gasList .sensor-status'), /pemanasan|normal/i);
    await page.waitForFunction(() => /^Normal$/.test(document.querySelector('#gasList .sensor-status').textContent), null, { timeout: 8000 });
    assert.equal(await page.locator('#sensorNote').isVisible(), false);
    await gas.click();
    await waitAttr(page, '#gasList .sensor-card', 'data-status', 'warn');
    await page.waitForSelector('#alertStack .alert-banner[data-level="warn"]');
    await gas.click();
    await waitAttr(page, '#gasList .sensor-card', 'data-status', 'danger');
    await page.waitForSelector('#alertStack .alert-banner[data-level="danger"]');
    assert.match(await text(page, '#alertStack .alert-banner[data-level="danger"]'), /KADAR GAS BERBAHAYA/);
    await waitLog(page, /Kadar gas BERBAHAYA/);
    await gas.click();
    await waitAttr(page, '#gasList .sensor-card', 'data-status', 'ok');
    await waitLog(page, /Kadar gas kembali normal/);
  });
});

test('fireguard demo: pompa tekan-tahan dan arah nozzle (manual)', async () => {
  await run('fireguard', {}, async ({ page }) => {
    assert.equal(await page.locator('#pumpBtn').isDisabled(), true, 'mode otomatis: tombol pompa nonaktif');
    assert.equal(await page.locator('#nozSlider').isDisabled(), true);
    await setManual(page);
    await spySend(page, 'fireguard');
    assert.equal(await page.locator('#pumpBtn').isDisabled(), false);
    assert.match(await text(page, '#pumpBtn'), /Tahan untuk Menyemprotkan Air/);

    const b = await page.locator('#pumpBtn').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await waitText(page, '#pumpText', /AKTIF \(MANUAL\)/);
    await sleep(900);                                          // tetap menyala karena perintah diperbarui
    assert.equal(await page.evaluate(() => window.fireguard.link.sim.manualPump), true);
    await page.mouse.move(b.x + b.width / 2 + 500, b.y + 300);   // geser keluar dari tombol
    await page.mouse.up();
    await waitText(page, '#pumpText', /STANDBY/, 2000);
    const s = await sent(page);
    assert.ok(s.filter((l) => l === 'PUMP 1').length >= 3, 'PUMP 1 dikirim berulang selama ditahan');
    assert.equal(s[s.length - 1], 'PUMP 0');
    await waitLog(page, /Pompa diaktifkan manual/);

    // keyboard: tahan Spasi/Enter pada tombol
    await page.locator('#pumpBtn').focus();
    await page.keyboard.down('Enter');
    await waitText(page, '#pumpText', /AKTIF \(MANUAL\)/);
    await page.keyboard.up('Enter');
    await waitText(page, '#pumpText', /STANDBY/, 2000);

    await page.locator('#nozSlider').fill('120');
    await sleep(300);
    assert.equal(await page.evaluate(() => window.fireguard.link.sim.nozManual), 120);
    assert.equal(await text(page, '#nozAngle'), '120°');

    // pindah ke otomatis saat pompa ditahan -> pompa berhenti, tombol nonaktif lagi
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await waitText(page, '#pumpText', /AKTIF \(MANUAL\)/);
    await page.evaluate(() => document.getElementById('btnAuto').click());
    await waitMode(page, 'A');
    await waitText(page, '#pumpText', /STANDBY/, 2000);
    await page.mouse.up();
    assert.equal(await page.locator('#pumpBtn').isDisabled(), true);
  });
});

test('fireguard demo: e-stop melepas pompa yang sedang ditahan', async () => {
  await run('fireguard', {}, async ({ page }) => {
    await setManual(page);
    const b = await page.locator('#pumpBtn').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await waitText(page, '#pumpText', /AKTIF \(MANUAL\)/);
    await page.keyboard.press('Space');
    await waitText(page, '#pumpText', /STANDBY/, 2000);
    await page.mouse.up();
  });
});

// =====================================================================
//  EcoBot — perilaku khusus (demo)
// =====================================================================
test('ecobot demo: 5 sensor ultrasonik, level, dan klik simulasi', async () => {
  await run('ecobot', {}, async ({ page }) => {
    assert.equal(await page.locator('#sensorList .sensor-card').count(), 5);
    const labels = await page.$$eval('#sensorList .label-full', (e) => e.map((x) => x.textContent));
    assert.deepEqual(labels, ['Sensor Depan', 'Sensor Belakang', 'Sensor Kiri', 'Sensor Kanan', 'Sensor Capit']);
    await waitText(page, '#sensorList .sensor-card:nth-child(1) .sensor-value', /\d+ cm/);
    const card = page.locator('#sensorList .sensor-card').nth(2);          // Kiri
    await card.click();
    await page.waitForFunction(() => document.querySelectorAll('#sensorList .sensor-card')[2].dataset.status === 'warn');
    assert.match(await text(page, '#sensorList .sensor-card:nth-child(3) .sensor-status'), /terdeteksi/i);
    await card.click();
    await page.waitForFunction(() => document.querySelectorAll('#sensorList .sensor-card')[2].dataset.status === 'danger');
    assert.match(await text(page, '#sensorList .sensor-card:nth-child(3) .sensor-status'), /dekat/i);
    await waitLog(page, /Objek sangat dekat — sensor Kiri/);
    await card.click();
    await page.waitForFunction(() => document.querySelectorAll('#sensorList .sensor-card')[2].dataset.status === 'ok');
  });
});

test('ecobot demo: manual — capit, lengan, dan urutan ambil sampah', async () => {
  await run('ecobot', {}, async ({ page }) => {
    await spySend(page, 'ecobot');
    assert.equal(await page.locator('#clawBtn').isDisabled(), false, 'EcoBot menyala di mode manual');
    assert.match(await text(page, '#clawLabel'), /Tertutup · 25°/);
    assert.match(await text(page, '#armLabel'), /Turun · 10°/);
    assert.equal(await text(page, '#clawBtn'), 'Buka Capit');

    await page.click('#clawBtn');
    await waitText(page, '#clawLabel', /Terbuka · 90°/);
    assert.equal(await text(page, '#clawBtn'), 'Tutup Capit');
    await page.click('#armBtn');
    await waitText(page, '#armLabel', /Naik · 150°/);
    assert.equal(await text(page, '#armBtn'), 'Turunkan Lengan');
    await waitLog(page, /Capit dibuka oleh operator/);
    await waitLog(page, /Lengan dinaikkan oleh operator/);
    const s = await sent(page);
    assert.ok(s.includes('CLAW 0') && s.includes('ARM 1'));
    await page.click('#armBtn'); await page.click('#clawBtn');
    await waitText(page, '#armLabel', /Turun · 10°/);

    // urutan ambil sampah
    const before = parseInt(await text(page, '#pickCount'), 10);
    const bin0 = parseInt(await text(page, '#binLevelValue'), 10);
    await page.click('#pickBtn');
    await waitText(page, '#gripText', /MENGAMBIL SAMPAH/);
    assert.equal(await page.locator('#clawBtn').isDisabled(), true, 'tombol manual terkunci saat urutan jalan');
    assert.equal(await page.locator('#pickBtn').isDisabled(), true);
    await waitLog(page, /Mulai mengambil sampah/);
    await page.waitForFunction((n) => parseInt(document.getElementById('pickCount').textContent, 10) > n, before, { timeout: 9000 });
    await waitLog(page, /Sampah ke-\d+ masuk ke penampung/);
    const bin1 = parseInt(await text(page, '#binLevelValue'), 10);
    assert.ok(bin1 > bin0, `kapasitas bin harus naik (${bin0}% -> ${bin1}%)`);
    await waitText(page, '#gripText', /KENDALI MANUAL/, 3000);
  });
});

test('ecobot demo: otomatis — objek di jangkauan diambil sendiri; bin penuh menghentikan & memunculkan banner', async () => {
  await run('ecobot', {}, async ({ page }) => {
    await page.click('#btnAuto'); await waitMode(page, 'A');
    await waitText(page, '#robotState', /Menjelajah/);
    const cards = page.locator('#sensorList .sensor-card');
    await cards.nth(0).click(); await cards.nth(0).click();              // Depan -> jangkauan
    await waitText(page, '#gripText', /MENGAMBIL SAMPAH/, 3000);
    await page.waitForFunction(() => document.getElementById('pickCount').textContent === '1', null, { timeout: 9000 });
    await waitText(page, '#robotState', /Menjelajah/, 4000);

    // bin hampir penuh
    await page.evaluate(() => { window.ecobot.link.sim.binPct = 97; });
    await page.waitForSelector('#alertStack .alert-banner[data-level="warn"]');
    assert.match(await text(page, '#alertStack .alert-banner'), /KAPASITAS BIN HAMPIR PENUH — 97% · Segera kembali ke titik pembuangan \(pemungutan otomatis dihentikan\)/);
    await waitText(page, '#gripText', /BIN PENUH/);
    assert.equal(await attr(page, '#gripBox', 'data-status'), 'danger');
    assert.equal(await text(page, '#pickBtn'), 'Bin penuh');
    assert.equal(await page.locator('#pickBtn').isDisabled(), true);
    await waitLog(page, /Bin penuh \(97%\)/);
    assert.match(await attr(page, '#binLevelValue', 'style') || '', /danger/);

    await page.click('#binResetDemo');
    await page.waitForFunction(() => !document.querySelector('#alertStack .alert-banner'), null, { timeout: 3000 });
    await waitLog(page, /Bin sudah dikosongkan/);
    await waitText(page, '#robotState', /Menjelajah/, 3000);
  });
});

// =====================================================================
//  Kondisi offline & penyimpanan
// =====================================================================
for (const robot of ROBOTS) {
  test(`${robot}: mode WebSocket tanpa alamat = "Belum dikonfigurasi", tanpa satu pun permintaan jaringan/error`, async () => {
    await run(robot, { cfg: { mode: 'ws', host: '' }, label: 'belum dikonfigurasi' }, async ({ page }) => {
      await waitText(page, '#connText', /Belum dikonfigurasi/);
      await sleep(1500);
      assert.equal(await attr(page, '#camViewport', 'data-state'), 'none');
    });
  });

  test(`${robot}: robot tidak terjangkau -> UI offline yang jujur (data "Offline", kontrol mati), bukan data palsu`, async () => {
    await run(robot, { cfg: { mode: 'ws', host: '127.0.0.1:1' }, allow: NET_NOISE, skipClean: false, label: 'offline' }, async ({ page }) => {
      await waitText(page, '#connText', /Menyambung/);
      assert.equal(await attr(page, '#connDot', 'data-state'), 'connecting');
      await waitText(page, '#dirLabel', /Tidak terhubung/);
      assert.equal(await page.locator('#joyBase').evaluate((e) => e.classList.contains('disabled')), true);
      const statuses = await page.$$eval('.sensor-card', (els) => els.map((e) => e.dataset.status));
      assert.ok(statuses.length >= 3 && statuses.every((s) => s === 'off'), `semua sensor harus off, dapat ${statuses}`);
      assert.equal(await text(page, '#batText'), '—');
      assert.equal(await attr(page, '#btnAuto', 'aria-pressed'), 'false');
      assert.equal(await attr(page, '#btnManual', 'aria-pressed'), 'false');

      await page.click('#btnManual');
      assert.match(await text(page, '.toast'), /Belum tersambung ke robot/);
      await page.click('#btnEstop');
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Perintah berhenti TIDAK terkirim/.test(t.textContent)));
      const allBtns = await page.$$eval('#cardActuator .act-btn', (els) => els.map((e) => e.disabled));
      assert.ok(allBtns.length > 0 && allBtns.every(Boolean), 'tombol aktuator mati saat offline');
    });
  });

  test(`${robot}: tetap jalan tanpa localStorage (mode private / diblokir)`, async () => {
    await run(robot, { blockStorage: true, label: 'tanpa localStorage' }, async ({ page }) => {
      await waitText(page, '#connText', /^Demo$/);
      await page.click('#btnManual'); await waitMode(page, 'M');
      await page.locator('#speedCap').fill('200');
      await page.click('#btnSettings'); await page.click('#btnCancel');
      await sleep(800);
    });
  });

  test(`${robot}: dibuka lewat http:// juga bersih (bukan hanya file://)`, async () => {
    const server = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
      await run(robot, { url: `http://127.0.0.1:${port}/${robot}/index.html`, label: 'http' }, async ({ page }) => {
        await waitText(page, '#connText', /^Demo$/);
        await sleep(1500);
      });
    } finally { server.close(); }
  });
}

test('halaman pilihan robot: tautan ke kedua dashboard berfungsi dan bersih dari error', async () => {
  const { ctx, page, watch } = await openDashboard(browser, 'fireguard', { url: pathToUrl('index.html') });
  try {
    await page.waitForSelector('.robot-card.fire');
    await page.click('.robot-card.fire');
    await page.waitForURL(/fireguard\/index\.html$/);
    await page.click('a[aria-label="Kembali ke pilihan robot"]');
    await page.waitForURL(/\/index\.html$/);
    await page.click('.robot-card.eco');
    await page.waitForURL(/ecobot\/index\.html$/);
    await waitText(page, '#connText', /^Demo$/);
    watch.assertClean(assert, 'halaman pilihan');
  } finally { await ctx.close(); }
});
function pathToUrl(rel) { return new URL('file://' + path.join(ROOT, rel)).href; }


// =====================================================================
//  Sentuh (HP) dan alarm tanpa interaksi
// =====================================================================
for (const robot of ROBOTS) {
  test(`${robot} HP: joystick dan tombol bisa dipakai dengan sentuhan; lepas jari = berhenti`, async () => {
    await run(robot, { viewport: { width: 390, height: 844 }, touch: true, label: 'touch' }, async ({ page }) => {
      await setManual(page);
      await spySend(page, robot);
      const client = await page.context().newCDPSession(page);
      const touch = (type, x, y) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      await page.locator('#joyBase').scrollIntoViewIfNeeded();
      const { cx, cy, r } = await joystickCenter(page);
      const y0 = await page.evaluate(() => window.scrollY);
      await touch('touchStart', cx, cy);
      await touch('touchMove', cx, cy - r);
      await waitText(page, '#dirLabel', /^Maju$/);
      await touch('touchMove', cx - r, cy - r);
      await waitText(page, '#dirLabel', /^Maju-Kiri$/);
      await sleep(400);
      assert.equal(await page.evaluate(() => window.scrollY), y0, 'menggeser joystick tidak boleh menggulung halaman');
      await touch('touchEnd');
      await waitText(page, '#dirLabel', /^Berhenti$/);
      await sleep(300);
      const drv = (await sent(page)).filter((l) => l.startsWith('DRV'));
      assert.ok(drv.length >= 4 && drv[drv.length - 1] === 'DRV 0 0');
      assert.ok(drv.some((l) => /^DRV -?\d+ \d+$/.test(l) && l.startsWith('DRV -71')) || drv.some((l) => l.startsWith('DRV -7')), `diagonal kiri-depan, dapat ${[...new Set(drv)]}`);

      if (robot === 'fireguard') {
        await page.locator('#pumpBtn').scrollIntoViewIfNeeded();
        const b = await page.locator('#pumpBtn').boundingBox();
        await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2);
        await waitText(page, '#pumpText', /AKTIF \(MANUAL\)/);
        await touch('touchMove', b.x + b.width / 2, b.y - 300);        // jari bergeser keluar tombol
        await sleep(300);
        await touch('touchEnd');
        await waitText(page, '#pumpText', /STANDBY/, 2000);
      }
    });
  });
}

test('alarm: api dilaporkan sebelum ada interaksi -> banner muncul, AudioContext baru dibuat setelah gestur pertama', async () => {
  // Chrome biasa mencatat peringatan kalau AudioContext dibuat sebelum ada klik/tombol. Chromium headless tidak
  // menerapkan kebijakan itu, jadi yang diperiksa di sini adalah perilakunya: konteks tidak boleh dibuat dulu.
  const p = ports();
  const srv = mock.start({ robot: 'fireguard', ws: p.ws, cam: p.cam, mqttWs: 0, prefix: 'kopak', quiet: true });
  srv.sim.force('flame', 0, 2);
  try {
    await run('fireguard', { cfg: mkCfg('fireguard', p), allow: NET_NOISE, label: 'alarm tanpa gestur' }, async ({ page }) => {
      await page.waitForSelector('#alertStack .alert-banner[data-level="danger"]', { timeout: 8000 });
      assert.match(await page.title(), /^\(!\)/);
      await sleep(2200);                                   // beberapa siklus bunyi
      assert.equal(await page.evaluate(() => window.fireguard.alarm._ctx), null, 'belum ada gestur: AudioContext tidak boleh dibuat');
      await page.mouse.click(5, 5);
      assert.equal(await page.evaluate(() => window.fireguard.alarm._ctx !== null), true, 'setelah gestur pertama, konteks dibuat');
      await sleep(1800);                                   // bunyi berjalan tanpa error
    });
  } finally { await srv.close(); }
});

// =====================================================================
//  Koneksi WebSocket ke robot palsu
// =====================================================================
function mkCfg(robot, p, extra) {
  return Object.assign({ mode: 'ws', host: `127.0.0.1:${p.ws}`, camera: '', mqttUrl: '', mqttPrefix: 'kopak' }, extra || {});
}

for (const robot of ROBOTS) {
  test(`${robot} WebSocket: tersambung, data nyata tampil, perintah sampai, sambung ulang otomatis, status "belum merespons"`, async () => {
    const p = ports();
    let srv = mock.start({ robot, ws: p.ws, cam: p.cam, mqttWs: 0, prefix: 'kopak', quiet: true });
    try {
      await run(robot, { cfg: mkCfg(robot, p), allow: NET_NOISE, label: 'ws' }, async ({ page }) => {
        await waitText(page, '#connText', /^Terhubung$/, 6000);
        assert.equal(await attr(page, '#connDot', 'data-state'), 'online');
        assert.equal(await page.locator('#demoChip').isVisible(), false);
        assert.match(await text(page, '#sysConn'), /WebSocket · tersambung/);
        assert.equal(await text(page, '#sysFw'), 'v1.0.0-sim');   // versi firmware Uno (dari pesan info)
        assert.equal(await text(page, '#sysIp'), '127.0.0.1');
        await page.waitForFunction(() => /^\d+ ms$/.test(document.getElementById('sysRtt').textContent), null, { timeout: 4000 });
        assert.equal(await text(page, '#sysRssi'), '-48 dBm');
        assert.equal(await attr(page, '#camViewport', 'data-state'), 'none', 'kamera belum diatur');
        assert.ok(srv.received.some((r) => r.line === 'SPD 160'), 'dashboard menyelaraskan batas kecepatan');
        assert.ok(srv.received.some((r) => r.line === 'INFO') && srv.received.some((r) => r.line === 'GET'));

        // mode & gerak (bolak-balik supaya kedua arah terkirim, apa pun mode awal robotnya)
        await page.click('#btnAuto'); await waitMode(page, 'A');
        await page.click('#btnManual'); await waitMode(page, 'M');
        if (robot === 'ecobot') assert.ok(srv.received.some((r) => r.line === 'MODE A'), 'perintah MODE A sampai ke robot');   // FireGuard sudah otomatis sejak menyala
        assert.ok(srv.received.some((r) => r.line === 'MODE M'), 'perintah MODE M sampai ke robot');
        await page.waitForFunction(() => !document.getElementById('joyBase').classList.contains('disabled'));
        srv.received.length = 0;
        await page.keyboard.down('w');
        await waitText(page, '#dirLabel', /^Maju$/);
        await sleep(800);
        const speed = parseInt((await text(page, '#speedValue')).split('/')[0], 10);
        assert.ok(speed > 0, 'kecepatan nyata dari robot tampil di meter');
        await page.keyboard.up('w');
        await sleep(500);
        const drv = srv.received.filter((r) => r.line.startsWith('DRV')).map((r) => r.line);
        assert.ok(drv.filter((l) => l === 'DRV 0 100').length >= 6, `DRV dikirim berulang, dapat ${drv.length}`);
        assert.equal(drv[drv.length - 1], 'DRV 0 0');
        await page.waitForFunction((r) => { const m = window[r].tel; return m && m.sp === 0; }, robot, { timeout: 3000 });

        // e-stop
        await page.click('#btnAuto'); await waitMode(page, 'A');
        srv.received.length = 0;
        await page.click('#btnEstop');
        await waitMode(page, 'M');
        assert.ok(srv.received.some((r) => r.line === 'STOP'));

        // data khusus robot
        if (robot === 'fireguard') {
          srv.sim.force('flame', 1, 2);
          await page.waitForSelector('#alertStack .alert-banner[data-level="danger"]');
          assert.match(await text(page, '#alertStack .alert-banner'), /Sektor Kanan/);
          srv.sim.force('flame', 1, 0);
        } else {
          srv.sim.force(3, 1);
          await page.waitForFunction(() => document.querySelectorAll('#sensorList .sensor-card')[3].dataset.status === 'warn');
          srv.sim.force(3, 0);
        }
        // kartu sensor TIDAK bisa diklik untuk simulasi saat terhubung ke robot asli
        assert.equal(await page.locator('.sensor-card.demo-click').count(), 0);

        // robot "diam": ESP hidup, Arduino tidak kirim telemetri
        srv.muteTel = true;
        await waitText(page, '#connText', /Robot belum merespons/, 8000);
        assert.equal(await attr(page, '#connDot', 'data-state'), 'silent');
        assert.equal(await page.locator('#joyBase').evaluate((e) => e.classList.contains('disabled')), true);
        await waitLog(page, /ESP tersambung, tetapi Arduino belum mengirim data/);
        srv.muteTel = false;
        await waitText(page, '#connText', /^Terhubung$/, 4000);

        // server mati -> menyambung ulang -> hidup lagi
        await srv.close();
        await waitText(page, '#connText', /Menyambung/, 5000);
        await waitText(page, '#dirLabel', /Tidak terhubung/);
        await waitLog(page, /Koneksi terputus, mencoba menyambung ulang/);
        srv = mock.start({ robot, ws: p.ws, cam: p.cam, mqttWs: 0, prefix: 'kopak', quiet: true });
        await waitText(page, '#connText', /^Terhubung$/, 16000);
        await waitLog(page, /Tersambung ke robot/);
        assert.ok(srv.received.some((r) => r.line === 'SPD 160'), 'setelah tersambung ulang, batas kecepatan diselaraskan lagi');
      });
    } finally { await srv.close(); }
  });

  test(`${robot} WebSocket: dialog pengaturan menyimpan alamat, bertahan setelah reload, dan bisa kembali ke Demo`, async () => {
    const p = ports();
    const srv = mock.start({ robot, ws: p.ws, cam: p.cam, mqttWs: 0, prefix: 'kopak', quiet: true });
    try {
      await run(robot, { allow: NET_NOISE, label: 'pengaturan' }, async ({ page }) => {
        await waitText(page, '#connText', /^Demo$/);
        await page.click('#btnSettings');
        await page.click('label[for="modeWs"]');
        await page.fill('#fHost', `127.0.0.1:${p.ws}`);
        await page.click('button[type="submit"]');
        assert.equal(await page.locator('dialog.settings').evaluate((d) => d.open), false);
        await waitText(page, '#connText', /^Terhubung$/, 6000);
        assert.equal(await page.locator('#demoChip').isVisible(), false);
        await waitLog(page, /Pengaturan disimpan — mode Langsung/);
        assert.equal(await attr(page, '#camViewport', 'data-state'), 'none');

        await page.reload();
        await waitText(page, '#connText', /^Terhubung$/, 6000);
        await page.click('#btnSettings');
        assert.equal(await page.locator('#fHost').inputValue(), `127.0.0.1:${p.ws}`);
        assert.equal(await page.locator('#modeWs').isChecked(), true);
        await page.click('#btnReset');
        await waitText(page, '#connText', /^Demo$/);
        assert.equal(await page.locator('#demoChip').isVisible(), true);
        await page.reload();
        await waitText(page, '#connText', /^Demo$/);
      });
    } finally { await srv.close(); }
  });
}

// =====================================================================
//  Koneksi MQTT ke robot palsu
// =====================================================================
for (const robot of ROBOTS) {
  test(`${robot} MQTT: tersambung lewat broker, perintah & telemetri mengalir, status offline robot (LWT), sambung ulang`, async () => {
    const p = ports();
    let srv = mock.start({ robot, ws: p.ws, cam: p.cam, mqttWs: p.mqttWs, prefix: 'kelompok7', quiet: true });
    const cfg = mkCfg(robot, p, { mode: 'mqtt', mqttUrl: `ws://127.0.0.1:${p.mqttWs}`, mqttPrefix: 'kelompok7', host: '' });
    try {
      await run(robot, { cfg, allow: NET_NOISE, label: 'mqtt' }, async ({ page }) => {
        await waitText(page, '#connText', /^Terhubung$/, 8000);
        assert.match(await text(page, '#sysConn'), /MQTT · tersambung/);
        await page.waitForFunction(() => /^\d+ ms$/.test(document.getElementById('sysRtt').textContent), null, { timeout: 5000 });
        await waitLog(page, /Tersambung ke robot \(MQTT\)/);
        assert.ok(srv.received.some((r) => r.via === 'mqtt' && r.line === 'SPD 160'));

        await page.click('#btnAuto'); await waitMode(page, 'A');
        await setManual(page);
        srv.received.length = 0;
        await page.keyboard.down('s'); await waitText(page, '#dirLabel', /^Mundur$/);
        await sleep(600);
        await page.keyboard.up('s'); await sleep(400);
        const drv = srv.received.filter((r) => r.line.startsWith('DRV'));
        assert.ok(drv.length >= 5 && drv.every((r) => r.via === 'mqtt'));
        assert.ok(drv.some((r) => r.line === 'DRV 0 -100'));
        assert.equal(drv[drv.length - 1].line, 'DRV 0 0');

        // LWT: bridge hilang dari broker -> "Robot offline"
        srv.aedes.publish({ cmd: 'publish', qos: 0, retain: true, dup: false, topic: `kelompok7/${robot}/status`, payload: Buffer.from('offline') }, () => {});
        await waitText(page, '#connText', /Robot offline/, 4000);
        assert.equal(await attr(page, '#connDot', 'data-state'), 'silent');
        srv.aedes.publish({ cmd: 'publish', qos: 0, retain: true, dup: false, topic: `kelompok7/${robot}/status`, payload: Buffer.from('online') }, () => {});
        await waitText(page, '#connText', /^Terhubung$/, 4000);

        // broker mati lalu hidup lagi
        await srv.close();
        await waitText(page, '#connText', /Menyambung/, 8000);
        srv = mock.start({ robot, ws: p.ws, cam: p.cam, mqttWs: p.mqttWs, prefix: 'kelompok7', quiet: true });
        await waitText(page, '#connText', /^Terhubung$/, 20000);
      });
    } finally { await srv.close(); }
  });

  test(`${robot} MQTT: awalan topik salah -> tidak ada data, dashboard jujur "Robot belum merespons"`, async () => {
    const p = ports();
    const srv = mock.start({ robot, ws: p.ws, cam: p.cam, mqttWs: p.mqttWs, prefix: 'kelompok7', quiet: true });
    const cfg = mkCfg(robot, p, { mode: 'mqtt', mqttUrl: `ws://127.0.0.1:${p.mqttWs}`, mqttPrefix: 'awalan-lain', host: '' });
    try {
      await run(robot, { cfg, allow: NET_NOISE, label: 'mqtt prefix salah' }, async ({ page }) => {
        await waitText(page, '#connText', /Robot belum merespons/, 9000);
        await waitLog(page, /ESP tersambung, tetapi Arduino belum mengirim data/);
        const statuses = await page.$$eval('.sensor-card', (els) => els.map((e) => e.dataset.status));
        assert.ok(statuses.every((s) => s === 'off'));
      });
    } finally { await srv.close(); }
  });
}

// =====================================================================
//  Kamera (stream MJPEG dari server palsu)
// =====================================================================
for (const robot of ROBOTS) {
  test(`${robot} kamera: stream live, status/FPS, lampu, resolusi, snapshot; macet & putus terdeteksi lalu pulih sendiri`, async () => {
    const p = ports();
    const srv = mock.start({ robot, ws: p.ws, cam: p.cam, mqttWs: 0, prefix: 'kopak', quiet: true });
    const cfg = mkCfg(robot, p, { camera: `127.0.0.1:${p.cam}` });
    try {
      await run(robot, { cfg, allow: NET_NOISE, label: 'kamera' }, async ({ page }) => {
        await waitAttr(page, '#camViewport', 'data-state', 'live', 8000);
        assert.equal(await text(page, '[data-cam="live-text"]'), 'LIVE');
        await waitText(page, '[data-cam="res"]', /320×240 · \d+ FPS/, 7000);
        assert.equal(await page.locator('[data-cam="quality"]').isVisible(), true);
        assert.ok(srv.cam.statusHits >= 1, 'dashboard memantau /status kamera');

        await page.click('[data-cam="lamp"]');
        await page.waitForFunction(() => true);
        await sleep(300);
        assert.equal(srv.cam.led, 1);
        await page.click('[data-cam="lamp"]');
        await sleep(300);
        assert.equal(srv.cam.led, 0);

        await page.selectOption('[data-cam="quality"]', 'svga');
        await sleep(400);
        assert.equal(srv.cam.size, 'svga');
        await sleep(1800);                                        // stream dimulai ulang setelah ganti resolusi
        await waitAttr(page, '#camViewport', 'data-state', 'live', 6000);

        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-cam="snap"]')]);
        assert.match(dl.suggestedFilename(), /^snapshot-.*\.png$/);
        assert.ok(fs.statSync(await dl.path()).size > 500);

        // stream macet (server hidup tapi frame berhenti)
        srv.cam.stall = true;
        await waitAttr(page, '#camViewport', 'data-state', 'error', 14000);
        assert.match(await text(page, '[data-cam="ph-sub"]'), /Video macet/);
        // coba lagi, tapi kamera masih membisu: jangan menggantung di "Menyambung", harus menyerah dan menjelaskan
        await waitText(page, '[data-cam="ph-sub"]', /tidak mengirim gambar.*penonton lain/, 20000);
        srv.cam.stall = false;
        await waitAttr(page, '#camViewport', 'data-state', 'live', 15000);

        // kamera mati total
        srv.cam.down = true;
        await waitAttr(page, '#camViewport', 'data-state', 'error', 12000);
        assert.equal(await text(page, '[data-cam="live-text"]'), 'TERPUTUS');
        srv.cam.down = false;
        await waitAttr(page, '#camViewport', 'data-state', 'live', 25000);
      });
    } finally { await srv.close(); }
  });
}
