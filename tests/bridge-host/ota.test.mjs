// Uji alur OTA esp_bridge.ino di PC: Push OTA, Pull OTA, Safe OTA (masa percobaan + rollback),
// tanda tangan, dan syarat "robot harus diam". Sketch asli dijalankan di atas ESP32 palsu
// (shim/), setiap boot satu proses, flash dan NVS disimpan di folder sementara.
// Skenario mengikuti checkpoint praktikum OTA (C1.x Push, C2.x Pull, C3.x Safe).
//
// Jalankan:  node --test tests/bridge-host/ota.test.mjs
// Butuh: g++, python3, libmbedtls-dev (apt install libmbedtls-dev). ArduinoJson diunduh otomatis.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildVariant, findArduinoJson, Device, keygen, tlsNeedle, mbedtlsAvailable, killAll, TEST_SECRETS, buildDir } from './sim.mjs';

const canRun = mbedtlsAvailable();
const skip = canRun ? false : 'libmbedtls-dev belum terpasang (sudo apt install libmbedtls-dev)';

const bins = {};
const devices = [];
let keyDir;

const V = (v) => `"${v}"`;
const HTTPS_SECRETS = TEST_SECRETS.replace('"http://sim.local:8000"', '"https://sim.local"');
const ECO_SECRETS = `${TEST_SECRETS}#define ROBOT_NAME    "ecobot"\n`;
const ECO = { SIM_UNO: 'ecobot' };          // Uno palsu berperan sebagai EcoBot 2.2.0

before(async () => {
  if (!canRun) return;
  fs.mkdirSync(buildDir, { recursive: true });
  const ajDir = await findArduinoJson();
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-key-'));
  keygen(path.join(keyDir, 'priv.pem'), path.join(keyDir, 'ota_pubkey.h'));
  const pubkey = fs.readFileSync(path.join(keyDir, 'ota_pubkey.h'), 'utf8');

  const specs = {
    v110: { set: { FW_VERSION: V('1.1.0') } },
    v120: { set: { FW_VERSION: V('1.2.0') } },
    v130f1: { set: { FW_VERSION: V('1.3.0'), FAULT_MODE: '1' } },
    v131f2: { set: { FW_VERSION: V('1.3.1'), FAULT_MODE: '2' } },
    v132f3: { set: { FW_VERSION: V('1.3.2'), FAULT_MODE: '3' } },
    v140: { set: { FW_VERSION: V('1.4.0') } },
    v141: { set: { FW_VERSION: V('1.4.1') } },
    bl120: { set: { FW_VERSION: V('1.2.0'), ROLLBACK_BOOTLOADER: '1' } },
    bl130f2: { set: { FW_VERSION: V('1.3.0'), ROLLBACK_BOOTLOADER: '1', FAULT_MODE: '2' } },
    sig110: { set: { FW_VERSION: V('1.1.0') }, pubkey },
    sig120: { set: { FW_VERSION: V('1.2.0') }, pubkey },
    par120: { set: { FW_VERSION: V('1.2.0'), PARAM_API_WASPADA: '650', PARAM_API_BAHAYA: '350' } },
    auto110: { set: { FW_VERSION: V('1.1.0'), OTA_PASANG_OTOMATIS: '1' } },
    h110: { set: { FW_VERSION: V('1.1.0') }, secrets: HTTPS_SECRETS },
    h110bad: { set: { FW_VERSION: V('1.1.0'), UJI_ROOT_CA_SALAH: '1' }, secrets: HTTPS_SECRETS },
    eco110: { set: { FW_VERSION: V('1.1.0') }, secrets: ECO_SECRETS },
    eco120: { set: { FW_VERSION: V('1.2.0') }, secrets: ECO_SECRETS },
    eco121: { set: { FW_VERSION: V('1.2.1') }, secrets: ECO_SECRETS },
    ecopar130: { set: { FW_VERSION: V('1.3.0'), PARAM_JARAK_DEPAN: '30', PARAM_JARAK_SERONG: '25', PARAM_PWM_MAJU: '120' }, secrets: ECO_SECRETS },
  };
  const names = Object.keys(specs);
  for (let i = 0; i < names.length; i += 4) {
    await Promise.all(names.slice(i, i + 4).map(async (n) => { bins[n] = await buildVariant(n, { ...specs[n], ajDir }); }));
  }
});

