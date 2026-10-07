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

let binFG, binEB, binFGv, binEBr;
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
  const ebRelay = fs.readFileSync(path.join(root, 'firmware/ecobot_uno/ecobot_uno.ino'), 'utf8')
    .replace('#define BRUSH_USE_PWM   1', '#define BRUSH_USE_PWM   0')
    .replace('#define BRUSH_ACTIVE_HIGH 1', '#define BRUSH_ACTIVE_HIGH 0');
  const rpath = path.join(build, 'eb_relay.ino');
  fs.writeFileSync(rpath, ebRelay);
  binEBr = compile('ecobot_relay', rpath);
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
//  EcoBot (robot penyapu)
// ====================================================================
const EB = { ENA: 5, ENB: 6, IN1: 7, IN2: 8, IN3: 9, IN4: 10, BRUSH: 3, LIFT: 11,
  E: { depan: 14, kidepan: 15, kadepan: 16, kiri: 17, kanan: 18, wadah: 13 } };

async function ebMotors(h) {
  const side = async (a, b, en) => {
    const pa = await h.q('QP', a), pb = await h.q('QP', b), pw = await h.q('QW', en);
    if (pa && !pb) return pw;
    if (!pa && pb) return -pw;
    return 0;
  };
  return { l: await side(EB.IN1, EB.IN2, EB.ENA), r: await side(EB.IN3, EB.IN4, EB.ENB) };
}
const brushPwm = (h) => h.q('QW', EB.BRUSH);
const liftAngle = (h) => h.q('QS', EB.LIFT);

async function ebBoot(h, dists = {}, bin = 20) {
  const d = Object.assign({ depan: 0, kidepan: 0, kadepan: 0, kiri: 0, kanan: 0, wadah: bin }, dists);
  for (const [k, cm] of Object.entries(d)) await h.echo(EB.E[k], cm);
  await h.init();
  await h.t(1500);
}

test('EcoBot sapu: info & telemetri JSON valid, urutan sensor benar, posisi istirahat saat menyala', async () => {
  const h = mk(binEB);
  await ebBoot(h, { depan: 50, kidepan: 120, kiri: 9, kanan: 25, wadah: 12 });
  const info = h.infos[0];
  assert.equal(info.robot, 'ecobot');
  assert.equal(info.kind, 'sweeper');
  assert.equal(info.fw, '2.0.0');
  assert.deepEqual(info.us, ['Depan', 'Kiri-depan', 'Kanan-depan', 'Kiri', 'Kanan', 'Wadah']);
  assert.deepEqual(info.pins, ['A0', 'A1', 'A2', 'A3', 'A4', 'D13']);
  assert.deepEqual(info.th, { det: 50, near: 20, side: 10, binE: 20, binF: 4 });
  assert.deepEqual(info.lift, { up: 80, down: 20 });
  assert.deepEqual(info.brush, { pwm: 1, min: 35, auto: 70 });

  await h.t(2500);
  const t = h.tel();
  assert.equal(t.m, 'M');
  assert.equal(t.st, 'manual');
  assert.deepEqual(t.d, [50, 120, -1, 9, 25, 12], 'jarak tiap sensor, -1 = tidak ada pantulan');
  assert.deepEqual(t.l, [1, 0, 0, 2, 1, 0], 'level: 1 terdeteksi (<= 50), 2 dekat (samping <= 10)');
  assert.ok(Math.abs(t.bin - 50) <= 2, `wadah harus sekitar 50%, dapat ${t.bin}`);
  assert.equal(t.br, 0); assert.equal(t.bt, 0);
  assert.equal(t.lf, 1, 'sapu terangkat saat menyala');
  assert.equal(t.la, 80);
  assert.equal(t.sw, 0);
  assert.ok(!('bat' in t));
  assert.equal(await brushPwm(h), 0, 'motor sapu mati saat menyala');
  assert.equal(await liftAngle(h), 80);
});

test('EcoBot sapu: kapasitas wadah dihitung dari jarak (kosong 0%, penuh 100%)', async () => {
  const h = mk(binEB);
  await ebBoot(h, {}, 20);
  await h.t(3000);
  assert.ok(h.tel().bin <= 2, `kosong, dapat ${h.tel().bin}`);
  await h.echo(EB.E.wadah, 4);
  await h.t(4000);
  assert.ok(h.tel().bin >= 98, `penuh, dapat ${h.tel().bin}`);
  await h.echo(EB.E.wadah, 8);
  await h.t(4000);
  assert.ok(Math.abs(h.tel().bin - 75) <= 3, `sekitar 75%, dapat ${h.tel().bin}`);
});

