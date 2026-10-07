# Wiring dan daya

Tabel pin di sini **sama dengan konstanta di bagian KONFIGURASI** tiap sketch. Kalau Anda memindah kabel,
ubah angkanya di sketch, bukan di dashboard.

> Catatan jujur: firmware sudah lolos kompilasi untuk Arduino Uno dan diuji logikanya di komputer
> (lihat README, bagian Pengujian). **Wiring dan sketch ESP belum pernah saya coba di perangkat
> kerasnya.** Kalau ada yang tidak cocok dengan rangkaian Anda, pin di bawah mudah diganti.

## 1. Daya (bagian yang paling sering bikin masalah)

Baterai 18650 itu 3,7 V per sel (4,2 V saat penuh). **Satu sel saja tidak cukup**: L298N memakan
sekitar 2 V, jadi motor hanya kebagian ±1,7 V, dan Uno butuh minimal ±7 V di pin VIN.
Pakai **2 sel seri (7,4 V, penuh 8,4 V)** dengan holder dan proteksi (BMS 2S).

```
Baterai 2S (7,4 V) ──► saklar ──┬─► L298N terminal +12V  (motor roda)
                                ├─► Uno pin VIN          (Uno punya regulator sendiri)
                                ├─► COM relay motor sapu (khusus EcoBot)
                                └─► Buck converter 5 V ≥ 2 A ──► ESP32, ESP32-CAM, servo, MQ-2, relay
                                    (FireGuard: pakai buck ≥ 3 A, karena pompa juga ambil daya dari sini)
GND baterai = GND L298N = GND Uno = GND buck = GND ESP = GND relay (semua GND harus disatukan)
```

- **Jangan** menyuplai ESP32, ESP32-CAM, servo, atau MQ-2 dari pin 5 V Uno. Regulator Uno tidak kuat
  (MQ-2 saja memakan ±150 mA untuk pemanasnya, servo dan WiFi ESP menarik arus lonjakan).
  Gejalanya: Uno restart sendiri saat servo bergerak atau ESP menyambung WiFi.
- ESP32-CAM sangat sensitif. Pasang kapasitor 470 µF (atau lebih) dekat pin 5V-nya. "Brownout detector
  was triggered" di Serial Monitor = daya kurang, bukan salah kode.
- Jumper 5V di L298N boleh dibiarkan terpasang (dia hanya dipakai sebagai regulator internal modul), tapi
  jangan ambil 5 V dari situ untuk beban lain.
- Persen baterai di dashboard butuh pembagi tegangan (bagian 7). Tanpa itu, kolom baterai menampilkan "—".

## 2. L298N — driver motor roda (sama untuk kedua robot)

Satu modul L298N punya dua channel. Channel A untuk roda **kiri**, channel B untuk roda **kanan**.
Robot 4WD: dua motor di sisi yang sama dipasang **paralel** ke satu channel. Robot 2WD (seperti robot sapu
di gambar Anda): satu motor per channel. Kode untuk 4WD dan 2WD sama persis.

```
              ┌──────────── L298N ────────────┐
Motor kiri  ──┤ OUT1  OUT2          OUT3  OUT4 ├── Motor kanan
              │                                │
Baterai + ────┤ +12V                           │
GND bersama ──┤ GND                            │
  (biarkan)   │ 5V    (jangan dipakai beban)    │
              │                                │
Uno D5 ───────┤ ENA  ← cabut jumper-nya dulu!  │
Uno D7 ───────┤ IN1                            │
Uno D8 ───────┤ IN2                            │
Uno D9 ───────┤ IN3                            │
Uno D10 ──────┤ IN4                            │
Uno D6 ───────┤ ENB  ← cabut jumper-nya dulu!  │
              └────────────────────────────────┘
```

- **Cabut jumper kecil di pin ENA dan ENB.** Dari pabrik, ENA/ENB dijumper ke 5 V supaya motor selalu jalan
  kecepatan penuh. Kalau jumper dibiarkan, slider "Batas kecepatan" di dashboard dan kecepatan pelan saat
  menyapu tidak akan berpengaruh. Setelah dicabut, sambungkan pin ENA ke D5 dan ENB ke D6.
