# Smart Robot: FireGuard dan EcoBot

Dua robot IoT, dua dashboard terpisah.

- **FireGuard** mendeteksi api dan gas, lalu memadamkan api dengan pompa air.
- **EcoBot** mendeteksi sampah dengan sensor ultrasonik, mengambilnya dengan capit, dan membuangnya ke bin di atas robot.

Dashboard-nya murni HTML, CSS, dan JavaScript biasa. Tidak perlu build, tidak perlu server, dan tidak perlu internet
(font dan library MQTT sudah disimpan di repo). Tampilannya mengikuti mockup, lalu dilengkapi supaya benar-benar bisa
menyambung ke robot.

## Coba dulu tanpa robot

Buka `index.html` dengan double-click, pilih robot, selesai. Dashboard langsung jalan dalam **mode Demo**:
robot virtual di dalam browser, memakai protokol yang sama persis dengan robot asli. Di mode ini kartu sensor bisa diklik
untuk mensimulasikan api, gas, atau objek. Ada label "DEMO · DATA SIMULASI" di pojok kanan atas supaya tidak tertukar
dengan data sungguhan.

## Menyambung ke robot sungguhan

1. **Wiring dan daya.** Ikuti [docs/WIRING.md](docs/WIRING.md). Bagian daya paling penting (baterai 18650 perlu 2 sel seri, dan ESP32/servo tidak boleh dari pin 5 V Uno).
2. **Upload sketch ke Arduino Uno**: `firmware/fireguard_uno/` atau `firmware/ecobot_uno/`.
   Lepas kabel D0/D1 ke ESP saat upload. Sesuaikan bagian KONFIGURASI di atas sketch (jumlah sensor, arah motor, sudut servo).
3. **Upload `firmware/esp_bridge/` ke ESP** (ESP32 atau ESP8266): isi nama WiFi, password, dan `ROBOT_NAME`.
   Library yang perlu dipasang lewat Library Manager: *WebSockets* (Markus Sattler), dan *PubSubClient* kalau mau MQTT.
4. **Upload `firmware/esp32cam_stream/` ke ESP32-CAM**: isi WiFi dan `CAM_HOSTNAME`.
5. **Di dashboard**, klik ikon roda gigi → mode **Langsung** → isi alamat robot (mis. `fireguard.local` atau IP-nya) dan alamat kamera → Simpan.
   Pengaturan tersimpan di browser.

Dashboard bisa dibuka lewat `file://` atau `http://`. Kalau dibuka lewat **https** (mis. GitHub Pages), browser memblokir koneksi
`ws://` dan kamera `http://` ke robot. Untuk kasus itu pakai mode MQTT (tanpa kamera), atau jalankan dashboard dari laptop.

### Mode MQTT (robot dan dashboard beda jaringan)

Di `esp_bridge.ino` ubah `USE_MQTT` jadi `1` dan isi `MQTT_PREFIX`. Di dashboard pilih mode MQTT, isi alamat broker
(contoh `wss://broker.hivemq.com:8884/mqtt`) dan **awalan topik yang sama**. Broker publik bisa dibaca siapa saja, jadi pakai
awalan yang unik. Detail topik ada di [docs/PROTOKOL.md](docs/PROTOKOL.md).

### Mencoba mode Langsung/MQTT tanpa hardware

```bash
cd tools/mock-robot && npm install
node index.js fireguard --mqtt     # WebSocket :8081, kamera :8091, broker MQTT :9001
```

Lalu di dashboard: Langsung → alamat robot `127.0.0.1:8081`, alamat kamera `127.0.0.1:8091`.

## Yang ada di dashboard

Yang sudah ada di mockup dipertahankan (joystick, WASD, toggle Otomatis/Manual, kartu sensor, pompa / capit, log, tampilan HP).
Yang saya tambah atau perbaiki:

- **Koneksi sungguhan**: WebSocket langsung atau MQTT, sambung ulang otomatis, dan status yang jujur:
  *Terhubung*, *Robot belum merespons* (ESP hidup tapi Arduino diam, biasanya kabel TX/RX), *Menyambung…*, *Terputus*.
  Kalau robot tidak terjangkau, semua data tampil "Offline" dan kontrol dimatikan, bukan menampilkan angka lama.