test('EcoBot sapu manual: motor sapu naik pelan (soft-start), batas minimum, mati seketika, lama menyapu dihitung', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('BRUSH 100');
  await h.t(60);
  const mid = await brushPwm(h);
  assert.ok(mid > 0 && mid < 255, `kecepatan sapu harus naik bertahap, bukan lompat (PWM sementara ${mid})`);
  await h.t(800);
  assert.equal(await brushPwm(h), 255);
  await h.t(250);
  assert.equal(h.tel().br, 100);
  assert.equal(h.tel().bt, 100);

  await h.send('BRUSH 20'); await h.t(60);
  assert.equal(await brushPwm(h), Math.floor(35 * 255 / 100), 'di bawah batas minimum dinaikkan ke 35%');
  await h.send('BRUSH 60'); await h.t(300);
  assert.equal(await brushPwm(h), Math.floor(60 * 255 / 100));

  await h.t(2500);
  await h.send('BRUSH 0'); await h.t(30);
  assert.equal(await brushPwm(h), 0, 'mati langsung, tanpa menunggu');
  await h.t(250);
  assert.ok(h.tel().sw >= 3, `lama menyapu dicatat, dapat ${h.tel().sw} detik`);
  const sw = h.tel().sw;
  await h.t(2000);
  assert.equal(h.tel().sw, sw, 'saat sapu mati, hitungan tidak bertambah');
});

test('EcoBot sapu manual: servo pengangkat turun & naik bertahap', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('LIFT 0'); await h.t(60);
  const mid = await liftAngle(h);
  assert.ok(mid < 80 && mid > 20, `servo bergerak bertahap (sudut sementara ${mid})`);
  await h.t(600);
  assert.equal(await liftAngle(h), 20);
  await h.t(250);
  assert.equal(h.tel().lf, 0);
  assert.equal(h.tel().la, 20);
  await h.send('LIFT 1'); await h.t(700);
  assert.equal(await liftAngle(h), 80);
});

test('EcoBot sapu: modul relay (BRUSH_USE_PWM 0, aktif LOW) hanya nyala/mati', async () => {
  const h = mk(binEBr);
  await ebBoot(h);
  assert.equal(await h.q('QP', EB.BRUSH), 1, 'relay aktif LOW: HIGH = mati saat menyala');
  await h.send('BRUSH 50'); await h.t(60);
  assert.equal(await h.q('QP', EB.BRUSH), 0, 'LOW = sapu menyala');
  await h.send('BRUSH 0'); await h.t(60);
  assert.equal(await h.q('QP', EB.BRUSH), 1);
  assert.equal(await brushPwm(h), 0, 'mode relay tidak memakai PWM');
});

test('EcoBot sapu manual: DRV, dead-man, dan pengaman tabrakan depan (termasuk serong)', async () => {
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
  assert.deepEqual(await ebMotors(h), { l: -160, r: -160 }, 'mundur boleh');

  await h.echo(EB.E.depan, 0);
  await h.echo(EB.E.kadepan, 5);
  await h.t(1500);
  await h.send('DRV 0 100'); await h.t(100);
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 }, 'maju diblokir: ada benda 5 cm di serong kanan depan');
});

test('EcoBot sapu otomatis: sapu turun dulu, baru berputar, lalu maju pelan', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('MODE A'); await h.t(60);
  assert.equal(h.tel().m, 'A');
  assert.equal(await brushPwm(h), 0, 'sapu belum berputar selama masih turun');
  await h.t(1200);
  assert.equal(await liftAngle(h), 20, 'sapu turun ke lantai');
  assert.equal(await brushPwm(h), Math.floor(70 * 255 / 100), 'sapu berputar 70% di mode otomatis');
  assert.deepEqual(await ebMotors(h), { l: 110, r: 110 }, 'maju pelan saat menyapu');
  assert.equal(h.tel().st, 'sweep');
  assert.equal(h.tel().lf, 0);
});

