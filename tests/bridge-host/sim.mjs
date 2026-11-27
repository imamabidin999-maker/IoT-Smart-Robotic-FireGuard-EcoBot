// Pembantu untuk menguji esp_bridge.ino di PC: kompilasi varian firmware, flash palsu dua slot,
// tiruan bootloader ESP-IDF, server update (folder), dan publish_fw.py asli.
import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../..');
export const sketchDir = path.join(root, 'firmware', 'esp_bridge');
export const buildDir = path.join(here, '.build');
export const publishPy = path.join(root, 'tools', 'ota', 'publish_fw.py');
export const keygenPy = path.join(root, 'tools', 'ota', 'keygen.py');
export const BASE = 'http://sim.local:8000';

// ------------------------------------------------------------------
//  ArduinoJson (header-only). Dicari di beberapa tempat, kalau tidak ada diunduh sekali.
// ------------------------------------------------------------------
async function fetchArduinoJson(dest, tag = 'v7.4.2') {
  const base = `https://raw.githubusercontent.com/bblanchon/ArduinoJson/${tag}/src/`;
  const seen = new Set();
  const todo = ['ArduinoJson.h'];
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    const res = await fetch(base + p);
    if (!res.ok) continue;
    const text = await res.text();
    const file = path.join(dest, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const dir = path.posix.dirname(p);
    for (const m of text.matchAll(/#\s*include\s+[<"](ArduinoJson[^>"]*|[^>"]+\.hpp)[>"]/g)) {
      for (const q of [m[1], path.posix.normalize(path.posix.join(dir, m[1]))]) if (!seen.has(q)) todo.push(q);
    }
  }
  if (!fs.existsSync(path.join(dest, 'ArduinoJson.h'))) throw new Error('gagal mengunduh ArduinoJson');
}

export async function findArduinoJson() {
  const cands = [
    process.env.ARDUINOJSON_DIR,
    path.join(here, '.deps', 'ArduinoJson'),
    path.join(os.homedir(), 'Arduino', 'libraries', 'ArduinoJson', 'src'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'ArduinoJson.h'))) return c;
  const dest = path.join(here, '.deps', 'ArduinoJson');
  await fetchArduinoJson(dest);
  return dest;
}

// ------------------------------------------------------------------
//  Varian firmware
// ------------------------------------------------------------------
export const TEST_SECRETS = `#pragma once
#define WIFI_SSID     "SIM-WIFI"
#define WIFI_PASS     "sim-password"
#define GROUP_ID      "kel04"
#define OTA_PASSWORD  "rahasia"
#define SERVER_BASE   "${BASE}"
`;

/**
 * Salin sketch ke folder sendiri, ganti baris #define tertentu, lalu kompilasi dengan ESP32 palsu.
 * set: { FW_VERSION: '"1.2.0"', FAULT_MODE: '1', ... }  secrets: isi secrets.h  pubkey: isi ota_pubkey.h
 */
export async function buildVariant(name, { set = {}, secrets = TEST_SECRETS, pubkey = null, ajDir }) {
  const src = path.join(buildDir, `src-${name}`);
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  for (const f of fs.readdirSync(sketchDir)) {
    if (f === 'secrets.h' || f.startsWith('.')) continue;
    fs.copyFileSync(path.join(sketchDir, f), path.join(src, f));
  }
  let cfg = fs.readFileSync(path.join(src, 'config.h'), 'utf8');
  for (const [k, v] of Object.entries(set)) {
    const re = new RegExp(`^(\\s*#define\\s+${k}\\s+)(\\S+)`, 'm');
    if (!re.test(cfg)) throw new Error(`#define ${k} tidak ada di config.h`);
    cfg = cfg.replace(re, `$1${v}`);
  }
  fs.writeFileSync(path.join(src, 'config.h'), cfg);
  fs.writeFileSync(path.join(src, 'secrets.h'), secrets);
  if (pubkey !== null) fs.writeFileSync(path.join(src, 'ota_pubkey.h'), pubkey);
  const bin = path.join(buildDir, `bridge-${name}`);
  await execFileP('g++', ['-std=c++17', '-O0', '-g', '-w', '-DESP32', '-I', path.join(here, 'shim'), '-I', ajDir,
    `-DSKETCH_PATH="${path.join(src, 'esp_bridge.ino')}"`, path.join(here, 'harness.cpp'), path.join(here, 'sim_weak.cpp'),
    '-lmbedcrypto', '-o', bin], { maxBuffer: 1 << 24 });
  return bin;
}

/** Image .bin palsu: header ESP (0xE9, chip id ESP32), penanda FWID, dan nama varian untuk harness. */
export function makeImage(file, variant, product, version, size = 90000) {
  const head = Buffer.alloc(24);
  head[0] = 0xe9; head[1] = 5; head[2] = 2; head[3] = 0x20;
  const mark = Buffer.from((product ? `FWID:${product}:${version};` : '') + `SIMBIN:${variant};`, 'latin1');
  const body = Buffer.alloc(size - head.length - mark.length);
  let x = 0;
  for (const c of variant + version) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = 0; i < body.length; i++) { x = (x * 1103515245 + 12345) >>> 0; body[i] = x >>> 24; }
  fs.writeFileSync(file, Buffer.concat([head, mark, body]));
  return file;
}

