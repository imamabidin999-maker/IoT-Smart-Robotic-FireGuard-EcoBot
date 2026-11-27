// Uji unit logika OTA (firmware/esp_bridge/ota_core.h + ota_crypto.h) dan kecocokan tanda tangan
// tools/ota/otasign.py (Python) dengan mbedTLS (yang dipakai ESP32).
// Jalankan:  node --test tests/bridge-host/core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { here, root, sketchDir, buildDir, findArduinoJson, mbedtlsAvailable } from './sim.mjs';

const skip = mbedtlsAvailable() ? false : 'libmbedtls-dev belum terpasang (sudo apt install libmbedtls-dev)';

test('ota_core: versi, hex, penanda FWID, manifest, syarat update, health check, keputusan boot, tanda tangan', { skip }, async () => {
  const aj = await findArduinoJson();
  fs.mkdirSync(buildDir, { recursive: true });
  const bin = path.join(buildDir, 'core_test');
  execFileSync('g++', ['-std=c++17', '-O1', '-Wall', '-Wno-format-truncation', '-I', sketchDir, '-I', aj,
    path.join(here, 'core_test.cpp'), '-lmbedcrypto', '-o', bin], { stdio: 'pipe' });

  // pasangan kunci + tanda tangan dari alat Python
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-core-'));
  const msg = 'KOPAK-OTA1|fireguard-bridge|esp32|1.2.0|123456|' + 'ab'.repeat(32);
  const py = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'tools', 'ota'))})
import otasign
d, Q = otasign.generate()
open(${JSON.stringify(path.join(dir, 'pub.pem'))}, 'w').write(otasign.public_pem(Q))
print(otasign.sign(d, ${JSON.stringify(msg)}.encode()).hex())
`;
  const sig = execFileSync('python3', ['-I', '-c', py], { encoding: 'utf8' }).trim();
  const out = execFileSync(bin, [path.join(dir, 'pub.pem'), msg, sig], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(out.trim(), 'OK');
});