after(() => {
  killAll();
  for (const d of devices) d.cleanup();
  if (keyDir) fs.rmSync(keyDir, { recursive: true, force: true });
});

afterEach(() => killAll());

function device(name, env) {
  const d = new Device(name, bins, env);
  devices.push(d);
  return d;
}

/** perangkat yang baru di-upload lewat USB dan sudah menyala sekali */
async function freshDevice(name, variant, version, env) {
  const d = device(name, env);
  d.usbFlash(variant, version);
  const s = d.boot();
  await s.run('INIT', 'T 500');
  await s.close();
  return d;
}

const otaWith = (s, st) => s.ota().filter((o) => o.st === st);

// ------------------------------------------------------------------
//  Pull OTA (Pertemuan 2) + persetujuan + syarat robot diam
// ------------------------------------------------------------------
test('Pull OTA: update ditemukan, menunggu tombol Pasang, ditolak saat robot bergerak, lalu terpasang dan VALID', { skip }, async () => {
  const dev = device('pull');
  dev.usbFlash('v110', '1.1.0');
  dev.publish('v110', '1.1.0', ['--channel', 'both']);

  let s = dev.boot();
  await s.run('INIT', 'T 2000', 'WSC', 'T 50');
  assert.equal(s.uno()[0], 'STOP', 'perintah pertama ke Uno saat ESP menyala harus STOP (safe state)');
  const info = s.ws('bridge')[0];
  assert.equal(info.fw, '1.1.0');
  assert.equal(info.ota.pull, 1);
  assert.equal(info.ota.push, 1);

  dev.publish('v120', '1.2.0', ['--notes', 'perbaikan ambang']);
  await s.run('WS OTA CHECK', 'T 100');
  const avail = s.lastOta();
  assert.equal(avail.st, 'available');
  assert.equal(avail.ver, '1.2.0');
  assert.equal(avail.notes, 'perbaikan ambang');
  assert.equal(s.restarted, false, 'cek saja tidak boleh memasang apa pun (menunggu persetujuan)');

  // robot sedang mode Otomatis: update ditolak
  await s.run('UNO mode A', 'T 400', 'WS OTA INSTALL', 'T 200');
  assert.equal(s.lastOta().st, 'blocked');
  assert.match(s.lastOta().msg, /Otomatis/);
  // roda masih berputar: ditolak juga
  await s.run('UNO mode M', 'UNO sp 140', 'T 400', 'WS OTA INSTALL', 'T 200');
  assert.match(s.lastOta().msg, /Roda masih berputar/);
  assert.equal(s.restarted, false);

  await s.run('WS STOP', 'T 400', 'WS OTA INSTALL', 'T 1500');
  assert.ok(s.restarted, 'setelah robot diam, update dipasang lalu ESP restart');
  const iStop = s.lines.lastIndexOf('UNO STOP');
  const iGet = s.lines.findIndex((l) => /HTTP GET .*fireguard-bridge-1\.2\.0\.bin/.test(l));
  assert.ok(iStop >= 0 && iGet > iStop, 'robot dihentikan (STOP) sebelum firmware diunduh');
  assert.ok(otaWith(s, 'downloading').length > 0);
  assert.equal(otaWith(s, 'rebooting').at(-1).ver, '1.2.0');

  // boot ke firmware baru: masa percobaan
  s = dev.boot();
  await s.run('INIT', 'T 1000', 'WSC', 'T 20', 'WS DRV 0 60', 'T 50');
  assert.equal(dev.boots.at(-1), 'v120');
  assert.match(s.log(), /TRIAL BOOT v1\.2\.0, percobaan 1\/3/);
  assert.ok(!s.uno().includes('DRV 0 60'), 'perintah gerak ditolak selama masa percobaan');
  assert.ok(s.ota().some((o) => /ditolak/.test(o.msg || '')));
  await s.run('T 8000');
  assert.match(s.log(), /\[Health\] LULUS/);
  assert.match(s.log(), /v1\.2\.0 dikonfirmasi VALID/);
  assert.equal(s.lastOta().st, 'valid');
  await s.run('WS DRV 0 60', 'T 50');
  assert.ok(s.uno().includes('DRV 0 60'), 'setelah VALID robot bisa dikemudikan lagi');
  await s.close();

  const st = dev.nvsState();
  assert.equal(st.good, '1.2.0');
  assert.equal(st.pending, '');
  assert.equal(st.lastSt, 'valid');
});

