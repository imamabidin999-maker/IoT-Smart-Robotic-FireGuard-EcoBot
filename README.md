# Smart Robot: FireGuard dan EcoBot

Dua robot IoT, dua dashboard terpisah.

- **FireGuard** mendeteksi api dan gas, lalu memadamkan api dengan pompa air.
- **EcoBot** adalah robot penyapu: sikat berputar di depan menyapu sampah ke wadah di badan robot, sambil menghindari rintangan dengan sensor ultrasonik.

Dashboard-nya murni HTML, CSS, dan JavaScript biasa. Tidak perlu build, tidak perlu server, dan tidak perlu internet
(font dan library MQTT sudah disimpan di repo). Tampilannya mengikuti mockup, lalu dilengkapi supaya benar-benar bisa
menyambung ke robot.

## Coba dulu tanpa robot

Buka `index.html` dengan double-click, pilih robot, selesai. Dashboard langsung jalan dalam **mode Demo**:
robot virtual di dalam browser, memakai protokol yang sama persis dengan robot asli. Di mode ini kartu sensor bisa diklik
untuk mensimulasikan api, gas, atau objek. Ada label "DEMO · DATA SIMULASI" di pojok kanan atas supaya tidak tertukar
dengan data sungguhan.

## Menyambung ke robot sungguhan

1. **Wiring dan daya.** Ikuti [docs/WIRING.md](docs/WIRING.md). Panduan rakit urut langkah demi langkah: [docs/RAKIT-FIREGUARD.md](docs/RAKIT-FIREGUARD.md) dan [docs/RAKIT-ECOBOT.md](docs/RAKIT-ECOBOT.md). Bagian daya paling penting (robot tim memakai 4 baterai 18650 seri lewat buck 5,0 V, dan ESP32/servo tidak boleh dari pin 5 V Uno).
2. **Upload sketch ke Arduino Uno**: `firmware/fireguard_uno/` atau `firmware/ecobot_uno/`.
   Lepas kabel D0/D1 ke ESP saat upload. Sesuaikan bagian KONFIGURASI di atas sketch (jumlah sensor, arah motor, sudut servo).
   Di modul L298N, **cabut jumper ENA dan ENB** dulu (lihat `docs/WIRING.md` bagian 2).
   Belum yakin kabel motornya benar? Upload dulu `firmware/tes_motor/`: roda diputar sendiri dengan urutan tetap,
   tanpa perlu mengetik perintah. Sketch robot juga bisa diuji langsung dari Serial Monitor (57600); Uno menjawab
   dengan baris berawalan `#` kalau perintah diabaikan atau salah ketik.
3. **Upload `firmware/esp_bridge/` ke ESP** (ESP32 atau ESP8266). Pengaturan ada di `config.h`; nama/password WiFi
   ditulis di `secrets.h` (salin dari `secrets.example.h`, tidak ikut ke GitHub). Tanpa diisi, robot membuat WiFi sendiri.
   Library yang perlu dipasang lewat Library Manager: *WebSockets* (Markus Sattler), *ArduinoJson* (Benoit Blanchon, v7),
   dan *PubSubClient* kalau mau MQTT.
4. **Upload `firmware/esp32cam_stream/` ke ESP32-CAM**: untuk EcoBot tulis `#define ROBOT_NAME "ecobot"` di `secrets.h`
   (bawaannya FireGuard), dan WiFi di `secrets.h` kalau perlu.
5. **Di dashboard**, klik ikon roda gigi → mode **Langsung** → isi alamat robot (mis. `fireguard.local` atau IP-nya) dan alamat kamera → Simpan.
   Pengaturan tersimpan di browser.

Dashboard bisa dibuka lewat `file://` atau `http://`. Kalau dibuka lewat **https** (mis. GitHub Pages), browser memblokir koneksi
`ws://` dan kamera `http://` ke robot. Untuk kasus itu pakai mode MQTT (tanpa kamera), atau jalankan dashboard dari laptop.

