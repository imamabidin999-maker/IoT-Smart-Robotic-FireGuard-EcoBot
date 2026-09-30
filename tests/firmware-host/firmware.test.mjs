// Uji logika firmware Uno di PC (tanpa hardware).
// Sketch .ino asli dikompilasi dengan shim Arduino, dijalankan dengan sensor palsu,
// lalu keluaran Serial-nya diperiksa: setiap baris harus JSON valid, dan perilaku
// (state machine otomatis, dead-man timer, urutan ambil sampah, dll) harus sesuai.
//
// Jalankan:  node --test tests/firmware-host/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const build = path.join(here, '.build');
const shim = path.join(here, 'shim');

function compile(name, sketchPath) {
  fs.mkdirSync(build, { recursive: true });
  const bin = path.join(build, name);
  execFileSync('g++', ['-std=c++17', '-O1', '-w', '-I', shim, `-DSKETCH_PATH="${sketchPath}"`, path.join(here, 'harness.cpp'), '-o', bin], { stdio: 'pipe' });
  return bin;
}

class Host {
  constructor(bin) {
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = '';
    this.pending = null;
    this.chain = Promise.resolve();       // perintah selalu diproses berurutan
    this.tels = [];
    this.infos = [];
    this.proc.stdout.on('data', (d) => { this.buf += d; this._drain(); });
  }
  _drain() {
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!this.pending) continue;
      if (line === 'DONE') { const p = this.pending; this.pending = null; p.resolve(p.lines); }
      else this.pending.lines.push(line);
    }
  }
  /** kirim satu perintah harness, kembalikan baris keluaran */
  run(line) {
    const job = () => new Promise((resolve) => {
      this.pending = { resolve, lines: [] };
      this.proc.stdin.write(line + '\n');
    });
    this.chain = this.chain.then(job);
    return this.chain;
  }
  async step(line) {
    const lines = await this.run(line);
    const res = [];
    for (const l of lines) {
      if (l.startsWith('OUT ')) {
        const text = l.slice(4);
        let obj;
        try { obj = JSON.parse(text); } catch (e) { assert.fail(`Keluaran Serial bukan JSON valid: ${text}`); }
        if (obj.t === 'tel') this.tels.push(obj);
        if (obj.t === 'info') this.infos.push(obj);
        res.push(obj);
      } else if (l.startsWith('RES ')) res.push(Number(l.slice(4)));
    }
    return res;
  }
  init() { return this.step('INIT'); }
  t(ms) { return this.step(`T ${ms}`); }
  /** kirim baris ke Uno lalu majukan 10 ms supaya loop() sempat membacanya */
  async send(text) {
    const a = await this.step(`S ${text}`);
    const b = await this.step('T 10');
    return a.concat(b);
  }
  analog(pin, v) { return this.step(`A ${pin} ${v}`); }
  echo(pin, cm) { return this.step(`E ${pin} ${cm}`); }
  async q(kind, pin) { return (await this.step(`${kind} ${pin}`))[0]; }
  tel() { return this.tels[this.tels.length - 1]; }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

const hosts = [];
const mk = (bin) => { const h = new Host(bin); hosts.push(h); return h; };
after(() => hosts.forEach((h) => h.close()));

let binFG, binEB, binFGv;
before(() => {
  binFG = compile('fireguard', path.join(root, 'firmware/fireguard_uno/fireguard_uno.ino'));
  binEB = compile('ecobot', path.join(root, 'firmware/ecobot_uno/ecobot_uno.ino'));
  const src = fs.readFileSync(path.join(root, 'firmware/fireguard_uno/fireguard_uno.ino'), 'utf8')
    .replace('#define FLAME_COUNT     2 ', '#define FLAME_COUNT     3 ')
    .replace('#define GAS_COUNT       1 ', '#define GAS_COUNT       2 ')
    .replace('#define HAS_BATTERY_SENSE 0', '#define HAS_BATTERY_SENSE 1');
  const vpath = path.join(build, 'fg_variant.ino');
  fs.writeFileSync(vpath, src);
  binFGv = compile('fireguard_variant', vpath);
});

// ====================================================================
//  FireGuard
// ====================================================================
const FG = { ENA: 5, ENB: 6, IN1: 7, IN2: 8, IN3: 9, IN4: 10, PUMP: 4, NOZ: 11, FL: [14, 15, 16], GAS: [17, 18] };

