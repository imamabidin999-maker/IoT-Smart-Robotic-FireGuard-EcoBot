#!/usr/bin/env node
/*
  mock-robot — robot palsu untuk mencoba & menguji dashboard tanpa hardware.

  Meniru apa yang dilakukan robot asli:
    - ESP bridge: WebSocket (bawaan port 8081/8082), jawab PING, kirim pesan "bridge", terusi perintah ke robot,
      kirim "DRV 0 0" kalau klien putus (sama seperti firmware bridge)
    - MQTT (opsional): broker kecil yang bisa dipakai dashboard lewat WebSocket, topik <prefix>/<robot>/{cmd,tel,status}
    - Kamera ESP32-CAM: /stream (MJPEG), /status, /capture, /led, /res
    - Otak robotnya: simulator yang sama dengan mode Demo di dashboard

  Pakai:
    npm install
    node index.js fireguard                      # WebSocket :8081, kamera :8091
    node index.js ecobot --mqtt                  # + broker MQTT (WebSocket :9001), prefix "kopak"
    node index.js fireguard --ws 8085 --cam 8095 --mqtt --mqtt-ws 9005 --prefix kelompok7

  Di dashboard: Pengaturan -> Langsung -> Alamat robot "127.0.0.1:8081", alamat kamera "127.0.0.1:8091".
*/
'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const { WebSocketServer } = require('ws');

// Satu frame JPEG kecil (320x240) yang diulang-ulang sebagai "video".
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCADwAUADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDhqKKKokKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAFopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAFooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAHUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAC0UtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFAC0UUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUVe0eCK51SGGdd0bbsjJGflJ7VMpcqbfQTdlco0VvTyaBBPJC9jOWjYqSGOMg4/vUz7T4e/58bj/vo/8AxVZKtf7L/r5ke08mYlFbf2nw9/z43H/fR/8AiqPtPh7/AJ8bj/vo/wDxVP2r/lf9fMfP5MxKK2/tPh7/AJ8bj/vo/wDxVH2nw9/z43H/AH0f/iqPav8Alf8AXzDn8mYlFbf2nw9/z43H/fR/+Ko+0+Hv+fG4/wC+j/8AFUe1f8r/AK+Yc/kzEorb+0+Hv+fG4/76P/xVH2nw9/z43H/fR/8AiqPav+V/18w5/JmJRW39p8Pf8+Nx/wB9H/4qj7T4e/58bj/vo/8AxVHtX/K/6+Yc/kzEorU8QWkFnfJHbR7EMQYjJPOT6/SsutISU4qSKjLmV0FFFFUMKKKKACiiigAooooAKKKKACiiigB1FFFABRRRQAUUUUAFFFFABRRRQAUUUUAFaPh//kNW/wDwL/0E1nVo+H/+Q1b/APAv/QTWdX+HL0ZM/hZW1H/kJXX/AF2f+ZqvVnUf+Qldf9dn/marVUPhQ47IKKKKoYUUUUAFFFFABRRRQAUUUUAbPir/AJCUf/XEfzasatrxT/yEo/8AriP5tWLWOH/hRIpfAgooorYsKKKKACiiigAooooAKKKKACiiigBaKWigBKKWigBKKWigBKKWigBKKWigBKKWigBK0dA/5DNv/wAC/wDQTWfWjoH/ACGYP+Bf+gms6v8ADl6Mmfwsq6j/AMhK6/67P/M1XqzqP/ISuv8Ars/8zW7b6VZSalp26HNs8MQnXcfmdgnOc5HMq9Peqh8KHHZHM0VsRW1r9rtbBrcMbhIyZ9zblLgEEDOMDI6jsfwhv47aCW6tEtTutztEykksQQCW5xg9sAdqoZm0Vu6jpcEGrJYRqF+0XJCyBsiNN5UKOeSO+fYeuaLrDdkRW1mYZDMsaEMxBByMNk/e4HTHfigChRXSLpdk93OEjUxPbHydsu4LJ5ioDkE+oJH+1WdqFpDb6VYuiYndnErZPPCMvH0egDMopaKAEopaKANjxT/yEo/+uI/maxq2vFH/ACEo/wDriP5msascP/CiRS+BCUUtFbFiUUtFACUUtFACUUtFACUUtFACUUtFAC0UUUAFFFFABRRRQAUUUUAFFFFABRRRQAVoaD/yGYP+Bf8AoJrPrR0H/kMQf8C/9BNZ1f4cvRkz+FlbUf8AkI3X/XZ/5mnpql6m3bPja0bD5RwUAC9uwA+uOaZqH/IRuv8Ars/8zVeqh8KHHZFlL+5SERLIu0KVB2KWUHqA2Mgcnv3pJb65mh8qSQFSACQgDMB0yQMn8ar0VQyxNe3M+/zZS2+UzHgD5z1I9M+3oPSnvqV27q5kUMG3ZWNVy2MZOByfc81UooAnivbiGAwRybYyc4wPVT169UX8qLm8uLr/AF8m752k+6B8zAA9P90ce1QUUAFFFFABRRRQBseKP+QjH/1xH8zWPWz4n/5CMf8A1xH8zWNWOH/hRIpfAgooorYsKKKKACiiigAooooAKKKKACiiigB1FFFABRRRQAUUUUAFFFFABRRRQAUUUUAFaGg/8hiD/gX/AKCaz60NC/5DEH/Av/QTWdX+HL0ZM/hZX1D/AJCNz/11f+ZqvVjUP+Qjc/8AXV/5mq9VD4UOOyCiiiqGFFFFABRRRQAUUUUAFFFFAGx4n/5CMf8A1yH8zWPWx4m/5CMf/XIfzNY9Y4f+FEil8CCiiitiwooooAKKKKACiiigAooooAKKKKAFopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEq/oX/IYg/wCBf+gmqNTWlw9pcpPGFLJnAbpyMVFROUGkKSvFoXUP+Qjc/wDXV/5mq9bH/CQ3n/POD/vk/wCNH/CQ3n/POD/vk/41mpVUrcv4/wDAITmlt+Jj0Vsf8JDef884P++T/jR/wkN5/wA84P8Avk/40+er/L+P/AHzT7fiY9FbH/CQ3n/POD/vk/40f8JDef8APOD/AL5P+NHPV/l/H/gBzT7fiY9FbH/CQ3n/ADzg/wC+T/jR/wAJDef884P++T/jRz1f5fx/4Ac0+34mPRWx/wAJDef884P++T/jR/wkN5/zzg/75P8AjRz1f5fx/wCAHNPt+Jj0Vsf8JDef884P++T/AI0f8JDef884P++T/jRz1f5fx/4Ac0+34ieJv+QjH/1yH8zWRVq+vZL6YSyqgYLt+UHGOf8AGq1VSi4wUWOCaikxKKWitChKKWigBKKWigBKKWigBKKWigBKKWigBaKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigBaKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBaKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBaKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==', 'base64');