### Update firmware lewat WiFi (OTA)

ESP32 bridge bisa di-update tanpa kabel: dari Arduino IDE (Push OTA), atau ESP mengambil sendiri dari server
(Pull OTA, dipasang setelah tombol **Pasang** di kartu *Update Firmware ESP* diklik dan robot diam). Firmware baru
masuk masa percobaan: kalau gagal health check (mis. kabel sensor lepas), crash, atau macet, ESP kembali ke
versi lama yang masih tersimpan di flash. Langkah praktikum C1–C3, tanda tangan digital, dan mengubah parameter
robot lewat OTA ada di [docs/OTA.md](docs/OTA.md). Alat penerbit: `tools/ota/publish_fw.py` dan `tools/ota/keygen.py`
(cukup Python 3).

### Mode MQTT (robot dan dashboard beda jaringan)

Di `config.h` (atau `secrets.h`) ESP bridge ubah `USE_MQTT` jadi `1` dan isi `MQTT_PREFIX`. Di dashboard pilih mode MQTT, isi alamat broker
(contoh `wss://broker.hivemq.com:8884/mqtt`) dan **awalan topik yang sama**. Broker publik bisa dibaca siapa saja, jadi pakai
awalan yang unik. Detail topik ada di [docs/PROTOKOL.md](docs/PROTOKOL.md).

### Mencoba mode Langsung/MQTT tanpa hardware

```bash
cd tools/mock-robot && npm install
node index.js fireguard --mqtt     # WebSocket :8081, kamera :8091, broker MQTT :9001
```

Lalu di dashboard: Langsung → alamat robot `127.0.0.1:8081`, alamat kamera `127.0.0.1:8091`.

## Yang ada di dashboard

Yang sudah ada di mockup dipertahankan (joystick, WASD, toggle Otomatis/Manual, kartu sensor, pompa, log, tampilan HP).
Kartu capit EcoBot diganti kartu **Sapu & Wadah** karena konsepnya berubah menjadi robot penyapu.
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
- **Update Firmware ESP**: versi ESP, cek update, pasang dengan konfirmasi dua klik, progres, masa percobaan, dan hasil
  terakhir (VALID / dikembalikan). Lewat MQTT hanya bisa mengecek.
- **Kabel sensor lepas**: kartu sensor ditandai *Kabel lepas* (EcoBot juga *Tidak menjawab*) dan muncul banner. FireGuard
  mengabaikan sensor itu di mode otomatis; EcoBot berhenti kalau yang lepas sensor depan, supaya tidak berjalan buta.
- **EcoBot**: sapu nyala/mati (kecepatan bisa diatur kalau memakai transistor/MOSFET), sapu bisa diangkat/diturunkan, mode otomatis
  menyapu sambil menghindari rintangan, kapasitas wadah dari sensor, lama menyapu, pengaman tabrakan di mode manual.
- **FireGuard**: arah nozzle bisa diatur manual, jumlah sensor api/gas mengikuti firmware, pemanasan MQ-2 ditampilkan, pompa dibatasi lama nyalanya.
- Tampilan **3 kolom / 2 kolom / 1 kolom** (desktop, tablet, HP).

## Asumsi yang saya pakai

Beberapa hal di daftar komponen tidak sepenuhnya jelas bagi saya. Ini yang saya putuskan, dan di mana mengubahnya:

