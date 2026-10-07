# Protokol komunikasi

Dokumen ini menjelaskan "bahasa" yang dipakai dashboard, ESP, dan Arduino Uno. Kalau Anda mau
menambah fitur (misalnya sensor baru), baca ini dulu supaya ketiganya tetap nyambung.

```
Dashboard  <--WebSocket / MQTT-->  ESP bridge  <--Serial 57600-->  Arduino Uno
```

Prinsipnya sengaja dibuat sederhana:

- **Dashboard → robot**: teks satu baris, mis. `DRV 20 80`. Gampang diurai di Uno tanpa library.
- **Robot → dashboard**: JSON satu baris (diakhiri `\n`). Uno mencetaknya langsung pakai `Serial.print`.
- **ESP bridge hanya meneruskan.** Satu-satunya yang dijawab sendiri oleh ESP adalah `PING`,
  dan ia menambahkan pesan `bridge` berisi alamat IP dan kekuatan sinyal.

## Perintah (dashboard → robot)

| Perintah | Arti | Catatan |
|---|---|---|
| `PING <n>` | Ukur latensi | Dijawab ESP: `{"t":"pong","n":<n>,...}` |
| `INFO` | Minta info robot | Dijawab ESP (`bridge`) dan Uno (`info` + telemetri) |
| `GET` | Minta satu telemetri sekarang | Dikirim dashboard begitu tersambung |
| `MODE A` / `MODE M` | Otomatis / Manual | Robot membalas dengan telemetri baru |
| `DRV <x> <y>` | Gerak manual. x: kanan+, y: maju+, masing-masing −100..100 | **Harus dikirim ulang < 600 ms sekali** (dead-man), dashboard mengirim 10×/detik |
| `SPD <n>` | Batas kecepatan manual, 0..255 | Dikirim dashboard saat tersambung dan saat slider digeser |
| `STOP` | Berhenti darurat: motor mati, pompa mati, masuk mode manual | |
| **FireGuard** | | |
| `PUMP 1` / `PUMP 0` | Pompa manual | `PUMP 1` juga harus diulang < 600 ms sekali, kalau tidak pompa mati sendiri |
| `NOZ <sudut>` | Arah nozzle manual | Dibatasi `NOZ_MIN..NOZ_MAX` di firmware |
| **EcoBot (penyapu)** | | |
| `BRUSH <persen>` | Motor sapu, 0..100 (0 = mati) | Nilai > 0 di bawah `BRUSH_MIN_PCT` (35) dinaikkan ke 35. Kecepatan naik pelan (soft-start) |
| `LIFT 1` / `LIFT 0` | Angkat / turunkan sapu (servo) | |

Perintah `DRV`, `PUMP`, `NOZ`, `BRUSH`, `LIFT` **diabaikan di mode otomatis**. Perintah yang tidak dikenal
atau kepanjangan (> 31 karakter) dibuang tanpa efek apa pun.

## Pesan dari robot (robot → dashboard)

Semua pesan punya field `t` (jenis).

### `info` — dikirim Uno saat menyala dan saat diminta (`INFO`)

FireGuard:

```json
{"t":"info","robot":"fireguard","fw":"1.0.0",
 "flame":["Kiri","Kanan"],"flamePins":["A0","A1"],
 "gas":["MQ-2"],"gasPins":["A3"],
 "th":{"fw":700,"fd":400,"gw":350,"gd":550},
 "noz":{"min":40,"max":140,"home":90},"pump":1}
```

Jumlah elemen `flame` dan `gas` menentukan berapa kartu sensor yang muncul di dashboard.
Jadi mengganti `FLAME_COUNT` di firmware sudah cukup, dashboard tidak perlu diubah.

EcoBot (penyapu):

```json
{"t":"info","robot":"ecobot","kind":"sweeper","fw":"2.0.0",
 "us":["Depan","Kiri-depan","Kanan-depan","Kiri","Kanan","Wadah"],
 "pins":["A0","A1","A2","A3","A4","D13"],
 "th":{"det":50,"near":20,"side":10,"binE":20,"binF":4},
 "lift":{"up":80,"down":20},
 "brush":{"pwm":1,"min":35,"auto":70}}
```

`brush.pwm` 0 berarti motor sapu memakai relay (hanya nyala/mati), dan dashboard menyembunyikan slider kecepatan sapu.

### `tel` — telemetri, dikirim Uno 4× per detik

Field yang sama di kedua robot:

| Field | Arti |
|---|---|
| `up` | detik sejak Uno menyala |
| `m` | `"A"` otomatis, `"M"` manual |
| `st` | status singkat (lihat tabel di bawah) |
| `sp` | kecepatan motor sekarang, 0..255 |
| `cap` | batas kecepatan manual yang aktif |
| `bat` | tegangan baterai dalam mV. **Hanya ada kalau `HAS_BATTERY_SENSE 1`** |

**FireGuard**