- Jumper **5V-EN** (dekat terminal +12V) biarkan terpasang. Itu hanya untuk regulator internal modul.
- Kalau satu sisi berputar terbalik saat maju: tukar dua kabel motor di OUT sisi itu, atau ubah
  `INVERT_LEFT` / `INVERT_RIGHT` di sketch.
- L298N panas kalau motor sering tertahan. Wajar hangat, tapi kalau sampai terlalu panas disentuh, beri jeda.

## 3. FireGuard — Arduino Uno

| Komponen | Pin Uno | Keterangan |
|---|---|---|
| ESP (Serial) | D0 (RX), D1 (TX) | silang: TX Uno → RX ESP (lewat pembagi tegangan, bagian 5); RX Uno ← TX ESP |
| L298N ENA / IN1 / IN2 | D5 / D7 / D8 | sisi **kiri** (motor kiri depan + kiri belakang, dipasang paralel) |
| L298N ENB / IN3 / IN4 | D6 / D9 / D10 | sisi **kanan** |
| Sensor api 1 (Kiri) | A0 | pin **AO** modul |
| Sensor api 2 (Kanan) | A1 | pin **AO** modul |
| Sensor api 3 | A2 | hanya kalau `FLAME_COUNT 3`; urutannya jadi Kiri A0, **Depan A1**, **Kanan A2** |
| MQ-2 #1 | A3 | pin **AO** modul |
| MQ-2 #2 | A4 | hanya kalau `GAS_COUNT 2` |
| Baterai (pembagi tegangan) | A5 | opsional, `HAS_BATTERY_SENSE 1` |
| Servo nozzle | D11 | sinyal; merah ke 5 V buck, coklat/hitam ke GND |
| Pompa | D4 | ke pin **IN modul relay**, bukan ke pompa langsung |
| LED indikator | D13 (LED bawaan) | menyala saat api terdeteksi |

Urutan merakit dan cara kalibrasinya ada di [RAKIT-FIREGUARD.md](RAKIT-FIREGUARD.md).

### Pompa lewat modul relay

**Pompa dan pensaklarnya tidak ada di daftar komponen Anda**, jadi perlu dibeli: pompa celup mini DC 3–6 V
dan modul relay 1 kanal 5 V. Pompa tidak boleh disambung langsung ke pin Uno.

```
Modul relay
  VCC ◄── 5 V buck
  GND ◄── GND bersama
  IN  ◄── Uno D4
  COM ◄── 5 V buck   (pompa 6–12 V: dari baterai +)
  NO  ──► pompa (+)
  NC      tidak dipakai
pompa (−) ──► GND bersama
Dioda 1N4007 melintang di pompa: sisi bergaris (katoda) ke (+)
```

- Banyak modul relay 1 kanal (terutama yang memakai optocoupler) **aktif-LOW**. Untuk modul seperti itu ubah
  `PUMP_ACTIVE_HIGH` jadi `0`.
  Cara mengeceknya: begitu Uno menyala, LED relay harus mati. Kalau menyala, nilainya terbalik.
- Pompa di **NO**, bukan NC, supaya pompa mati selama relay tidak aktif.
- Pompa yang berputar kering cepat rusak. Pastikan terendam air sebelum diuji.
- Bisa juga memakai transistor TIP120 atau modul MOSFET dengan wiring seperti motor sapu EcoBot (bagian 4),
  cukup ganti D3 dengan D4. Untuk keduanya `PUMP_ACTIVE_HIGH` dibiarkan `1`.
- Pompa bisa diganti kipas (motor DC + baling-baling) di relay yang sama. Kipas cukup untuk api kecil seperti lilin.

### Sensor api dan gas

Sensor api (IR flame, 4 pin: VCC, GND, DO, AO): dipakai AO-nya, DO dibiarkan kosong. Pada kebanyakan modul,
potensio biru hanya mengatur kapan pin DO dan LED kecilnya menyala, **tidak mengubah angka AO**. Jadi
kalibrasinya lewat angka di sketch: `FLAME_WARN 700` (mulai mencari api) dan `FLAME_DANGER 400` (berhenti
dan menyemprot). Karena FireGuard tidak punya sensor rintangan, `FLAME_DANGER` sekaligus menentukan seberapa
dekat robot ke api; cara mengukurnya ada di RAKIT-FIREGUARD.md langkah 11. Sensor IR ini juga terpengaruh
cahaya matahari dan lampu pijar, jadi kalibrasi di tempat robot dipakai.

