// Pembantu untuk uji end-to-end dashboard.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const pageUrl = (robot) => pathToFileURL(path.join(ROOT, robot, 'index.html')).href;
export const SHOTS = path.join(here, 'screenshots');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;     // pakai browser bawaan Playwright kalau sudah di-install
}

export function launch() {
  return chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
}

/** Mengumpulkan semua hal yang seharusnya tidak muncul: error/warning konsol, error halaman, request gagal, HTTP >= 400. */
export class Watch {
  constructor(page, allow = []) {
    this.items = [];
    this.allow = allow.map((a) => (a instanceof RegExp ? a : new RegExp(a)));
    const add = (kind, text) => { if (!this.allow.some((re) => re.test(text))) this.items.push(`${kind}: ${text}`); };
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') add('console.' + m.type(), m.text()); });
    page.on('pageerror', (e) => add('pageerror', e.message));
    page.on('requestfailed', (r) => add('requestfailed', `${r.url()} ${(r.failure() || {}).errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) add('http ' + r.status(), r.url()); });
  }
  assertClean(assert, label) {
    assert.deepEqual(this.items, [], `${label || 'halaman'} seharusnya bersih dari error, tapi ada:\n  ${this.items.join('\n  ')}`);
  }
  clear() { this.items = []; }
}

/**
 * Buka dashboard.
 * @param {object} o {viewport, cfg (disimpan ke localStorage sebelum halaman jalan), allow, blockStorage}
 */
export async function openDashboard(browser, robot, o = {}) {
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1440, height: 900 },
    acceptDownloads: true,
    deviceScaleFactor: 1,
    hasTouch: !!o.touch,
    isMobile: !!o.touch,
  });
  if (o.cfg) {
    await ctx.addInitScript(([key, value]) => {
      try { if (!localStorage.getItem(key)) localStorage.setItem(key, value); } catch (e) { /* abaikan */ }
    }, [`kopak.${robot}.cfg.v1`, JSON.stringify(o.cfg)]);
  }
  if (o.blockStorage) {
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('diblokir', 'SecurityError'); } });
    });
  }
  const page = await ctx.newPage();
  const watch = new Watch(page, o.allow || []);
  await page.goto(o.url || pageUrl(robot));
  return { ctx, page, watch };
}

export const dashVar = (robot) => `window.${robot}`;

/** Pasang "penyadap" di link.send supaya perintah yang dikirim dashboard bisa diperiksa. */
export async function spySend(page, robot) {
  await page.evaluate((r) => {
    const d = window[r];
    const orig = d.link.send.bind(d.link);
    window.__sent = [];
    d.link.send = (line) => { window.__sent.push(line); return orig(line); };
  }, robot);
}
export const sent = (page) => page.evaluate(() => window.__sent.slice());
export const clearSent = (page) => page.evaluate(() => { window.__sent.length = 0; });

export async function waitMode(page, mode, timeout = 4000) {
  const id = mode === 'A' ? '#btnAuto' : '#btnManual';
  await page.waitForFunction((sel) => document.querySelector(sel).getAttribute('aria-pressed') === 'true', id, { timeout });
}

export async function setManual(page) {
  await page.click('#btnManual');
  await waitMode(page, 'M');
  await page.waitForFunction(() => !document.getElementById('joyBase').classList.contains('disabled'));
}

export const text = (page, sel) => page.locator(sel).first().innerText();

export async function joystickCenter(page) {
  const box = await page.locator('#joyBase').boundingBox();
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2, r: box.width / 2 };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