// ------------------------------------------------------------------
//  Satu kali boot = satu proses
// ------------------------------------------------------------------
const liveSessions = new Set();
/** hentikan semua proses firmware yang masih hidup (dipanggil di after(), juga kalau ada tes gagal) */
export function killAll() {
  for (const s of liveSessions) { try { s.proc.kill('SIGKILL'); } catch (e) { /* sudah mati */ } }
  liveSessions.clear();
}

export class Session {
  constructor(bin, env) {
    this.proc = spawn(bin, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    liveSessions.add(this);
    this.lines = [];
    this.buf = '';
    this.waiter = null;
    this.exit = null;
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line === 'DONE') { const w = this.waiter; this.waiter = null; if (w) w(); continue; }
        this.lines.push(line);
      }
    });
    this.done = new Promise((resolve) => {
      this.proc.on('exit', (code, signal) => {
        liveSessions.delete(this);
        this.exit = { code, signal };
        const w = this.waiter; this.waiter = null; if (w) w();
        resolve(this.exit);
      });
    });
  }
  /** kirim perintah harness; selesai saat DONE atau saat proses berhenti (restart/crash) */
  send(cmd) {
    if (this.exit) return Promise.resolve();
    return new Promise((resolve) => { this.waiter = resolve; this.proc.stdin.write(cmd + '\n'); });
  }
  async run(...cmds) { for (const c of cmds) { if (this.exit) break; await this.send(c); } return this; }
  async close() { if (!this.exit) { this.proc.stdin.end(); await this.done; } return this.exit; }
  get restarted() { return !!this.exit && this.exit.code === 77; }
  get crashed() { return !!this.exit && !!this.exit.signal; }
  logs() { return this.lines.filter((l) => l.startsWith('LOG ')).map((l) => l.slice(4)); }
  log() { return this.logs().join('\n'); }
  uno() { return this.lines.filter((l) => l.startsWith('UNO ')).map((l) => l.slice(4)); }
  ws(kind) {
    const out = [];
    for (const l of this.lines) {
      const m = /^WS(\*|\d+) (.*)$/.exec(l);
      if (!m) continue;
      try { const o = JSON.parse(m[2]); if (!kind || o.t === kind) out.push(o); } catch (e) { /* bukan JSON */ }
    }
    return out;
  }
  ota() { return this.ws('ota'); }
  lastOta() { const a = this.ota(); return a[a.length - 1]; }
}

// ------------------------------------------------------------------
//  Perangkat: flash + NVS di folder, tiruan bootloader
// ------------------------------------------------------------------
const ST = { NEW: 0, PENDING: 1, VALID: 2, INVALID: 3, ABORTED: 4, UNDEF: -1 };