- **Tombol STOP** (juga tombol Spasi) selalu terlihat di header.
- **Pengaman gerak**: robot berhenti sendiri kalau perintah dari dashboard berhenti datang (dead-man timer di Uno), joystick dilepas,
  tab disembunyikan, atau koneksi putus. Pompa manual juga begitu.
- **Kamera**: stream ESP32-CAM, snapshot, lampu, pilihan resolusi, layar penuh. Stream macet atau putus terdeteksi dan dicoba lagi otomatis.
- **Grafik riwayat sensor** (1 atau 5 menit) dengan tooltip, tabel, dan ekspor CSV.
- **Log aktivitas nyata** (bukan contoh), tersimpan di browser, bisa diekspor CSV.
- **Alarm**: banner, bunyi, dan notifikasi browser saat api atau gas berbahaya (bisa dimatikan di pengaturan).
- **Status sistem**: latensi, sinyal WiFi, alamat, uptime robot, versi firmware, baterai.
- **EcoBot**: urutan ambil sampah otomatis (capit + lengan + buang ke bin), hitungan sampah, kapasitas bin dari sensor, pengaman tabrakan di mode manual.
- **FireGuard**: arah nozzle bisa diatur manual, jumlah sensor api/gas mengikuti firmware, pemanasan MQ-2 ditampilkan, pompa dibatasi lama nyalanya.
- Tampilan **3 kolom / 2 kolom / 1 kolom** (desktop, tablet, HP).

## Asumsi yang saya pakai

Beberapa hal di daftar komponen tidak sepenuhnya jelas bagi saya. Ini yang saya putuskan, dan di mana mengubahnya:

| Hal | Yang saya asumsikan | Kalau beda |
|---|---|---|
| Jumlah sensor api | **2** (Kiri, Kanan), karena "berjumlah 2" | `FLAME_COUNT 3` di sketch; dashboard ikut sendiri |
| Jumlah MQ-2 | **1** | `GAS_COUNT 2` |
| "ESP extension" | modul **ESP32** (atau ESP8266) sebagai jembatan WiFi ke Uno; ESP32-CAM khusus kamera | sketch bridge jalan di ESP32 dan ESP8266 |
| Servo EcoBot | 2 servo: capit (buka/tutup) dan lengan (naik/turun) | sudut di KONFIGURASI sketch |
| 6 ultrasonik EcoBot | Depan, Belakang, Kiri, Kanan, Capit, **Bin** (mengukur isi bin) | urutan & pin di `docs/WIRING.md` |
| Pompa FireGuard | lewat modul relay/MOSFET di D4 (**tidak ada di daftar Anda**, perlu dibeli) | `PIN_PUMP`, `PUMP_ACTIVE_HIGH` |
| Baterai | 2 sel 18650 seri (7,4 V) | satu sel tidak cukup untuk L298N dan Uno |
| Mode saat menyala | FireGuard: otomatis (diam sampai ada api). EcoBot: manual (tidak langsung jalan sendiri) | `setup()` di sketch |

## Pengujian

Yang sudah dijalankan otomatis:

- **Firmware Uno** dikompilasi dengan `avr-g++` untuk ATmega328P: nol peringatan dari sketch. Memori terpakai sekitar 10 KB flash
  dan 0,5 KB RAM (Uno punya 32 KB dan 2 KB).
- **Logika firmware** diuji di komputer (`tests/firmware-host`): sketch asli dijalankan dengan sensor palsu, dan 20 skenario diperiksa
  (JSON valid di tiap baris, siaga → belok → semprot → jeda, batas 15 detik pompa, dead-man, urutan ambil sampah, pengaman tabrakan,
  bin penuh, input sampah).