**Soal jumlah sensor:** dari daftar Anda ("flame sensor × 3, berjumlah 2" dan "MQ-2 sekitar 1 atau 2"),
bawaan sketch adalah **2 sensor api + 1 MQ-2**. Kalau ternyata 3 api atau 2 gas, cukup ubah
`FLAME_COUNT` / `GAS_COUNT` di sketch. Dashboard mengikuti sendiri.

MQ-2 perlu pemanasan sekitar 20 detik setiap dinyalakan (dashboard menampilkan "Pemanasan"), dan idealnya
dibakar-awal 24 jam saat pertama dipakai supaya pembacaan stabil. Nilai `GAS_WARN 350` / `GAS_DANGER 550`
hanya titik awal: catat nilai di udara bersih, lalu atur ambangnya.

## 4. EcoBot (robot penyapu) — Arduino Uno

| Komponen | Pin Uno | Keterangan |
|---|---|---|
| ESP (Serial) | D0 (RX), D1 (TX) | sama seperti FireGuard |
| L298N ENA / IN1 / IN2 | D5 / D7 / D8 | roda kiri (lihat bagian 2) |
| L298N ENB / IN3 / IN4 | D6 / D9 / D10 | roda kanan |
| Motor sapu | D3 | ke pin **IN** modul relay (atau basis TIP120 / SIG modul MOSFET), bukan langsung ke motor |
| Servo pengangkat sapu | D11 | sinyal; merah ke 5 V buck, coklat/hitam ke GND |
| Ultrasonik **TRIG** Depan + Wadah | D2 | dua sensor berbagi satu pin TRIG |
| Ultrasonik **TRIG** Kiri-depan + Kanan-depan | D4 | berbagi |
| Ultrasonik **TRIG** Kiri + Kanan | D12 | berbagi |
| ECHO Depan | A0 | |
| ECHO Kiri-depan | A1 | |
| ECHO Kanan-depan | A2 | |
| ECHO Kiri | A3 | |
| ECHO Kanan | A4 | |
| ECHO Wadah | D13 | |
| Baterai (pembagi tegangan) | A5 | opsional |

Dengan susunan ini **ke-20 pin Uno terpakai semua**: ESP 2, L298N 6, sapu 1, servo 1, baterai 1,
ultrasonik 9. Karena itu motor sapu dibuat cukup dengan satu pin.

### Motor sapu: pilih salah satu pensaklar

Pin Uno hanya kuat ±20 mA, sedangkan motor sapu butuh ratusan mA. Jadi di antara D3 dan motor harus ada
saklar elektronik. Ketiganya didukung firmware:

| Pilihan | Kecepatan sapu | Pengaturan di sketch | Catatan |
|---|---|---|---|
| **Modul relay 1 kanal 5 V** (dipakai di panduan rakit) | nyala/mati saja | `BRUSH_USE_PWM 0`, `BRUSH_ACTIVE_HIGH 0` kalau relay aktif-LOW | paling mudah, tanpa solder komponen kecil |
| Transistor TIP120 / TIP122 + resistor 1 kΩ | bisa diatur | biarkan `BRUSH_USE_PWM 1` | murah, perlu sedikit solder/breadboard, memakan ±1–1,5 V |
| Modul MOSFET (D4184 / AOD4184) | bisa diatur | biarkan `BRUSH_USE_PWM 1` | paling efisien |

Apa pun pilihannya, pasang **dioda flyback** (1N4007 atau 1N5819) melintang di jalur motor sapu, dengan
garis/katoda ke sisi +. Pasang di terminal tempat kabel motor masuk (bukan di badan motor), supaya kabel motor
boleh ditukar untuk membalik arah putar tanpa ikut membalik dioda. Langkah lengkap relay dan TIP120 ada di
[RAKIT-ECOBOT.md](RAKIT-ECOBOT.md) langkah 4.