export class Device {
  constructor(name, variants, extraEnv = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `ota-${name}-`));
    this.state = path.join(this.dir, 'state');
    this.server = path.join(this.dir, 'server');
    this.images = path.join(this.dir, 'img');
    for (const d of [this.state, this.server, this.images]) fs.mkdirSync(d, { recursive: true });
    this.variants = variants;
    this.env = extraEnv;
    this.boots = [];
  }
  slotFile(i) { return path.join(this.state, `slot${i}.bin`); }
  readOtadata() {
    const t = fs.existsSync(path.join(this.state, 'otadata.txt')) ? fs.readFileSync(path.join(this.state, 'otadata.txt'), 'utf8') : 'boot=0\nst0=-1\nst1=-1\n';
    const g = (k) => Number(new RegExp(`${k}=(-?\\d+)`).exec(t)[1]);
    return { boot: g('boot'), st: [g('st0'), g('st1')] };
  }
  writeOtadata(o) { fs.writeFileSync(path.join(this.state, 'otadata.txt'), `boot=${o.boot}\nst0=${o.st[0]}\nst1=${o.st[1]}\n`); }
  imageOk(i) { const f = this.slotFile(i); if (!fs.existsSync(f)) return false; const b = fs.readFileSync(f); return b.length >= 24 && b[0] === 0xe9; }
  /** varian yang ada di slot i */
  slotVariant(i) {
    if (!this.imageOk(i)) return null;
    const m = /SIMBIN:([a-z0-9_]+);/.exec(fs.readFileSync(this.slotFile(i)).toString('latin1'));
    return m ? m[1] : null;
  }
  /** upload lewat USB: slot 0 diisi, otadata kembali ke awal, NVS TIDAK dihapus */
  usbFlash(variant, version, product = 'fireguard-bridge') {
    const img = makeImage(path.join(this.images, `${variant}.ino.bin`), variant, product, version);
    fs.copyFileSync(img, this.slotFile(0));
    fs.writeFileSync(this.slotFile(1), Buffer.alloc(0));
    this.writeOtadata({ boot: 0, st: [ST.UNDEF, ST.UNDEF] });
  }
  image(variant, version, product = 'fireguard-bridge') {
    return makeImage(path.join(this.images, `${variant}.ino.bin`), variant, product, version);
  }
  /** meniru bootloader ESP-IDF (rollback aktif), lalu menjalankan firmware di slot terpilih */
  boot(env = {}) {
    const o = this.readOtadata();
    let b = o.boot;
    if (o.st[b] === ST.PENDING) { o.st[b] = ST.ABORTED; b = 1 - b; }      // boot sebelumnya tidak sempat menyatakan sah
    else if (o.st[b] === ST.NEW) o.st[b] = ST.PENDING;
    if (o.st[b] === ST.INVALID || o.st[b] === ST.ABORTED || !this.imageOk(b)) b = 1 - b;
    o.boot = b;
    this.writeOtadata(o);
    const v = this.slotVariant(b);
    if (!v || !this.variants[v]) throw new Error(`slot ${b} berisi varian tak dikenal: ${v}`);
    this.boots.push(v);
    return new Session(this.variants[v], { SIM_STATE: this.state, SIM_SERVER: this.server, SIM_RUNNING: String(b), SIM_STA: '1', ...this.env, ...env });
  }
  /** jalankan boot-boot berikutnya sampai firmware berjalan stabil (tidak restart) selama ms */
  async bootUntilStable(ms = 40000, maxBoots = 8, before = []) {
    let s;
    for (let i = 0; i < maxBoots; i++) {
      s = this.boot();
      await s.run('INIT', ...before, `T ${ms}`);
      if (!s.exit) return s;
    }
    throw new Error(`firmware tidak pernah stabil (boot: ${this.boots.join(' > ')})`);
  }
  /** terbitkan lewat publish_fw.py asli. fwVersion = versi yang tertulis DI DALAM file (bawaan sama) */
  publish(variant, version, args = [], { product = 'fireguard-bridge', fwVersion = version, base = BASE } = {}) {
    const img = this.image(variant, fwVersion, product);
    if (fwVersion !== version) args = ['--version', version, ...args];
    return execFileSync('python3', ['-I', publishPy, '--root', this.server, '--group', 'kel04', '--base-url', base, '--bin', img, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  manifestPath(product = 'fireguard-bridge') { return path.join(this.server, 'kel04', `manifest-${product}.json`); }
  readManifest(product) { return JSON.parse(fs.readFileSync(this.manifestPath(product), 'utf8')); }
  writeManifest(m, product) { fs.writeFileSync(this.manifestPath(product), JSON.stringify(m, null, 2)); }
  nvsState() {
    // ota::OtaState disimpan mentah; cukup ambil teks-teks pentingnya
    const f = path.join(this.state, 'nvs_ota_st.bin');
    if (!fs.existsSync(f)) return null;
    const b = fs.readFileSync(f);
    const str = (off, len) => { const s = b.subarray(off, off + len); const z = s.indexOf(0); return s.subarray(0, z < 0 ? len : z).toString('latin1'); };
    // urutan field sama dengan ota::OtaState di ota_core.h
    let o = 0;
    const magic = b[o]; o += 1;
    const pending = str(o, 16); o += 16;
    const attempts = b[o]; o += 1;
    const black = str(o, 16); o += 16;
    const good = str(o, 16); o += 16;
    o += 17 + 17 + 16;                      // pendHash, prevHash, prevVer
    const src = str(o, 6); o += 6;
    const lastSt = str(o, 12); o += 12;
    const lastVer = str(o, 16); o += 16;
    const lastMsg = str(o, 120);
    return { magic, pending, attempts, black, good, src, lastSt, lastVer, lastMsg };
  }
  cleanup() { fs.rmSync(this.dir, { recursive: true, force: true }); }
}

export function keygen(keyFile, headerFile) {
  return execFileSync('python3', ['-I', keygenPy, '--key', keyFile, '--header', headerFile], { encoding: 'utf8' });
}

/** baris Root CA ISRG X1 asli yang berbeda di sertifikat palsu (UJI_ROOT_CA_SALAH) */
export function tlsNeedle() {
  const t = fs.readFileSync(path.join(sketchDir, 'root_ca.h'), 'utf8');
  const real = /R"PEM\((-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----)/.exec(t)[1].split('\n');
  const fakeStart = t.indexOf('ROOT_CA_SALAH_PEM');
  const fake = /R"PEM\((-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----)/.exec(t.slice(fakeStart))[1].split('\n');
  const i = real.findIndex((l, k) => l !== fake[k]);
  return real[i];
}

export function mbedtlsAvailable() {
  try {
    execFileSync('sh', ['-c', 'echo "#include <mbedtls/sha256.h>" | g++ -x c++ -fsyntax-only -'], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}