- **Dashboard** diuji di Chromium sungguhan (`tests/e2e`, 57 skenario): mode Demo, WebSocket, MQTT, dan kamera terhadap robot palsu
  (`tools/mock-robot`), termasuk server mati lalu hidup lagi, stream kamera macet, dan lima ukuran layar. Setiap tes memastikan
  **tidak ada satu pun error/peringatan konsol, error halaman, atau request gagal**.

```bash
# sekali saja
cd tools/mock-robot && npm install && cd ../../tests && npm install
# lalu
cd tests && npm test          # butuh g++ dan Chromium (set CHROMIUM_PATH kalau bukan di /opt/pw-browsers)
```

**Yang belum bisa saya uji, dan perlu Anda lihat sendiri:**

- Sketch `esp_bridge` dan `esp32cam_stream` belum dikompilasi maupun dijalankan (core ESP tidak tersedia di lingkungan saya).
  Ditulis dengan API standar, tapi anggap "belum terbukti" sampai Anda upload sendiri.
- Wiring dan perilaku di perangkat keras asli (arus motor, servo, sensor sebenarnya). Ambang sensor api/gas dan jarak EcoBot
  (`FLAME_*`, `GAS_*`, `*_CM`) adalah titik awal yang masuk akal, **bukan hasil kalibrasi**.
- Hanya Chromium yang dipakai untuk menguji tampilan. Firefox dan Safari belum.

## Keterbatasan yang perlu diketahui

- Ultrasonik tidak bisa membedakan sampah dari dinding. Firmware memakai dua heuristik (lihat `docs/WIRING.md`), tapi tetap bisa keliru.
  Mode manual dengan kamera adalah cara yang paling bisa diandalkan.
- Tidak ada login. Siapa pun di WiFi yang sama bisa mengendalikan robot. Pakai jaringan yang Anda percaya, dan awalan MQTT yang unik.
- ESP32-CAM hanya melayani satu penonton stream dalam satu waktu. Tab kedua akan menampilkan pesan bahwa kamera tidak mengirim gambar.

## Kalau ada masalah

| Gejala | Kemungkinan penyebab |
|---|---|
| "Robot belum merespons" | kabel TX/RX Uno ↔ ESP tertukar atau longgar, baud tidak sama (57600), atau kabel masih terpasang saat upload |
| Uno restart sendiri saat servo bergerak | servo/ESP masih memakai daya dari pin 5 V Uno. Pindahkan ke buck converter |
| ESP32-CAM "Brownout detector" atau video putus-putus | daya kurang. Tambah kapasitor dan pakai 5 V ≥ 1 A |
| `fireguard.local` tidak ketemu di HP | mDNS sering tidak jalan di Android. Pakai alamat IP |
| Dashboard https tidak bisa tersambung | browser memblokir `ws://` dari halaman https. Buka lewat `file://` atau `http://` |
| Roda berputar terbalik | `INVERT_LEFT` / `INVERT_RIGHT` di sketch |
| Pompa menyala saat seharusnya mati | `PUMP_ACTIVE_HIGH 0` (modul relay aktif-LOW) |
| Motor berdengung tapi tidak jalan | naikkan `MIN_PWM`, atau baterai kurang kuat |

## Struktur

```
index.html                  pilih robot
fireguard/  ecobot/         satu dashboard per robot (index.html, logika robot, simulator)
shared/                     dipakai keduanya: css, font, library MQTT, js (koneksi, joystick, kamera, grafik, log, alarm, pengaturan)
firmware/                   sketch Arduino Uno (2), ESP bridge, ESP32-CAM
docs/                       PROTOKOL.md, WIRING.md
tools/mock-robot/           robot palsu (WebSocket, MQTT, kamera) untuk uji dan coba-coba
tests/                      uji dashboard (Playwright) dan uji logika firmware (di PC)
```

Semua script memakai `<script>` biasa (bukan ES module) supaya dashboard bisa dibuka langsung dari `file://`.
Semua komunikasi lewat satu modul, `shared/js/link.js`, dan formatnya ada di `docs/PROTOKOL.md`.
Menambah sensor atau aktuator berarti: tambah di sketch, tambah pesannya di protokol, lalu tampilkan di `fireguard.js` atau `ecobot.js`.