test('EcoBot sapu otomatis: rintangan di depan -> sapu berhenti & terangkat, mundur, putar ke sisi yang lega, lanjut menyapu', async () => {
  const h = mk(binEB);
  await ebBoot(h, { kiri: 25, kidepan: 30 });           // sisi kiri sempit, kanan lega
  await h.send('MODE A'); await h.t(1500);
  assert.equal(h.tel().st, 'sweep');

  await h.echo(EB.E.depan, 15);
  let reversed = false, turnedRight = false, brushOffWhileAvoid = true, sawAvoid = false;
  for (let i = 0; i < 25; i++) {
    await h.t(60);
    const st = h.tel().st;
    const m = await ebMotors(h);
    if (st === 'avoid') {
      sawAvoid = true;
      if (await brushPwm(h) !== 0) brushOffWhileAvoid = false;
    }
    if (m.l < 0 && m.r < 0) reversed = true;
    if (m.l > 0 && m.r < 0) turnedRight = true;
  }
  assert.ok(sawAvoid, 'harus masuk state avoid');
  assert.ok(reversed, 'mundur dulu');
  assert.ok(turnedRight, 'berputar ke kanan (sisi yang lega)');
  assert.ok(brushOffWhileAvoid, 'sapu mati selama menghindar');
  assert.equal(h.tel().lf, 1, 'sapu terangkat saat menghindar');

  await h.echo(EB.E.depan, 0);                           // rintangan sudah tidak di depan
  await h.t(2500);
  assert.equal(h.tel().st, 'sweep');
  assert.equal(await brushPwm(h), Math.floor(70 * 255 / 100), 'sapu berputar lagi');
});

test('EcoBot sapu otomatis: terlalu dekat dinding samping -> menjauh sedikit sambil tetap maju', async () => {
  const h = mk(binEB);
  await ebBoot(h, { kiri: 6 });
  await h.send('MODE A'); await h.t(1200);
  assert.deepEqual(await ebMotors(h), { l: 110, r: 75 }, 'dinding kiri: roda kanan diperlambat (belok kanan)');
  await h.echo(EB.E.kiri, 0); await h.echo(EB.E.kanan, 6);
  await h.t(1200);
  assert.deepEqual(await ebMotors(h), { l: 75, r: 110 }, 'dinding kanan: belok kiri');
});

test('EcoBot sapu otomatis: tanpa rintangan, sesekali belok acak (sapu tetap berputar)', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('MODE A');
  let sawTurn = false, brushDuringTurn = true;
  for (let i = 0; i < 60; i++) {
    await h.t(250);
    if (h.tel().st === 'turn') {
      sawTurn = true;
      if (await brushPwm(h) === 0) brushDuringTurn = false;
    }
  }
  assert.ok(sawTurn, 'dalam 15 detik harus ada belok acak');
  assert.ok(brushDuringTurn, 'saat belok acak sapu tetap menyapu');
});

test('EcoBot sapu otomatis: wadah penuh -> berhenti, sapu mati & terangkat; dikosongkan -> lanjut', async () => {
  const h = mk(binEB);
  await ebBoot(h, {}, 4);
  await h.send('MODE A'); await h.t(4500);
  assert.equal(h.tel().st, 'full');
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 });
  assert.equal(await brushPwm(h), 0);
  assert.equal(await liftAngle(h), 80);
  await h.echo(EB.E.wadah, 20);
  await h.t(5000);
  assert.equal(h.tel().st, 'sweep');
  assert.equal(await brushPwm(h), Math.floor(70 * 255 / 100));
});

test('EcoBot sapu: BRUSH/LIFT diabaikan di mode otomatis; kembali manual = posisi istirahat', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('MODE A'); await h.t(1500);
  await h.send('BRUSH 0'); await h.send('LIFT 1'); await h.t(300);
  assert.equal(await brushPwm(h), Math.floor(70 * 255 / 100), 'mode otomatis yang mengatur sapu');
  assert.equal(await liftAngle(h), 20);
  await h.send('MODE M'); await h.t(800);
  assert.equal(await brushPwm(h), 0);
  assert.equal(await liftAngle(h), 80);
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 });
});

test('EcoBot sapu: STOP menghentikan semua (roda, sapu) dan masuk manual; baris sampah tidak merusak', async () => {
  const h = mk(binEB);
  await ebBoot(h);
  await h.send('MODE A'); await h.t(1500);
  assert.deepEqual(await ebMotors(h), { l: 110, r: 110 });
  await h.send('STOP'); await h.t(50);
  assert.equal(h.tel().m, 'M');
  assert.deepEqual(await ebMotors(h), { l: 0, r: 0 });
  assert.equal(await brushPwm(h), 0);
  await h.send('Z'.repeat(70)); await h.send('???'); await h.send('SPD'); await h.send('BRUSH'); await h.send('LIFT');
  await h.send('CLAW 1'); await h.send('PICK');            // perintah versi capit lama: diabaikan
  const r = await h.send('GET');
  assert.equal(r.filter((o) => o.t === 'tel').length, 1);
  assert.equal(h.tel().st, 'manual');
});