| Hal | Yang saya asumsikan | Kalau beda |
|---|---|---|
| Jumlah sensor api | **2** (Kiri A0, Kanan A1), sesuai robot tim | `FLAME_COUNT 3` di sketch kalau memasang tiga (Kiri A0, Depan A1, Kanan A2); dashboard ikut sendiri |
| Sensor ultrasonik FireGuard | **tidak ada**; FireGuard berhenti mendekat berdasarkan kekuatan api (`FLAME_DANGER`) | 6 HC-SR04 hanya untuk EcoBot |
| Jumlah MQ-2 | **2** (A3, A4) | `GAS_COUNT 1` kalau hanya satu |
| "ESP extension" | modul **ESP32** (atau ESP8266) sebagai jembatan WiFi ke Uno; ESP32-CAM khusus kamera | sketch bridge jalan di ESP32 dan ESP8266 |
| Driver motor roda | 1 modul L298N per robot: channel A roda kiri, channel B roda kanan | pin di `docs/WIRING.md` bagian 2 |
| Motor sapu EcoBot | **modul relay aktif-LOW** di D3, COM dari buck 5 V (robot tim) | `BRUSH_ACTIVE_HIGH 1` untuk relay aktif-HIGH. TIP120/MOSFET: `BRUSH_USE_PWM 1`, kecepatan sapu bisa diatur |
| Servo EcoBot | 1 mini servo untuk mengangkat / menurunkan sapu | `LIFT_DOWN_ANGLE`, `LIFT_UP_ANGLE` |
| 6 ultrasonik EcoBot | Depan, Kiri-depan, Kanan-depan, Kiri, Kanan, **Wadah** (mengukur isi wadah) | urutan & pin di `docs/WIRING.md` |
| Pompa FireGuard | pompa celup mini 3–6 V lewat modul relay di D4 | `PIN_PUMP`, `PUMP_ACTIVE_HIGH` (bawaan `0` untuk relay aktif-LOW; `1` untuk MOSFET/relay aktif-HIGH) |
| Baterai | kedua robot: 4 sel 18650 seri (14,8 V), semua modul 5 V lewat buck, `BAT_CELLS 4` | `BAT_CELLS 2` di sketch robot dan `tes_motor` kalau memakai 2 sel seri; satu sel tidak cukup untuk L298N dan Uno |
| Mode saat menyala | **Manual** di kedua robot (tidak langsung jalan sendiri). Otomatis dinyalakan dari dashboard | FireGuard: `BOOT_MODE_AUTO 1`. EcoBot: `setup()` di sketch |
| ESP32 & ESP32-CAM EcoBot | sketch yang sama dengan FireGuard | `#define ROBOT_NAME "ecobot"` di `secrets.h` masing-masing |

## Pengujian

Yang sudah dijalankan otomatis:

- **Firmware Uno** dikompilasi dengan `avr-g++` untuk ATmega328P: nol peringatan dari sketch. Memori terpakai sekitar 11–14 KB flash
  dan 0,5–0,6 KB RAM (Uno punya 32 KB dan 2 KB).
- **Logika firmware** diuji di komputer (`tests/firmware-host`): sketch asli dijalankan dengan sensor palsu, dan 40 skenario diperiksa
  (JSON valid di tiap baris, siaga → belok → semprot → jeda, batas 15 detik pompa, dead-man, soft-start sapu, servo pengangkat,
  menghindar ke sisi yang lega, wadah penuh, pengaman tabrakan, input sampah, perintah `CFG`, kabel sensor lepas (sensor api, gas,
  dan ultrasonik yang kabel Echo-nya lepas atau tidak menjawab), baterai 4 sel seri, relay aktif-LOW, perintah dari
  Serial Monitor: huruf kecil, tanpa Enter, pesan `#` saat perintah diabaikan).
- **Update firmware ESP (OTA)** diuji di komputer (`tests/bridge-host`): `esp_bridge.ino` yang asli dijalankan di atas ESP32 tiruan
  (flash dua slot, bootloader, NVS, server update, Uno palsu FireGuard dan EcoBot), dan 17 skenario mengikuti checkpoint praktikum: Push OTA + password
  salah, Pull OTA + persetujuan + syarat robot diam, downgrade / MD5 salah / board salah / file diganti / lupa naik versi ditolak,
  HTTPS dengan Root CA benar dan salah, FAULT_MODE 1/2/3, sensor dicabut → rollback, rollback lewat bootloader, tanda tangan
  digital, parameter robot lewat OTA, dan versi EcoBot (ditahan saat sapu berputar, sensor ultrasonik lepas → rollback, parameter
  jarak menghindar). Tanda tangan buatan `tools/ota` diperiksa dengan mbedTLS (library yang sama dengan ESP32)
  dan OpenSSL.