async function fgMotors(h) {
  const side = async (a, b, en) => {
    const pa = await h.q('QP', a), pb = await h.q('QP', b), pw = await h.q('QW', en);
    if (pa && !pb) return pw;
    if (!pa && pb) return -pw;
    return 0;
  };
  return { l: await side(FG.IN1, FG.IN2, FG.ENA), r: await side(FG.IN3, FG.IN4, FG.ENB) };
}

async function fgBoot(h, flame = 950, gas = 150) {
  FG.FL.forEach((p) => h.analog(p, flame));
  FG.GAS.forEach((p) => h.analog(p, gas));
  await h.init();
  await h.t(300);
}

test('FireGuard: pesan info & telemetri adalah JSON valid dengan isi yang benar', async () => {
  const h = mk(binFG);
  await fgBoot(h);
  const info = h.infos[0];
  assert.equal(info.robot, 'fireguard');
  assert.equal(info.fw, '1.0.0');
  assert.deepEqual(info.flame, ['Kiri', 'Kanan']);
  assert.deepEqual(info.flamePins, ['A0', 'A1']);
  assert.deepEqual(info.gas, ['MQ-2']);
  assert.deepEqual(info.th, { fw: 700, fd: 400, gw: 350, gd: 550 });
  assert.deepEqual(info.noz, { min: 40, max: 140, home: 90 });

  const t = h.tel();
  assert.equal(t.m, 'A');
  assert.equal(t.st, 'idle');
  assert.equal(t.fl.length, 2);
  assert.deepEqual(t.fs, [0, 0]);
  assert.equal(t.gs.length, 1);
  assert.deepEqual(t.gl, [0]);
  assert.equal(t.gw, 1, 'sensor gas masih pemanasan');
  assert.equal(t.p, 0);
  assert.equal(t.na, 90);
  assert.equal(t.cap, 160);
  assert.equal(t.sp, 0);
  assert.ok(!('bat' in t), 'tanpa sensor baterai, field bat tidak dikirim');
  assert.equal(await h.q('QP', FG.PUMP), 0, 'pompa harus mati saat boot');
});

test('FireGuard: GET dan INFO dijawab langsung', async () => {
  const h = mk(binFG);
  await fgBoot(h);
  const r1 = await h.send('GET');
  assert.equal(r1.filter((o) => o.t === 'tel').length, 1);
  const r2 = await h.send('INFO');
  assert.ok(r2.some((o) => o.t === 'info') && r2.some((o) => o.t === 'tel'));
});

test('FireGuard: alarm gas tidak menyala selama pemanasan, menyala setelahnya', async () => {
  const h = mk(binFG);
  await fgBoot(h);
  h.analog(FG.GAS[0], 700);
  await h.t(3000);
  assert.deepEqual(h.tel().gl, [0], 'selama pemanasan level harus 0');
  assert.equal(h.tel().gw, 1);
  await h.t(18000);
  assert.equal(h.tel().gw, 0);
  assert.deepEqual(h.tel().gl, [2]);
  h.analog(FG.GAS[0], 420);
  await h.t(1000);
  assert.deepEqual(h.tel().gl, [1], 'nilai menengah = waspada');
  h.analog(FG.GAS[0], 150);
  await h.t(1000);
  assert.deepEqual(h.tel().gl, [0]);
});

test('FireGuard otomatis: siaga -> belok ke api -> semprot -> jeda -> siaga', async () => {
  const h = mk(binFG);
  await fgBoot(h);

  h.analog(FG.FL[0], 500);             // api lemah di sisi kiri
  await h.t(600);
  assert.equal(h.tel().st, 'turn');
  assert.deepEqual(h.tel().fs, [1, 0]);
  const m = await fgMotors(h);
  assert.deepEqual(m, { l: -150, r: 150 }, 'berputar ke kiri di tempat');

  h.analog(FG.FL[0], 300); h.analog(FG.FL[1], 300);   // api kuat
  await h.t(400);
  assert.equal(h.tel().st, 'spray');
  assert.equal(h.tel().p, 1);
  assert.equal(await h.q('QP', FG.PUMP), 1, 'pin pompa aktif');
  assert.deepEqual(await fgMotors(h), { l: 0, r: 0 }, 'berhenti saat menyemprot');

  const angles = new Set();
  for (let i = 0; i < 12; i++) { await h.t(150); angles.add(await h.q('QS', FG.NOZ)); }
  assert.ok(Math.max(...angles) - Math.min(...angles) >= 20, `nozzle harus mengayun, sudut teramati: ${[...angles]}`);

  h.analog(FG.FL[0], 950); h.analog(FG.FL[1], 950);   // api padam
  await h.t(2800);
  assert.equal(h.tel().st, 'rest');
  assert.equal(await h.q('QP', FG.PUMP), 0, 'pompa mati setelah api padam');
  await h.t(3000);
  assert.equal(h.tel().st, 'idle');
});