test('Pull OTA ditolak: versi turun, MD5 salah, board salah, file diganti, lupa naik versi, Uno terlalu lama', { skip }, async () => {
  const dev = await freshDevice('reject', 'v120', '1.2.0');
  dev.publish('v120', '1.2.0', ['--channel', 'both']);
  const s = dev.boot();
  await s.run('INIT', 'T 1000');

  // downgrade (C2.3): versi server lebih rendah
  dev.publish('v105', '1.0.5', ['--paksa']);
  await s.run('WS OTA CHECK', 'T 100');
  assert.equal(s.lastOta().st, 'uptodate');
  assert.match(s.lastOta().msg, /Sudah versi terbaru/);

  // MD5 salah (C2.3): unduhan selesai, verifikasi akhir gagal, firmware lama tetap
  dev.publish('v140', '1.4.0');
  const good = dev.readManifest();
  const bad = structuredClone(good);
  bad.latest.md5 = (bad.latest.md5[0] === 'a' ? 'b' : 'a') + bad.latest.md5.slice(1);
  dev.writeManifest(bad);
  await s.run('WS OTA INSTALL', 'T 500');
  assert.equal(s.lastOta().st, 'error');
  assert.match(s.lastOta().msg, /MD5/);
  assert.equal(s.restarted, false);

  // board salah (C2.3): ditolak sebelum mengunduh
  dev.writeManifest({ ...good, board: 'esp8266' });
  const before = s.lines.length;
  await s.run('WS OTA CHECK', 'T 100');
  assert.match(s.lastOta().msg, /board 'esp8266'/);
  assert.ok(!s.lines.slice(before).some((l) => /HTTP GET .*\.bin/.test(l)), 'file .bin tidak diunduh');

  // isi file diganti orang lain tanpa mengubah manifest: SHA-256 tidak cocok
  dev.writeManifest(good);
  const binFile = path.join(dev.server, 'kel04', 'fireguard-bridge-1.4.0.bin');
  const b = fs.readFileSync(binFile);
  b[5000] ^= 0xff;
  fs.writeFileSync(binFile, b);
  await s.run('WS OTA INSTALL', 'T 500');
  assert.match(s.lastOta().msg, /SHA-256 tidak cocok/);

  // jebakan "lupa naik versi": isi file v1.2.1 diterbitkan sebagai v1.5.0
  dev.publish('v121', '1.5.0', ['--lewati-cek-versi'], { fwVersion: '1.2.1' });
  await s.run('WS OTA INSTALL', 'T 500');
  assert.match(s.lastOta().msg, /Isi file melapor v1\.2\.1, padahal manifest v1\.5\.0/);
  assert.equal(s.restarted, false);

  // versi butuh firmware Uno lebih baru
  dev.publish('v160', '1.6.0', ['--min-uno', '1.5.0']);
  await s.run('WS OTA CHECK', 'T 100');
  assert.equal(s.lastOta().st, 'blocked');
  assert.match(s.lastOta().msg, /firmware Uno minimal v1\.5\.0, Uno masih v1\.4\.0/);

  // Uno tidak menjawab: update tidak dipasang
  dev.publish('v170', '1.7.0');
  await s.run('UNO off', 'T 4000', 'WS OTA INSTALL', 'T 200');
  assert.match(s.lastOta().msg, /Uno tidak mengirim data/);
  await s.close();
  assert.equal(s.restarted, false, 'semua kasus di atas tidak boleh mengganti firmware');
  assert.equal(dev.boots.length, 2);
});