**Relay:** VCC ← 5 V buck, GND ← GND bersama, IN ← D3, COM ← baterai (+), NO → motor (+), motor (−) → GND.
Motor mendapat tegangan baterai penuh (7,4–8,4 V); motor TT masih tahan tapi lebih kencang dan hangat. Dua
dioda 1N4007 seri di jalur + menurunkan ±1,4 V kalau perlu. Slider kecepatan sapu otomatis disembunyikan di
dashboard.

**TIP120:** D3 → resistor 1 kΩ → kaki B. Kaki E → GND bersama. Kaki C → motor (−). Motor (+) → baterai (+).
Urutan kaki dilihat dari sisi bertulisan: B, C, E. Sirip logamnya tersambung ke C.

**Modul MOSFET:** modul ini juga tidak cukup disambung ke Uno saja; ada tiga sisi yang perlu disambung.

```
Uno D3  ───────────────► SIG / PWM ┐
Uno GND ───────────────► GND       │ sisi sinyal
                                   │
Baterai + (7,4 V) ─────► VIN+      │ sisi daya          modul MOSFET
Baterai − / GND ───────► VIN−      │
                                   │
Motor sapu (+) ◄──────── OUT+ / V+ │ sisi motor
Motor sapu (−) ◄──────── OUT− / V− ┘
```

- Nama terminalnya beda-beda tiap modul (VIN/GND, DC+/DC−, V+/V−, LOAD), tapi polanya selalu sama:
  **sinyal dari Uno, daya dari baterai, keluaran ke motor**.
- Pilih modul yang bisa penuh menyala dengan sinyal 5 V (*logic-level*), misalnya **D4184 / AOD4184** atau
  MOSFET **IRLZ44N**. Modul **IRF520** juga bisa untuk motor kecil, tapi pada sinyal 5 V ia tidak menyala
  penuh dan lebih cepat panas.

Untuk transistor dan MOSFET, kecepatan sapu di mode otomatis dibatasi 70% (`BRUSH_AUTO_PCT`, ±5,9 V dari
baterai 2S) supaya aman untuk motor 3–6 V, dan firmware menaikkan kecepatan pelan-pelan (soft-start,
`BRUSH_RAMP_MS`) supaya lonjakan arus saat mulai berputar tidak me-reset Uno. Di mode manual, slider kecepatan
sapu sebaiknya tidak dinaikkan di atas ±75% untuk motor 6 V.

### Servo pengangkat sapu

Servo mengangkat sapu saat tidak dipakai dan saat robot mundur menghindar, supaya sampah di wadah tidak
tertarik keluar dan bulu sikat tidak cepat aus. Sudut bawaan: `LIFT_DOWN_ANGLE 20` (sapu menyentuh lantai)
dan `LIFT_UP_ANGLE 80` (terangkat). Uji dari mode manual (tombol "Turunkan Sapu" / "Angkat Sapu") lalu
sesuaikan angkanya. Di mode otomatis, sapu baru mulai berputar setelah benar-benar turun.

### Posisi sensor ultrasonik

- **Depan**: di tengah depan, **di atas sapu**, menghadap lurus ke depan. Pasang lebih tinggi dari sampah
  (±8–10 cm dari lantai) supaya sampah kecil tidak dikira rintangan dan tetap tersapu.
- **Kiri-depan** dan **Kanan-depan**: di sudut depan, serong ±45° ke luar. Keduanya menangkap rintangan yang
  lolos dari sensor depan, misalnya kaki kursi.
- **Kiri** dan **Kanan**: di samping, menghadap 90° ke luar. Dipakai untuk menjauh sedikit dari dinding
  supaya badan robot tidak bergesekan.
- **Wadah**: di tutup/atas wadah sampah, **menghadap ke bawah** ke dasar wadah. Ukur jarak ke dasar saat
  kosong dan isi `BIN_EMPTY_CM` (bawaan 20). Kapasitas wadah dihitung dari situ.

Tidak ada sensor belakang, jadi saat menghindar robot hanya mundur sebentar (`AVOID_BACK_MS`, 0,45 detik).
Di mode manual, gerak maju ditahan kalau ada benda ≤ 6 cm di depan atau serong depan. Gerak mundur tidak
dijaga sensor, jadi hati-hati.