test('FireGuard otomatis: pompa dibatasi 15 detik lalu jeda, lanjut lagi kalau api masih ada', async () => {
  const h = mk(binFG);
  await fgBoot(h);
  h.analog(FG.FL[0], 300); h.analog(FG.FL[1], 300);
  await h.t(1000);
  assert.equal(h.tel().st, 'spray');
  await h.t(13500);                      // ~14 detik sejak mulai menyemprot
  assert.equal(h.tel().st, 'spray', 'belum 15 detik');
  await h.t(2500);                       // ~16 detik
  assert.equal(h.tel().st, 'rest', 'melewati batas 15 detik harus jeda');
  assert.equal(await h.q('QP', FG.PUMP), 0);
  await h.t(3500);
  assert.equal(h.tel().st, 'spray', 'api masih ada -> lanjut menyemprot');
});

test('FireGuard: api di tengah (3 sensor) -> maju lurus', async () => {
  const h = mk(binFGv);
  await fgBoot(h);
  const info = h.infos[0];
  assert.deepEqual(info.flame, ['Kiri', 'Depan', 'Kanan']);
  assert.deepEqual(info.gas, ['MQ-2 #1', 'MQ-2 #2']);
  assert.equal(h.tel().fl.length, 3);
  assert.equal(h.tel().gs.length, 2);
  assert.ok('bat' in h.tel());
  h.analog(FG.FL[1], 550);             // hanya sensor depan melihat api
  await h.t(1500);
  assert.equal(h.tel().st, 'approach');
  assert.deepEqual(await fgMotors(h), { l: 140, r: 140 });
});

test('FireGuard manual: DRV, batas kecepatan, dead-man, pompa, nozzle, STOP', async () => {
  const h = mk(binFG);
  await fgBoot(h);
  await h.send('MODE M');
  await h.t(50);
  assert.equal(h.tel().m, 'M');
  assert.equal(h.tel().st, 'manual');

  await h.send('DRV 0 100');
  await h.t(100);
  assert.deepEqual(await fgMotors(h), { l: 160, r: 160 }, 'maju penuh = batas kecepatan bawaan 160');
  await h.send('DRV 0 100'); await h.t(250);        // tunggu telemetri berikutnya (DRV terus diperbarui seperti dashboard)
  assert.equal(h.tel().sp, 160);

  await h.t(800);                       // tidak ada DRV baru
  assert.deepEqual(await fgMotors(h), { l: 0, r: 0 }, 'dead-man harus menghentikan motor');

  await h.send('SPD 100');
  await h.send('DRV 0 100'); await h.t(50);
  assert.deepEqual(await fgMotors(h), { l: 100, r: 100 });
  await h.send('DRV 100 0'); await h.t(50);
  assert.deepEqual(await fgMotors(h), { l: 100, r: -100 }, 'belok kanan di tempat');
  await h.send('DRV -100 0'); await h.t(50);
  assert.deepEqual(await fgMotors(h), { l: -100, r: 100 }, 'belok kiri di tempat');
  await h.send('DRV 0 -100'); await h.t(50);
  assert.deepEqual(await fgMotors(h), { l: -100, r: -100 }, 'mundur');
  await h.send('DRV 999 999'); await h.t(50);
  const clamp = await fgMotors(h);
  assert.ok(Math.abs(clamp.l) <= 255 && Math.abs(clamp.r) <= 255);

  // pompa: tahan-tekan dengan dead-man
  for (let i = 0; i < 5; i++) { await h.send('PUMP 1'); await h.t(200); }
  assert.equal(await h.q('QP', FG.PUMP), 1);
  assert.equal(h.tel().p, 1);
  await h.t(800);
  assert.equal(await h.q('QP', FG.PUMP), 0, 'pompa mati sendiri kalau perintah berhenti');
  await h.send('PUMP 1'); await h.t(50);
  await h.send('PUMP 0'); await h.t(50);
  assert.equal(await h.q('QP', FG.PUMP), 0);

  // nozzle
  await h.send('NOZ 120'); await h.t(400);
  assert.equal(await h.q('QS', FG.NOZ), 120);
  await h.send('NOZ 999'); await h.t(600);
  assert.equal(await h.q('QS', FG.NOZ), 140, 'dibatasi NOZ_MAX');
  await h.send('NOZ -5'); await h.t(900);
  assert.equal(await h.q('QS', FG.NOZ), 40, 'dibatasi NOZ_MIN');

  // STOP
  await h.send('DRV 0 100'); await h.send('PUMP 1'); await h.t(50);
  await h.send('STOP'); await h.t(50);
  assert.deepEqual(await fgMotors(h), { l: 0, r: 0 });
  assert.equal(await h.q('QP', FG.PUMP), 0);
  assert.equal(h.tel().m, 'M');
});