test('Pull OTA lewat HTTPS: Root CA benar berhasil, Root CA salah (UJI_ROOT_CA_SALAH) gagal', { skip }, async () => {
  const env = { SIM_TLS_NEEDLE: tlsNeedle() };
  for (const [variant, ok] of [['h110', true], ['h110bad', false]]) {
    const dev = await freshDevice(`tls-${variant}`, variant, '1.1.0', env);
    dev.publish('v120', '1.2.0', [], { base: 'https://sim.local' });
    const s = dev.boot();
    await s.run('INIT', 'T 500', 'WS OTA CHECK', 'T 100');
    await s.close();
    if (ok) assert.equal(s.lastOta().st, 'available');
    else {
      assert.equal(s.lastOta().st, 'error');
      assert.match(s.lastOta().msg, /tersambung aman/);
      assert.ok(s.lines.some((l) => l.startsWith('HTTP TLS-GAGAL')));
    }
  }
});

test('Pull OTA otomatis (OTA_PASANG_OTOMATIS 1): dipasang sendiri saat robot diam', { skip }, async () => {
  const dev = await freshDevice('auto', 'auto110', '1.1.0');
  dev.publish('v120', '1.2.0');
  const s = dev.boot();
  await s.run('INIT', 'T 15000');
  assert.ok(s.restarted, 'cek otomatis 10 detik setelah menyala menemukan versi baru lalu memasangnya');
  const s2 = await dev.bootUntilStable(8000);
  assert.match(s2.log(), /v1\.2\.0 dikonfirmasi VALID/);
  await s2.close();
});

// ------------------------------------------------------------------
//  Safe OTA (Pertemuan 3)
// ------------------------------------------------------------------
async function installAndReboot(dev, variant, version, pubOpts = {}) {
  dev.publish(variant, version, [], pubOpts);
  const s = dev.boot();
  await s.run('INIT', 'T 500', 'WS OTA INSTALL', 'T 1500');
  assert.ok(s.restarted, `v${version} terpasang`);
  return s;
}

test('Safe OTA C3.2: health check gagal (FAULT_MODE 1) -> rollback ke versi lama tanpa server, versi gagal di-blacklist', { skip }, async () => {
  const dev = await freshDevice('fault1', 'v120', '1.2.0');
  await installAndReboot(dev, 'v130f1', '1.3.0');
  const trial = dev.boot();
  await trial.run('INIT', 'T 40000');
  assert.match(trial.log(), /TRIAL BOOT v1\.3\.0, percobaan 1\/3/);
  assert.match(trial.log(), /\[Health\] TIDAK LULUS: .*FAULT_MODE 1/);
  assert.match(trial.log(), /ROLLBACK v1\.3\.0/);
  assert.ok(trial.restarted);
  fs.rmSync(path.join(dev.server, 'kel04'), { recursive: true });     // rollback TIDAK butuh server

  const back = dev.boot();
  await back.run('INIT', 'T 1000', 'WSC', 'T 50');
  assert.equal(dev.boots.at(-1), 'v120');
  assert.match(back.log(), /blacklisted='1\.3\.0'/);
  const info = back.ws('bridge')[0];
  assert.equal(info.ota.last, 'rolled_back');
  assert.match(info.ota.lastMsg, /v1\.3\.0 dibatalkan: health check gagal/);
  await back.close();

  // versi yang sama diterbitkan lagi: tidak dipasang
  dev.publish('v130f1', '1.3.0');
  const again = dev.boot();
  await again.run('INIT', 'T 500', 'WS OTA CHECK', 'T 100');
  assert.equal(again.lastOta().st, 'blocked');
  assert.match(again.lastOta().msg, /pernah gagal/);
  await again.close();
});

test('Safe OTA C3.3: crash berulang (FAULT_MODE 2) -> boot ke-4 rollback', { skip }, async () => {
  const dev = await freshDevice('fault2', 'v120', '1.2.0');
  await installAndReboot(dev, 'v131f2', '1.3.1');
  const boots = [];
  let s;
  for (let i = 0; i < 6; i++) {
    s = dev.boot();
    await s.run('INIT', 'T 5000');
    boots.push(s);
    if (!s.exit) break;
  }
  assert.deepEqual(dev.boots.slice(-5), ['v131f2', 'v131f2', 'v131f2', 'v131f2', 'v120']);
  for (let i = 0; i < 3; i++) {
    assert.match(boots[i].log(), new RegExp(`percobaan ${i + 1}/3`));
    assert.ok(boots[i].crashed, `boot ${i + 1} crash`);
  }
  assert.match(boots[3].log(), /ROLLBACK v1\.3\.1: crash\/reboot 3 kali/);
  assert.match(s.log(), /blacklisted='1\.3\.1'/);
  await s.close();
});