### Cara kerja mode otomatis

1. Sapu turun, lalu mulai berputar 70%.
2. Robot maju pelan sambil menyapu, dan menjauh sedikit kalau terlalu dekat dinding samping.
3. Ada rintangan di depan atau serong depan: sapu berhenti dan terangkat, robot mundur sebentar, lalu
   berputar ke sisi yang lebih lega selama waktu acak. Setelah itu kembali menyapu.
4. Tiap ±12 detik tanpa rintangan, robot berbelok acak supaya area tersapu lebih rata.
5. Wadah penuh (≥ 95%): robot berhenti, sapu mati dan terangkat. Setelah wadah dikosongkan, robot lanjut sendiri.

Tanpa encoder roda, robot tidak tahu posisinya, jadi polanya "memantul" seperti robot vakum sederhana,
bukan menyapu baris demi baris.

## 5. ESP bridge (ESP32 DevKit atau ESP8266)

Uno bekerja di 5 V, ESP di 3,3 V.

```
Uno TX (D1) ──[ 1 kΩ ]──┬──► ESP32 GPIO16 (RX2)
                        │
                      [ 2 kΩ ]
                        │
                       GND
Uno RX (D0) ◄───────────────── ESP32 GPIO17 (TX2)      (3,3 V ke Uno aman tanpa pembagi)
GND Uno ─────────────────────── GND ESP
```

- Di **ESP8266** (NodeMCU), jalur Uno memakai UART utama (RX = GPIO3, TX = GPIO1), sehingga
  Serial Monitor/USB tidak bisa dipakai untuk log saat terhubung ke Uno. Pilihan ESP32 lebih nyaman.
- **Saat upload sketch ke Uno, lepas kabel D0/D1.** Uno cuma punya satu Serial dan dipakai USB juga.
- "ESP extension" di daftar Anda saya asumsikan modul ESP32/ESP8266 (atau papan ekstensinya). Sketch
  `esp_bridge` jalan di keduanya.
- Isi `WIFI_SSID`, `WIFI_PASS`, dan `ROBOT_NAME` (`fireguard` atau `ecobot`). Kalau WiFi gagal tersambung
  dalam 15 detik, ESP membuat WiFi sendiri bernama `<robot>-robot` (password dari `AP_PASS`), dan
  dashboard bisa tersambung ke `192.168.4.1`.
- Alamat di dashboard: `fireguard.local` / `ecobot.local` (mDNS), atau IP yang tampil di Serial Monitor
  (ESP32). Di HP Android, `.local` kadang tidak terbaca. Pakai IP kalau begitu.

## 6. ESP32-CAM

Hanya butuh daya: 5 V stabil dan GND (bagian 1). Tidak ada kabel ke Uno.

- Board di Arduino IDE: **AI Thinker ESP32-CAM**. Untuk upload: sambungkan **GPIO0 ke GND**, tekan reset,
  upload, lepas GPIO0, tekan reset lagi. Pakai adaptor USB-serial (atau papan ESP32-CAM-MB).
- Isi daftar WiFi di `NETWORKS`. Baris kedua bisa diisi WiFi milik ESP bridge (mode AP) supaya kamera ikut
  tersambung kalau WiFi utama hilang.
- Alamat kamera di dashboard: `fireguard-cam.local` / `ecobot-cam.local`, atau IP-nya. Hanya satu penonton
  stream dalam satu waktu.

## 7. Mengukur baterai (opsional)

```
+ baterai ──[ 10 kΩ ]──┬──► A5 Uno
                       │
                     [ 10 kΩ ]
                       │
                      GND
```

Dua resistor sama membagi dua: 8,4 V menjadi 4,2 V di A5 (aman untuk Uno 5 V). Lalu di sketch ubah
`HAS_BATTERY_SENSE` jadi `1`. Kalau resistornya tidak sama, isi `BAT_DIVIDER_X100` dengan
(R1+R2)/R2 × 100. Di dashboard, pilih jumlah sel di Pengaturan. Persennya perkiraan kasar dari
tegangan; saat motor menyala tegangan turun sesaat, jadi angkanya bisa naik-turun.