test('FireGuard: di mode otomatis DRV/PUMP/NOZ diabaikan; baris rusak/kepanjangan tidak merusak apa pun', async () => {
  const h = mk(binFG);
  await fgBoot(h);
  await h.send('DRV 0 100'); await h.send('PUMP 1'); await h.send('NOZ 130'); await h.t(100);
  assert.deepEqual(await fgMotors(h), { l: 0, r: 0 });
  assert.equal(await h.q('QP', FG.PUMP), 0);
  assert.equal(await h.q('QS', FG.NOZ), 90);

  await h.send('X'.repeat(80));          // kepanjangan
  await h.send('FOO 1 2 3');
  await h.send('MODE');                  // argumen kurang
  await h.send('DRV 5');                 // argumen kurang
  await h.send('');
  const r = await h.send('GET');
  assert.equal(r.filter((o) => o.t === 'tel').length, 1, 'masih merespons setelah input sampah');
  assert.equal(h.tel().m, 'A');
});

test('FireGuard: telemetri datang ~4x per detik', async () => {
  const h = mk(binFG);
  await fgBoot(h);
  const before = h.tels.length;
  await h.t(2000);
  const n = h.tels.length - before;
  assert.ok(n >= 7 && n <= 9, `diharapkan ~8 telemetri per 2 detik, dapat ${n}`);
});

// ====================================================================
//  EcoBot
// ====================================================================
const EB = { ENA: 5, ENB: 6, IN1: 7, IN2: 8, IN3: 9, IN4: 10, CLAW: 3, ARM: 11,
  E: { depan: 14, belakang: 15, kiri: 16, kanan: 17, capit: 18, bin: 13 } };

async function ebMotors(h) {
  const side = async (a, b, en) => {
    const pa = await h.q('QP', a), pb = await h.q('QP', b), pw = await h.q('QW', en);
    if (pa && !pb) return pw;
    if (!pa && pb) return -pw;
    return 0;
  };
  return { l: await side(EB.IN1, EB.IN2, EB.ENA), r: await side(EB.IN3, EB.IN4, EB.ENB) };
}

async function ebBoot(h, dists = {}) {
  const d = Object.assign({ depan: 0, belakang: 0, kiri: 0, kanan: 0, capit: 0, bin: 20 }, dists);
  for (const [k, cm] of Object.entries(d)) await h.echo(EB.E[k], cm);
  await h.init();
  await h.t(1500);
}

test('EcoBot: info & telemetri JSON valid, urutan sensor benar', async () => {
  const h = mk(binEB);
  await ebBoot(h, { depan: 50, belakang: 120, kanan: 25, capit: 10, bin: 12 });
  const info = h.infos[0];
  assert.equal(info.robot, 'ecobot');
  assert.deepEqual(info.us, ['Depan', 'Belakang', 'Kiri', 'Kanan', 'Capit', 'Bin']);
  assert.deepEqual(info.pins, ['A0', 'A1', 'A2', 'A3', 'A4', 'D13']);
  assert.deepEqual(info.th, { det: 60, reach: 15, grab: 12, binE: 20, binF: 4 });
  assert.deepEqual(info.ang, { clawOpen: 90, clawClosed: 25, armDown: 10, armUp: 150 });

  await h.t(2500);
  const t = h.tel();
  assert.equal(t.m, 'M');
  assert.equal(t.st, 'manual');
  assert.deepEqual(t.d, [50, 120, -1, 25, 10, 12], 'jarak tiap sensor, -1 = tidak ada pantulan');
  assert.deepEqual(t.l, [1, 0, 0, 1, 2, 0], 'level: 1 terdeteksi, 2 jangkauan (Capit <= 12 cm)');
  assert.ok(Math.abs(t.bin - 50) <= 2, `bin harus sekitar 50%, dapat ${t.bin}`);
  assert.equal(t.cl, 1); assert.equal(t.ar, 0);
  assert.equal(t.ca, 25); assert.equal(t.aa, 10);
  assert.equal(t.n, 0);
  assert.ok(!('bat' in t));
});