| Field | Arti |
|---|---|
| `fl` | nilai ADC sensor api, urut sesuai `info.flame`. **Nilai kecil = api kuat** |
| `fs` | level tiap sensor api: 0 aman, 1 waspada, 2 bahaya |
| `gs` | nilai ADC sensor gas. **Nilai besar = gas tinggi** |
| `gl` | level tiap sensor gas (0/1/2) |
| `gw` | 1 selama MQ-2 masih pemanasan (level dipaksa 0) |
| `p` | 1 kalau pompa benar-benar menyala |
| `na` | sudut servo nozzle sekarang |

`st`: `idle` siaga · `turn` mengarah ke api · `approach` mendekati api · `spray` menyemprot · `rest` jeda pompa · `manual`

**EcoBot (penyapu)**

| Field | Arti |
|---|---|
| `d` | jarak 6 sensor dalam cm, urut `info.us`. `-1` = tidak ada pantulan / di luar jangkauan. Elemen ke-6 adalah jarak sensor Wadah ke permukaan sampah |
| `l` | level 6 sensor: 0 kosong, 1 terdeteksi (≤ `det`), 2 dekat (≤ `near`, untuk Kiri/Kanan ≤ `side`). Elemen ke-6 selalu 0 |
| `bin` | kapasitas wadah 0..100 (dihitung Uno dari jarak sensor Wadah) |
| `br` | kecepatan sapu sekarang, 0..100 (naik pelan menuju `bt`) |
| `bt` | kecepatan sapu yang diminta, 0..100 |
| `lf` | 1 = sapu diperintah terangkat, 0 = turun |
| `la` | sudut servo pengangkat sekarang |
| `sw` | total detik sapu berputar sejak Uno menyala |

`st`: `sweep` menyapu · `avoid` mundur & berbelok menghindari rintangan · `turn` belok acak · `full` wadah penuh · `manual`

### `bridge` — dikirim ESP saat klien tersambung dan saat `INFO`

```json
{"t":"bridge","robot":"fireguard","fw":"1.0.0","ip":"192.168.1.20","rssi":-55,"mode":"sta"}
```

### `pong` — jawaban ESP untuk `PING`

```json
{"t":"pong","n":123456,"rssi":-55,"up":3600}
```

Dashboard mengirim `PING <performance.now()>` tiap 2 detik; selisih waktunya adalah latensi yang tampil di kartu Status Sistem.

## MQTT

Format pesannya sama persis, hanya dibungkus topik:

| Topik | Arah | Isi |
|---|---|---|
| `<prefix>/<robot>/cmd` | dashboard → robot | perintah teks, satu per pesan |
| `<prefix>/<robot>/tel` | robot → dashboard | JSON (`tel`, `info`, `bridge`, `pong`) |
| `<prefix>/<robot>/status` | ESP → semua | `online` / `offline` (retained; `offline` dikirim broker lewat *last will* kalau ESP mati mendadak) |

`<robot>` adalah `fireguard` atau `ecobot`. `<prefix>` default `kopak`. Kalau memakai broker publik, **ganti prefix
dengan yang unik**, karena siapa pun yang tahu topiknya bisa membaca telemetri dan mengirim perintah.

## Status koneksi di dashboard

| Tampilan | Artinya |
|---|---|
| Demo | robot virtual di browser |
| Terhubung | tersambung ke ESP **dan** telemetri dari Uno masih segar (< 3 detik) |
| Robot belum merespons | ESP tersambung, tapi tidak ada telemetri dari Uno. Hampir selalu kabel TX/RX atau baud rate |
| Robot offline | (MQTT) broker melaporkan ESP sudah putus |
| Menyambung… | sedang mencoba / menyambung ulang (jeda makin lama, maks 10 detik) |
| Terputus / Belum dikonfigurasi | mode langsung belum diisi alamat, atau diputus |

## Pengaman yang sudah ada

- **Dead-man gerak**: Uno menghentikan motor kalau `DRV` tidak diperbarui selama 600 ms.
- **Dead-man pompa**: pompa manual mati kalau `PUMP 1` tidak diperbarui selama 600 ms.
- Dashboard mengirim `DRV 0 0` beberapa kali saat joystick dilepas, tab disembunyikan, jendela kehilangan fokus, atau halaman ditutup.
- ESP mengirim `DRV 0 0` dan `BRUSH 0` ke Uno saat klien WebSocket terputus (FireGuard mengabaikan `BRUSH`).
- Pompa dibatasi 15 detik menyala terus, lalu jeda 3 detik (`PUMP_MAX_ON_MS`, `PUMP_REST_MS`).
- Servo digerakkan bertahap (bukan lompat) supaya arus tidak melonjak dan me-reset Uno.
- Mode manual EcoBot menahan gerak maju kalau ada benda ≤ 6 cm di depan atau serong depan.
- EcoBot: motor sapu dinaikkan pelan (soft-start) dan baru berputar setelah sapu turun (mode otomatis).