function start(opts) {
  const robot = opts.robot;
  const simModule = require(path.join(__dirname, '..', '..', robot, 'sim.js'));
  const log = opts.quiet ? () => {} : (...a) => console.log(`[mock-${robot}]`, ...a);

  const handle = {
    robot,
    received: [],                      // semua perintah yang diterima dari dashboard: {t, line, via}
    clients: new Set(),
    muteTel: false,                    // true = robot "diam": telemetri tidak dikirim (untuk menguji status "belum merespons")
    cam: { stall: false, down: false, streams: 0, frames: 0, led: 0, size: 'vga', statusHits: 0 },
    closers: [],
  };

  // ---------- otak robot ----------
  const publishers = [];
  handle.sim = simModule.factory((line) => {
    if (handle.muteTel && line.indexOf('"t":"tel"') >= 0) return;
    publishers.forEach((fn) => fn(line));
  });
  const sendToSim = (line, via) => {
    handle.received.push({ t: Date.now(), line, via });
    if (handle.received.length > 2000) handle.received.splice(0, 500);
    handle.sim.handle(line);
  };
  const bridgeInfo = () => JSON.stringify({ t: 'bridge', robot, fw: '1.0.0-mock', ip: '127.0.0.1', rssi: -48, mode: 'sta' });
  const pong = (n) => JSON.stringify({ t: 'pong', n, rssi: -48, up: Math.floor(process.uptime()) });

  // ---------- WebSocket (ESP bridge) ----------
  const wss = new WebSocketServer({ port: opts.ws });
  publishers.push((line) => { wss.clients.forEach((c) => { if (c.readyState === 1) c.send(line); }); });
  wss.on('connection', (sock) => {
    handle.clients.add(sock);
    sock.send(bridgeInfo());
    sock.on('message', (data) => {
      const text = data.toString().trim();
      if (!text) return;
      if (/^PING\b/.test(text)) { sock.send(pong(Number(text.split(/\s+/)[1]) || 0)); return; }
      if (text === 'INFO') sock.send(bridgeInfo());
      sendToSim(text, 'ws');
    });
    sock.on('close', () => { handle.clients.delete(sock); sendToSim('DRV 0 0', 'ws-close'); });
    sock.on('error', () => {});
  });
  handle.closers.push(() => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(r); }));
  log(`WebSocket  ws://127.0.0.1:${opts.ws}`);

  // ---------- MQTT (opsional) ----------
  if (opts.mqttWs || opts.mqttTcp) {
    const aedes = require('aedes')();
    const wsStream = require('websocket-stream');
    const base = `${opts.prefix}/${robot}`;
    aedes.subscribe(`${base}/cmd`, (packet, cb) => {
      const text = packet.payload.toString().trim();
      if (/^PING\b/.test(text)) publishMqtt(pong(Number(text.split(/\s+/)[1]) || 0));
      else { if (text === 'INFO') publishMqtt(bridgeInfo()); sendToSim(text, 'mqtt'); }
      cb();
    }, () => {});
    const publishMqtt = (line) => aedes.publish({ cmd: 'publish', qos: 0, retain: false, dup: false, topic: `${base}/tel`, payload: Buffer.from(line) }, () => {});
    publishers.push(publishMqtt);
    aedes.publish({ cmd: 'publish', qos: 0, retain: true, dup: false, topic: `${base}/status`, payload: Buffer.from('online') }, () => {});
    handle.aedes = aedes;

    if (opts.mqttWs) {
      const srv = http.createServer();
      const socks = new Set();               // koneksi yang sudah di-upgrade ke WebSocket tidak dilacak http.Server
      srv.on('connection', (sk) => { socks.add(sk); sk.on('close', () => socks.delete(sk)); });
      wsStream.createServer({ server: srv }, aedes.handle);
      srv.listen(opts.mqttWs);
      handle.closers.push(() => new Promise((r) => { socks.forEach((sk) => sk.destroy()); srv.close(r); }));
      log(`MQTT (WebSocket) ws://127.0.0.1:${opts.mqttWs}  topik ${base}/{cmd,tel,status}`);
    }
    if (opts.mqttTcp) {
      const tcp = net.createServer(aedes.handle);
      tcp.listen(opts.mqttTcp);
      handle.closers.push(() => new Promise((r) => { tcp.close(r); }));
      log(`MQTT (TCP) mqtt://127.0.0.1:${opts.mqttTcp}`);
    }
    handle.closers.unshift(() => new Promise((r) => aedes.close(r)));   // putus semua klien MQTT lebih dulu
  }

  // ---------- kamera palsu ----------
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  let fps = 0, lastFrames = 0;
  const fpsTimer = setInterval(() => { fps = handle.cam.frames - lastFrames; lastFrames = handle.cam.frames; }, 1000);
  const camServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (handle.cam.down) { req.socket.destroy(); return; }
    if (url.pathname === '/stream') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'multipart/x-mixed-replace;boundary=kopakframe' }, cors));
      handle.cam.streams++;
      const timer = setInterval(() => {
        if (handle.cam.stall) return;                       // simulasi stream macet: tidak ada frame baru
        res.write(`\r\n--kopakframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`);
        res.write(JPEG);
        handle.cam.frames++;
      }, 100);
      req.on('close', () => { clearInterval(timer); handle.cam.streams--; });
      return;
    }
    if (url.pathname === '/status') {
      handle.cam.statusHits++;
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify({ fps, frames: handle.cam.frames, size: handle.cam.size, rssi: -50, heap: 123456, psram: true, led: handle.cam.led, up: Math.floor(process.uptime()) }));
      return;
    }
    if (url.pathname === '/capture') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'image/jpeg' }, cors));
      res.end(JPEG);
      return;
    }
    if (url.pathname === '/led') {
      if (url.searchParams.has('on')) handle.cam.led = url.searchParams.get('on') === '1' ? 1 : 0;
      res.writeHead(200, cors); res.end(handle.cam.led ? 'on' : 'off');
      return;
    }
    if (url.pathname === '/res') {
      const size = url.searchParams.get('size');
      if (['qvga', 'vga', 'svga'].includes(size)) handle.cam.size = size;
      res.writeHead(200, cors); res.end(handle.cam.size);
      return;
    }
    res.writeHead(404, cors); res.end('not found');
  });
  camServer.listen(opts.cam);
  handle.closers.push(() => new Promise((r) => { clearInterval(fpsTimer); camServer.closeAllConnections && camServer.closeAllConnections(); camServer.close(r); }));
  log(`Kamera     http://127.0.0.1:${opts.cam}  (/stream /status /capture /led /res)`);

  handle.close = async () => {
    handle.sim.stop();
    for (const c of handle.closers) {
      // setiap penutupan diberi batas waktu supaya pengujian tidak pernah menggantung
      try { await Promise.race([c(), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* abaikan */ }
    }
  };
  return handle;
}

module.exports = { start };

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const robot = (args[0] || 'fireguard').toLowerCase();
  if (!['fireguard', 'ecobot'].includes(robot)) {
    console.error('Pakai: node index.js <fireguard|ecobot> [--ws PORT] [--cam PORT] [--mqtt] [--mqtt-ws PORT] [--mqtt-tcp PORT] [--prefix AWALAN]');
    process.exit(1);
  }
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const wsDefault = robot === 'fireguard' ? 8081 : 8082;
  const wantMqtt = args.includes('--mqtt') || args.includes('--mqtt-ws') || args.includes('--mqtt-tcp');
  start({
    robot,
    ws: parseInt(opt('--ws', wsDefault), 10),
    cam: parseInt(opt('--cam', wsDefault + 10), 10),
    mqttWs: wantMqtt ? parseInt(opt('--mqtt-ws', 9001), 10) : 0,
    mqttTcp: args.includes('--mqtt-tcp') ? parseInt(opt('--mqtt-tcp', 1883), 10) : 0,
    prefix: opt('--prefix', 'kopak'),
  });
}