test('EcoBot: kapasitas bin dihitung dari jarak (kosong 0%, penuh 100%)', async () => {
  const h = mk(binEB);
  await ebBoot(h, { bin: 20 });
  await h.t(3000);
  assert.ok(h.tel().bin <= 2, `kosong, dapat ${h.tel().bin}`);
  await h.echo(EB.E.bin, 4);
  await h.t(4000);
  assert.ok(h.tel().bin >= 98, `penuh, dapat ${h.tel().bin}`);
  await h.echo(EB.E.bin, 8);
  await h.t(4000);
  assert.ok(Math.abs(h.tel().bin - 75) <= 3, `sekitar 75%, dapat ${h.tel().bin}`);
});

test('EcoBot manual: capit dan lengan bergerak bertahap ke sudut yang benar', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('CLAW 0'); await h.t(120);
  const mid = await h.q('QS', EB.CLAW);
  assert.ok(mid > 25 && mid < 90, `servo bergerak bertahap, bukan lompat (sudut sementara ${mid})`);
  await h.t(400);
  assert.equal(await h.q('QS', EB.CLAW), 90);
  assert.equal(h.tel().cl, 0);
  assert.equal(h.tel().ca, 90);
  await h.send('ARM 1'); await h.t(800);
  assert.equal(await h.q('QS', EB.ARM), 150);
  assert.equal(h.tel().ar, 1);
  await h.send('ARM 0'); await h.send('CLAW 1'); await h.t(800);
  assert.equal(await h.q('QS', EB.ARM), 10);
  assert.equal(await h.q('QS', EB.CLAW), 25);
});

test('EcoBot: urutan ambil sampah (PICK) lengkap dan menambah hitungan', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('PICK'); await h.t(100);
  assert.equal(h.tel().st, 'pick');
  let maxArm = 0, openSeen = false, closedAfterOpen = false;
  for (let i = 0; i < 50; i++) {
    await h.t(100);
    const arm = await h.q('QS', EB.ARM), claw = await h.q('QS', EB.CLAW);
    maxArm = Math.max(maxArm, arm);
    if (claw === 90) openSeen = true;
    if (openSeen && claw === 25) closedAfterOpen = true;
    assert.deepEqual(await ebMotors(h), { l: 0, r: 0 }, 'motor diam selama mengambil');
  }
  assert.equal(maxArm, 150, 'lengan harus naik sampai atas bin');
  assert.ok(openSeen && closedAfterOpen, 'capit harus membuka lalu menutup');
  assert.equal(h.tel().n, 1);
  assert.equal(h.tel().st, 'manual');
  assert.equal(await h.q('QS', EB.ARM), 10);
  assert.equal(await h.q('QS', EB.CLAW), 25);
  assert.equal(h.tel().cl, 1);
  assert.equal(h.tel().ar, 0);
});

test('EcoBot: CLAW/ARM ditolak saat mengambil; ganti mode saat mengambil = kembali ke posisi istirahat', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('PICK'); await h.t(2000);        // lengan sedang di atas
  await h.send('ARM 0'); await h.send('CLAW 0'); await h.t(100);
  assert.equal(h.tel().st, 'pick', 'perintah manual diabaikan saat urutan jalan');
  await h.send('MODE A'); await h.t(1000);
  assert.equal(await h.q('QS', EB.ARM), 10, 'lengan kembali turun');
  assert.equal(await h.q('QS', EB.CLAW), 25, 'capit kembali menutup');
  assert.notEqual(h.tel().st, 'pick');
  assert.equal(h.tel().n, 0, 'urutan dibatalkan, tidak dihitung');
});