- **Alat OTA** (`tools/ota/test_ota_tools.py`): penerbitan manifest, penolakan file yang salah, tanda tangan.
- **Dashboard** diuji di Chromium sungguhan (`tests/e2e`, 66 skenario): mode Demo, WebSocket, MQTT, dan kamera terhadap robot palsu
  (`tools/mock-robot`), termasuk server mati lalu hidup lagi, stream kamera macet, lima ukuran layar, kartu Update Firmware ESP,
  dan tampilan kabel sensor lepas di kedua robot. Setiap tes memastikan **tidak ada satu pun error/peringatan konsol, error halaman, atau request gagal**.
- **GitHub Actions** (`.github/workflows/ci.yml`) menjalankan semua tes di atas dan mengompilasi setiap sketch dengan core asli
  (Uno, ESP32 core 3.0.7 dan core terbaru, saat ini 4.0.0, ESP32-CAM, ESP8266, bridge dan kamera versi EcoBot), lalu memeriksa file `.bin` ESP
  dengan `publish_fw.py`.

```bash
# sekali saja
cd tools/mock-robot && npm install && cd ../../tests && npm install
sudo apt install libmbedtls-dev                  # untuk uji OTA (Linux)
# lalu
cd tests && npm test          # butuh g++ dan Chromium (set CHROMIUM_PATH kalau bukan di /opt/pw-browsers)
python3 -m unittest discover -s tools/ota -p "test_*.py"
```

**Yang belum bisa saya uji, dan perlu Anda lihat sendiri:**

- Sketch ESP (`esp_bridge`, `esp32cam_stream`) hanya dikompilasi (GitHub Actions) dan dijalankan di atas tiruan, belum di papan asli.
  Terutama yang bergantung pada perangkat keras: rollback lewat bootloader, HTTPS ke GitHub Pages, dan OTA ESP32-CAM.
- Deteksi kabel sensor lepas di Uno sudah diuji dengan pin tiruan; di papan asli, coba cabut kabel AO satu sensor dan pastikan
  kartunya menulis *Kabel lepas* dalam beberapa detik.
- Wiring dan perilaku di perangkat keras asli (arus motor, servo, sensor sebenarnya). Ambang sensor api/gas dan jarak EcoBot
  (`FLAME_*`, `GAS_*`, `*_CM`) adalah titik awal yang masuk akal, **bukan hasil kalibrasi**.
- Hanya Chromium yang dipakai untuk menguji tampilan. Firefox dan Safari belum.

## Keterbatasan yang perlu diketahui

- EcoBot tidak punya encoder roda, jadi tidak tahu posisinya. Mode otomatis menyapu dengan pola "memantul" (maju, menghindar, belok acak),
  bukan baris demi baris, sehingga ada bagian lantai yang bisa terlewat. Untuk area tertentu, mode manual dengan kamera lebih teliti.
- EcoBot tidak punya sensor belakang. Saat menghindar, robot hanya mundur sebentar, dan gerak mundur di mode manual tidak dijaga sensor.
- Tidak ada login. Siapa pun di WiFi yang sama bisa mengendalikan robot. Pakai jaringan yang Anda percaya, dan awalan MQTT yang unik.
- ESP32-CAM hanya melayani satu penonton stream dalam satu waktu. Tab kedua akan menampilkan pesan bahwa kamera tidak mengirim gambar.

## Kalau ada masalah