test('Safe OTA: program macet (FAULT_MODE 3) ditangkap watchdog lalu rollback', { skip }, async () => {
  const dev = await freshDevice('fault3', 'v120', '1.2.0');
  await installAndReboot(dev, 'v132f3', '1.3.2');
  const s = await dev.bootUntilStable(20000, 8);
  assert.deepEqual(dev.boots.slice(-5), ['v132f3', 'v132f3', 'v132f3', 'v132f3', 'v120']);
  assert.match(s.log(), /blacklisted='1\.3\.2'/);
  await s.close();
});

test('Safe OTA C3.4: sensor api dicabut -> rollback, dipasang lagi + versi perbaikan -> VALID', { skip }, async () => {
  const dev = await freshDevice('sensor', 'v120', '1.2.0');
  await installAndReboot(dev, 'v140', '1.4.0');
  const trial = dev.boot();
  await trial.run('INIT', 'UNO fe 0 1', 'T 40000');
  assert.match(trial.log(), /TIDAK LULUS: .*sensor api Kanan tidak tersambung/);
  assert.ok(trial.restarted);

  const back = dev.boot();
  await back.run('INIT', 'UNO fe 0 1', 'T 1000');
  assert.equal(dev.boots.at(-1), 'v120');
  assert.match(back.log(), /terakhir: rolled_back v1\.4\.0 - v1\.4\.0 dibatalkan: health check gagal \(sensor api Kanan/);
  await back.close();

  // kabel dipasang lagi, terbitkan versi perbaikan
  await installAndReboot(dev, 'v141', '1.4.1');
  const s = dev.boot();
  await s.run('INIT', 'T 8000');
  assert.match(s.log(), /v1\.4\.1 dikonfirmasi VALID/);
  await s.close();
  assert.equal(dev.nvsState().good, '1.4.1');
});

test('Safe OTA: sensor tanpa daya (terbaca 0) juga dianggap tidak sehat', { skip }, async () => {
  const dev = await freshDevice('nopower', 'v120', '1.2.0');
  await installAndReboot(dev, 'v140', '1.4.0');
  const trial = dev.boot();
  await trial.run('INIT', 'UNO noerr', 'UNO fl 0 0', 'T 40000');
  assert.match(trial.log(), /sensor api Kiri terbaca 0 \(tanpa daya\?\)/);
  assert.ok(trial.restarted);
});

test('Safe OTA dengan bootloader (ROLLBACK_BOOTLOADER 1): crash pertama langsung kembali ke versi lama', { skip }, async () => {
  const dev = await freshDevice('boot', 'bl120', '1.2.0');
  await installAndReboot(dev, 'bl130f2', '1.3.0');
  const s = await dev.bootUntilStable(3000, 4);
  assert.deepEqual(dev.boots.slice(-2), ['bl130f2', 'bl120'], 'bootloader membatalkan v1.3.0 setelah crash pertama');
  assert.match(s.log(), /v1\.3\.0 tidak berhasil menyala, robot kembali ke v1\.2\.0/);
  await s.close();
  const st = dev.nvsState();
  assert.equal(st.black, '1.3.0');
  assert.equal(st.lastSt, 'rolled_back');
});

// ------------------------------------------------------------------
//  Push OTA (Pertemuan 1)
// ------------------------------------------------------------------
test('Push OTA C1: password salah ditolak, upload benar -> robot berhenti, masa percobaan, VALID', { skip }, async () => {
  const dev = await freshDevice('push', 'v110', '1.1.0');
  const img = dev.image('v120', '1.2.0');
  let s = dev.boot();
  await s.run('INIT', 'T 500', `PUSH ${img} salah`, 'T 50');
  assert.match(s.lastOta().msg, /password OTA salah/);
  assert.equal(s.restarted, false);
  await s.run('UNO sp 120', 'T 300', `PUSH ${img} rahasia`, 'T 50');
  assert.ok(s.restarted);
  const iPush = s.lines.findIndex((l) => l.includes('"st":"push"'));
  const iStop = s.lines.findIndex((l, i) => i > iPush - 3 && l === 'UNO STOP');
  assert.ok(iStop >= 0, 'robot dihentikan saat Push OTA mulai');
  assert.match(s.log(), /v1\.2\.0 diterima lewat Push OTA/);

  s = await dev.bootUntilStable(8000);
  assert.match(s.log(), /TRIAL BOOT v1\.2\.0/);
  assert.match(s.log(), /v1\.2\.0 dikonfirmasi VALID/);
  await s.close();
  assert.equal(dev.nvsState().src, 'push');
});

test('Push OTA: firmware robot lain dibatalkan; sketch tanpa penanda diterima tanpa masa percobaan', { skip }, async () => {
  const dev = await freshDevice('push2', 'v120', '1.2.0');
  const eco = dev.image('eco130', '1.3.0', 'ecobot-bridge');
  let s = dev.boot();
  await s.run('INIT', 'T 500', `PUSH ${eco} rahasia`, 'T 50');
  assert.match(s.log(), /upload 'ecobot-bridge' v1\.3\.0 dibatalkan/);
  s = dev.boot();
  await s.run('INIT', 'T 500');
  assert.equal(dev.boots.at(-1), 'v120', 'tetap memakai firmware lama');
  // sketch lain tanpa penanda FWID (mis. contoh dari modul)
  const plain = path.join(dev.images, 'v110.ino.bin');
  const raw = fs.readFileSync(dev.image('v110', '1.1.0')).toString('latin1').replace(/FWID:[^;]+;/, '');
  fs.writeFileSync(plain, Buffer.from(raw, 'latin1'));
  await s.run(`PUSH ${plain} rahasia`, 'T 50');
  assert.ok(s.restarted);
  const s2 = dev.boot();
  await s2.run('INIT', 'T 500');
  assert.equal(dev.boots.at(-1), 'v110');
  assert.doesNotMatch(s2.log(), /TRIAL BOOT/);
  await s2.close();
});

// ------------------------------------------------------------------
//  Tanda tangan digital
// ------------------------------------------------------------------
test('Tanda tangan: firmware bertanda tangan dipasang; tanpa tanda tangan atau tanda tangan palsu ditolak', { skip }, async () => {
  const dev = await freshDevice('sig', 'sig110', '1.1.0');
  const key = path.join(keyDir, 'priv.pem');
  dev.publish('sig120', '1.2.0', ['--key', key]);
  let s = dev.boot();
  await s.run('INIT', 'T 500', 'WS OTA INSTALL', 'T 1500');
  assert.match(s.log(), /Tanda tangan sah/);
  assert.ok(s.restarted);
  s = await dev.bootUntilStable(8000);
  assert.match(s.log(), /v1\.2\.0 dikonfirmasi VALID/);

  dev.publish('sig130', '1.3.0', ['--tanpa-tanda-tangan']);
  await s.run('WS OTA CHECK', 'T 100');
  assert.equal(s.lastOta().st, 'blocked');
  assert.match(s.lastOta().msg, /tidak ditandatangani/);

  dev.publish('sig131', '1.3.1', ['--key', key]);
  const m = dev.readManifest();
  const sig = m.latest.sig;
  m.latest.sig = sig.slice(0, -2) + (sig.slice(-2) === '00' ? '01' : '00');
  dev.writeManifest(m);
  await s.run('WS OTA INSTALL', 'T 500');
  assert.match(s.lastOta().msg, /Tanda tangan tidak sah/);
  await s.close();
  assert.equal(s.restarted, false);
});

// ------------------------------------------------------------------
//  Parameter proyek lewat OTA (demo)
// ------------------------------------------------------------------
test('Parameter lewat OTA: ambang api baru dari firmware ESP dikirim ke Uno dan ikut dicek saat masa percobaan', { skip }, async () => {
  const dev = await freshDevice('param', 'v110', '1.1.0');
  await installAndReboot(dev, 'par120', '1.2.0');
  const s = dev.boot();
  await s.run('INIT', 'T 8000');
  assert.ok(s.uno().includes('CFG F 650 350'));
  assert.equal(s.uno().filter((c) => c.startsWith('CFG')).length, 1, 'CFG hanya dikirim sekali (Uno sudah memakai nilai baru)');
  const infos = s.ws('info');
  assert.equal(infos.at(-1).th.fw, 650);
  assert.match(s.log(), /v1\.2\.0 dikonfirmasi VALID/);
  await s.close();
});

// ------------------------------------------------------------------
//  EcoBot: firmware bridge yang sama dengan ROBOT_NAME "ecobot"
// ------------------------------------------------------------------
const ECO_PRODUCT = { product: 'ecobot-bridge' };

test('EcoBot: update ditahan saat sapu berputar, lalu VALID; kabel sensor Depan lepas saat masa percobaan -> rollback', { skip }, async () => {
  const dev = await freshDevice('eco', 'eco110', '1.1.0', ECO);
  dev.publish('eco120', '1.2.0', [], ECO_PRODUCT);
  let s = dev.boot();
  await s.run('INIT', 'T 500', 'WSC', 'T 20', 'UNO br 70', 'T 400', 'WS OTA INSTALL', 'T 300');
  assert.equal(s.lastOta().st, 'blocked');
  assert.match(s.lastOta().msg, /Sapu masih berputar/);
  assert.equal(s.restarted, false);
  await s.run('WS STOP', 'T 400', 'WS OTA INSTALL', 'T 1500');
  assert.ok(s.restarted, 'sapu berhenti -> update dipasang');
  assert.ok(s.lines.some((l) => /HTTP GET .*ecobot-bridge-1\.2\.0\.bin/.test(l)), 'manifest & file EcoBot terpisah dari FireGuard');

  s = dev.boot();
  await s.run('INIT', 'T 8000');
  assert.equal(dev.boots.at(-1), 'eco120');
  assert.match(s.log(), /\[Health\] LULUS/);
  assert.match(s.log(), /v1\.2\.0 dikonfirmasi VALID/);
  await s.close();

  // versi berikutnya: kabel Echo sensor Depan lepas saat masa percobaan
  await installAndReboot(dev, 'eco121', '1.2.1', ECO_PRODUCT);
  const trial = dev.boot();
  await trial.run('INIT', 'UNO ue 1 0 0 0 0 0', 'UNO d -1 90 100 60 70 15', 'T 40000');
  assert.match(trial.log(), /TIDAK LULUS: .*sensor Depan tidak tersambung \(kabel Echo lepas\?\)/);
  assert.ok(trial.restarted);
  const back = dev.boot();
  await back.run('INIT', 'T 1000');
  assert.equal(dev.boots.at(-1), 'eco120');
  assert.match(back.log(), /rolled_back v1\.2\.1/);
  await back.close();
});

test('EcoBot: sensor ultrasonik yang tidak menjawab (tanpa daya) juga membatalkan update', { skip }, async () => {
  const dev = await freshDevice('ecodead', 'eco110', '1.1.0', ECO);
  await installAndReboot(dev, 'eco120', '1.2.0', ECO_PRODUCT);
  const trial = dev.boot();
  await trial.run('INIT', 'UNO ue 0 0 0 0 2 0', 'T 40000');
  assert.match(trial.log(), /sensor Kanan tidak menjawab \(cek VCC, GND, Trig\)/);
  assert.ok(trial.restarted);
});

test('EcoBot: parameter lewat OTA (jarak menghindar & PWM maju) dikirim dengan CFG D/A dan ikut dicek', { skip }, async () => {
  const dev = await freshDevice('ecopar', 'eco110', '1.1.0', ECO);
  await installAndReboot(dev, 'ecopar130', '1.3.0', ECO_PRODUCT);
  const s = dev.boot();
  await s.run('INIT', 'T 8000');
  assert.ok(s.uno().includes('CFG D 30 25'), s.uno().join('\n'));
  assert.ok(s.uno().includes('CFG A 130 120'), 'PWM putar tetap nilai Uno, PWM maju diganti');
  assert.ok(!s.uno().some((c) => /^CFG [FG] /.test(c)), 'perintah khusus FireGuard tidak dikirim ke EcoBot');
  assert.equal(s.uno().filter((c) => c.startsWith('CFG')).length, 2, 'masing-masing hanya sekali');
  const info = s.ws('info').at(-1);
  assert.equal(info.th.obst, 30);
  assert.equal(info.spd.fwd, 120);
  assert.match(s.log(), /v1\.3\.0 dikonfirmasi VALID/);
  await s.close();
});