test('EcoBot: PICK ditolak kalau bin penuh', async () => {
  const h = mk(binEB);
  await ebBoot(h, { bin: 4 });
  await h.t(4000);
  assert.ok(h.tel().bin >= 95);
  await h.send('PICK'); await h.t(200);
  assert.notEqual(h.tel().st, 'pick');
});

test('EcoBot manual: DRV, dead-man, dan pengaman tabrakan depan/belakang', async () => {
  const h = mk(binEB);
  await ebBoot(h, { depan: 100 });
  await h.send('DRV 0 100'); await h.t(100);
  assert.deepEqual(await ebMotors(h), { l: 160, r: 160 });
  await h.t(800);
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 }, 'dead-man');

  await h.echo(EB.E.depan, 4);
  await h.t(1500);
  await h.send('DRV 0 100'); await h.t(100);
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 }, 'maju diblokir: ada benda 4 cm di depan');
  await h.send('DRV 100 0'); await h.t(100);
  assert.deepEqual(await ebMotors(h), { l: 160, r: -160 }, 'berputar di tempat tetap boleh');
  await h.send('DRV 0 -100'); await h.t(100);
  assert.deepEqual(await ebMotors(h), { l: -160, r: -160 }, 'mundur boleh kalau belakang kosong');

  await h.echo(EB.E.belakang, 4);
  await h.t(1500);
  await h.send('DRV 0 -100'); await h.t(100);
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 }, 'mundur diblokir: ada benda 4 cm di belakang');
});

test('EcoBot otomatis: menjelajah -> mendekati objek -> mengambil -> lanjut', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('MODE A'); await h.t(300);
  assert.equal(h.tel().m, 'A');
  assert.equal(h.tel().st, 'roam');
  assert.deepEqual(await ebMotors(h), { l: 110, r: 110 });

  await h.echo(EB.E.depan, 50);
  await h.t(1500);
  assert.equal(h.tel().st, 'approach');
  assert.deepEqual(await ebMotors(h), { l: 90, r: 90 }, 'mendekat pelan');

  await h.echo(EB.E.capit, 10);          // objek masuk jangkauan capit
  await h.t(2000);                        // bacaan stabil dulu (400 ms) baru capit bergerak
  assert.equal(h.tel().st, 'pick');
  await h.echo(EB.E.depan, 0); await h.echo(EB.E.capit, 0);   // objek sudah terambil
  await h.t(5000);
  assert.equal(h.tel().n, 1);
  assert.equal(h.tel().st, 'roam');
});

test('EcoBot otomatis: benda di depan + di samping dianggap dinding -> menghindar, bukan mengambil', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('MODE A'); await h.t(300);
  await h.echo(EB.E.depan, 14);
  await h.echo(EB.E.kiri, 20);
  await h.t(1600);
  let sawAvoid = false, reversed = false, pick = false;
  for (let i = 0; i < 10; i++) {
    await h.t(100);
    const st = h.tel().st;
    if (st === 'avoid') sawAvoid = true;
    if (st === 'pick') pick = true;
    const m = await ebMotors(h);
    if (m.l < 0 && m.r < 0) reversed = true;
  }
  assert.ok(sawAvoid, 'harus masuk state avoid');
  assert.ok(reversed, 'harus mundur dulu karena belakang kosong');
  assert.ok(!pick, 'tidak boleh mencoba mengambil dinding');
  assert.equal(h.tel().n, 0);
});

test('EcoBot otomatis: bin penuh -> berhenti total', async () => {
  const h = mk(binEB);
  await ebBoot(h, { bin: 4 });
  await h.send('MODE A'); await h.t(4500);
  assert.equal(h.tel().st, 'full');
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 });
  await h.echo(EB.E.bin, 20);            // bin dikosongkan
  await h.t(5000);
  assert.notEqual(h.tel().st, 'full');
  assert.equal(h.tel().st, 'roam');
});

test('EcoBot: STOP menghentikan semua dan masuk manual; baris sampah tidak merusak', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('MODE A'); await h.t(300);
  assert.deepEqual(await ebMotors(h), { l: 110, r: 110 });
  await h.send('STOP'); await h.t(50);
  assert.equal(h.tel().m, 'M');
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 });
  await h.send('Z'.repeat(70)); await h.send('???'); await h.send('SPD'); await h.send('CLAW');
  const r = await h.send('GET');
  assert.equal(r.filter((o) => o.t === 'tel').length, 1);
});
