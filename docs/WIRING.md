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
Baterai 2S (7,4 V) ──► saklar ──┬─► L298N terminal +12V  (motor)
                                ├─► Uno pin VIN          (Uno punya regulator sendiri)
                                └─► Buck converter 5 V ≥ 2 A ──► ESP32, ESP32-CAM, servo, MQ-2
GND baterai = GND L298N = GND Uno = GND buck = GND ESP (semua GND harus disatukan)
```

- **Jangan** menyuplai ESP32, ESP32-CAM, servo, atau MQ-2 dari pin 5 V Uno. Regulator Uno tidak kuat
  (MQ-2 saja memakan ±150 mA untuk pemanasnya, servo dan WiFi ESP menarik arus lonjakan).
  Gejalanya: Uno restart sendiri saat servo bergerak atau ESP menyambung WiFi.
- ESP32-CAM sangat sensitif. Pasang kapasitor 470 µF (atau lebih) dekat pin 5V-nya. "Brownout detector
  was triggered" di Serial Monitor = daya kurang, bukan salah kode.
- Jumper 5V di L298N boleh dibiarkan terpasang (dia hanya dipakai sebagai regulator internal modul), tapi
  jangan ambil 5 V dari situ untuk beban lain.
- Persen baterai di dashboard butuh pembagi tegangan (bagian 6). Tanpa itu, kolom baterai menampilkan "—".

## 2. FireGuard — Arduino Uno

| Komponen | Pin Uno | Keterangan |
|---|---|---|
| ESP (Serial) | D0 (RX), D1 (TX) | silang: TX Uno → RX ESP (lewat pembagi tegangan, bagian 4); RX Uno ← TX ESP |
| L298N ENA / IN1 / IN2 | D5 / D7 / D8 | sisi **kiri** (motor kiri depan + kiri belakang, dipasang paralel) |
| L298N ENB / IN3 / IN4 | D6 / D9 / D10 | sisi **kanan** |
| Sensor api 1 (Kiri) | A0 | pin **AO** modul |
| Sensor api 2 (Kanan) | A1 | pin **AO** modul |
| Sensor api 3 (Depan) | A2 | hanya kalau `FLAME_COUNT 3`; urutan jadi Kiri, Depan, Kanan |
| MQ-2 #1 | A3 | pin **AO** modul |
| MQ-2 #2 | A4 | hanya kalau `GAS_COUNT 2` |
| Baterai (pembagi tegangan) | A5 | opsional, `HAS_BATTERY_SENSE 1` |
| Servo nozzle | D11 | sinyal; merah ke 5 V buck, coklat/hitam ke GND |
| Pompa | D4 | ke **modul relay atau MOSFET**, bukan ke pompa langsung |
| LED indikator | D13 (LED bawaan) | menyala saat api terdeteksi |

**Pompa tidak ada di daftar komponen Anda.** Pompa DC mini butuh driver: modul relay 5 V satu kanal, atau
MOSFET (mis. IRLZ44N / modul MOSFET). Modul relay biasanya aktif-LOW, kalau pompa menyala terbalik
(nyala saat seharusnya mati) ubah `PUMP_ACTIVE_HIGH` jadi `0`. Kalau pakai relay, pasang juga dioda
flyback di pompa. Sebelum mencoba pompa dari dashboard, pastikan ada air di tangkinya, karena pompa
kering cepat rusak.

Sensor api (IR flame, 4 pin: VCC, GND, DO, AO): dipakai AO-nya. Putar potensio di modul sampai nilai
sekitar 900–1000 di ruangan biasa, lalu dekatkan api (korek) dan lihat nilainya turun. Ambang di firmware:
`FLAME_WARN 700`, `FLAME_DANGER 400`. Sensor IR ini juga terpengaruh cahaya matahari dan lampu pijar,
jadi kalibrasi di tempat robot dipakai.

**Soal jumlah sensor:** dari daftar Anda ("flame sensor × 3, berjumlah 2" dan "MQ-2 sekitar 1 atau 2"),
bawaan sketch adalah **2 sensor api + 1 MQ-2**. Kalau ternyata 3 api atau 2 gas, cukup ubah
`FLAME_COUNT` / `GAS_COUNT` di sketch. Dashboard mengikuti sendiri.

MQ-2 perlu pemanasan sekitar 20 detik setiap dinyalakan (dashboard menampilkan "Pemanasan"), dan idealnya
dibakar-awal 24 jam saat pertama dipakai supaya pembacaan stabil. Nilai `GAS_WARN 350` / `GAS_DANGER 550`
hanya titik awal: catat nilai di udara bersih, lalu atur ambangnya.

## 3. EcoBot — Arduino Uno

| Komponen | Pin Uno | Keterangan |
|---|---|---|
| ESP (Serial) | D0 (RX), D1 (TX) | sama seperti FireGuard |
| L298N ENA / IN1 / IN2 | D5 / D7 / D8 | sisi kiri |
| L298N ENB / IN3 / IN4 | D6 / D9 / D10 | sisi kanan |
| Servo capit | D3 | buka/tutup |
| Servo lengan | D11 | naik/turun |
| Ultrasonik **TRIG** Depan + Belakang | D2 | dua sensor berbagi satu pin TRIG |
| Ultrasonik **TRIG** Kiri + Kanan | D4 | berbagi |
| Ultrasonik **TRIG** Capit + Bin | D12 | berbagi |
| ECHO Depan | A0 | |
| ECHO Belakang | A1 | |
| ECHO Kiri | A2 | |
| ECHO Kanan | A3 | |
| ECHO Capit | A4 | |
| ECHO Bin | D13 | |
| Baterai (pembagi tegangan) | A5 | opsional |

**Kenapa TRIG dipasangkan?** Uno hanya punya 20 pin. Enam HC-SR04 butuh 12, L298N 6, servo 2, dan jalur
ESP 2: total 22. Jadi tiga pasang sensor berbagi TRIG. Pasangannya dipilih yang arahnya saling
membelakangi supaya tidak saling mengganggu. Firmware tetap mengukur satu sensor per waktu, jadi hasil
masing-masing tidak tercampur.

Posisi sensor yang disarankan:

- **Depan**, **Kiri**, **Kanan**, **Belakang**: di badan robot, menghadap ke arahnya masing-masing.
- **Capit**: rendah di dekat capit, menghadap ke depan. Saat jaraknya ≤ 12 cm, objek dianggap sudah dalam jangkauan capit.
- **Bin**: di tepi atas penampung, **menghadap ke bawah** ke dasar bin. Ukur jarak ke dasar saat kosong dan isi
  `BIN_EMPTY_CM` (bawaan 20). Kapasitas dihitung dari situ. Sensor ini tidak ikut dipakai mendeteksi objek.
  Saat lengan sedang di atas bin, bacaan Bin diabaikan karena terhalang lengan.

**Soal sampah vs dinding.** Sensor ultrasonik hanya tahu ada benda, bukan jenisnya. Bawaan firmware:
benda di depan yang **juga** ada benda di sampingnya dianggap dinding/sudut dan dihindari. Kalau sensor
Depan Anda pasang **lebih tinggi** dari sampah (mis. di atas bin), ubah `DEPAN_SENSOR_HIGH` jadi `1`: sampah
pendek hanya terlihat sensor Capit, sedangkan rintangan tinggi terlihat keduanya. Tetap tidak sempurna:
dinding datar yang didekati dari depan masih bisa dikira sampah. Kalau itu sering terjadi, kamera (manual)
masih yang paling bisa diandalkan.

**Servo**: sudut default `CLAW_OPEN_ANGLE 90`, `CLAW_CLOSED_ANGLE 25`, `ARM_DOWN_ANGLE 10`, `ARM_UP_ANGLE 150`.
Uji satu per satu dari mode manual dan sesuaikan supaya servo tidak mentok (berdengung = mentok, cepat
panas). Lengan naik ke 150° itu diasumsikan mengayun melewati atas bin tempat capit membuang sampah.

**Capit dan "mini servo":** daftar Anda menyebut satu capit mini dan satu mini servo. Sketch memakai dua
servo: satu untuk capit (buka/tutup) dan satu untuk lengan (naik/turun). Kalau lengan Anda ternyata tidak
bergerak naik-turun, cukup biarkan `ARM_UP_ANGLE` = `ARM_DOWN_ANGLE`.

## 4. ESP bridge (ESP32 DevKit atau ESP8266)

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

## 5. ESP32-CAM

Hanya butuh daya: 5 V stabil dan GND (bagian 1). Tidak ada kabel ke Uno.

- Board di Arduino IDE: **AI Thinker ESP32-CAM**. Untuk upload: sambungkan **GPIO0 ke GND**, tekan reset,
  upload, lepas GPIO0, tekan reset lagi. Pakai adaptor USB-serial (atau papan ESP32-CAM-MB).
- Isi daftar WiFi di `NETWORKS`. Baris kedua bisa diisi WiFi milik ESP bridge (mode AP) supaya kamera ikut
  tersambung kalau WiFi utama hilang.
- Alamat kamera di dashboard: `fireguard-cam.local` / `ecobot-cam.local`, atau IP-nya. Hanya satu penonton
  stream dalam satu waktu.

## 6. Mengukur baterai (opsional)

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