| Gejala | Kemungkinan penyebab |
|---|---|
| "Robot belum merespons" | kabel TX/RX Uno ↔ ESP tertukar atau longgar, baud tidak sama (57600), atau kabel masih terpasang saat upload |
| Uno restart sendiri saat servo bergerak | servo/ESP masih memakai daya dari pin 5 V Uno. Pindahkan ke buck converter |
| ESP32-CAM "Brownout detector" atau video putus-putus | daya kurang. Tambah kapasitor dan pakai 5 V ≥ 1 A |
| Dashboard terus "Menyambung..." dengan `fireguard.local` | alamat `.local` sering tidak jalan di Android, sebagian laptop Windows, dan WiFi kampus. Pakai alamat IP dari Serial Monitor |
| Dashboard https tidak bisa tersambung | browser memblokir `ws://` dari halaman https. Buka lewat `file://` atau `http://` |
| Roda tidak bergerak sama sekali | upload `firmware/tes_motor/` lalu cocokkan hasilnya dengan tabel di panduan rakit (langkah 3). Yang paling sering: GND Uno belum disatukan dengan GND L298N, jumper ENA/ENB dicabut tapi pin ENA/ENB belum disambung, atau baterai cuma satu sel |
| Perintah di Serial Monitor tidak berpengaruh | baud harus 57600. Kalau robot sudah dipindah ke Otomatis, ketik `MODE M` dulu. Baca juga baris `#` yang dibalas Uno |
| Kartu sensor menulis *Kabel lepas* | kabel AO sensor itu lepas atau salah pin. Uno mengabaikannya sampai dipasang lagi |
| Update firmware ESP ditahan / gagal / dikembalikan | baca pesan di kartu *Update Firmware ESP*, lalu tabel *Kalau macet* di [docs/OTA.md](docs/OTA.md) |
| Roda berputar terbalik | `INVERT_LEFT` / `INVERT_RIGHT` di sketch |
| Pompa menyala saat seharusnya mati | `PUMP_ACTIVE_HIGH 0` (modul relay aktif-LOW) |
| Slider kecepatan tidak berpengaruh, motor selalu kencang | jumper ENA/ENB di L298N belum dicabut |
| Relay sapu/pompa langsung menyala saat robot dinyalakan | relay aktif-LOW: `BRUSH_ACTIVE_HIGH 0` / `PUMP_ACTIVE_HIGH 0`; untuk sapu, `BRUSH_USE_PWM` juga harus `0` |
| Relay klik tapi motor sapu/pompa diam | beban harus di terminal NO (bukan NC), dan COM diberi daya |
| Uno restart saat sapu/pompa mulai berputar | pasang dioda flyback di motor sapu/pompa; kalau pakai transistor/MOSFET, naikkan `BRUSH_RAMP_MS` |
| Motor berdengung tapi tidak jalan | naikkan `MIN_PWM`, atau baterai kurang kuat |

## Struktur

```
index.html                  pilih robot
fireguard/  ecobot/         satu dashboard per robot (index.html, logika robot, simulator)
shared/                     dipakai keduanya: css, font, library MQTT, js (koneksi, joystick, kamera, grafik, log, alarm, pengaturan)
firmware/                   sketch Arduino Uno (2), ESP bridge, ESP32-CAM, tes_motor (uji roda tanpa perintah)
docs/                       PROTOKOL.md, WIRING.md, RAKIT-FIREGUARD.md, RAKIT-ECOBOT.md
tools/mock-robot/           robot palsu (WebSocket, MQTT, kamera) untuk uji dan coba-coba
tests/                      uji dashboard (Playwright) dan uji logika firmware (di PC)
```

Semua script memakai `<script>` biasa (bukan ES module) supaya dashboard bisa dibuka langsung dari `file://`.
Semua komunikasi lewat satu modul, `shared/js/link.js`, dan formatnya ada di `docs/PROTOKOL.md`.
Menambah sensor atau aktuator berarti: tambah di sketch, tambah pesannya di protokol, lalu tampilkan di `fireguard.js` atau `ecobot.js`.
