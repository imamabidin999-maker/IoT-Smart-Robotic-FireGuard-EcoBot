# Update firmware lewat WiFi (OTA)

Panduan ini menerapkan materi praktikum OTA (Pertemuan 1 Push OTA, Pertemuan 2 Pull OTA, Pertemuan 3
Safe OTA) ke robot FireGuard. Urutannya sengaja mengikuti checkpoint di modul (C1.x, C2.x, C3.x), jadi
bisa dipakai langsung saat praktikum dan saat menyusun laporan.

Yang bisa di-update lewat WiFi:

| Perangkat | Push OTA (dari Arduino IDE) | Pull OTA (ESP ambil sendiri) | Masa percobaan & rollback |
|---|---|---|---|
| ESP32 bridge (`firmware/esp_bridge`) | ya | ya | ya |
| ESP32-CAM (`firmware/esp32cam_stream`) | ya | tidak | tidak (firmware lama tetap utuh kalau upload putus) |
| Arduino Uno | tidak, tetap lewat USB (lihat bagian akhir) | | |

Semua logika robot ada di Uno, jadi yang paling sering diganti lewat WiFi adalah firmware ESP32 bridge.
Supaya parameter robot (ambang sensor api, kecepatan motor) tetap bisa diubah lewat OTA, ESP32 bisa
mengirim parameter itu ke Uno dengan perintah `CFG` (bagian [Demo](#demo-ubah-parameter-robot-lewat-ota)).

---

## Bedanya dengan contoh kode di modul

Kode contoh modul (P1, P2, P3) dipakai sebagai dasar. Untuk robot ini ada beberapa tambahan, karena
robot punya roda dan pompa yang bisa bergerak sendiri kalau update dilakukan sembarangan.

| Di modul | Di robot ini | Alasannya |
|---|---|---|
| `enterSafeState()` masih kosong | ESP mengirim `STOP` ke Uno setiap kali menyala, saat Push OTA mulai, dan sebelum mengunduh firmware | Motor dan pompa ada di Uno. `STOP` = mode Manual, motor berhenti, pompa mati |
| Pull OTA langsung memasang update | Update hanya **dicek**. Dashboard menampilkan "Update tersedia", lalu dipasang setelah tombol **Pasang** diklik dua kali (atau ketik `u` di Serial Monitor) | Robot jangan sampai restart sendiri di tengah memadamkan api |
| Tidak ada syarat sebelum update | Update ditahan kalau robot sedang mode Otomatis, roda berputar, pompa menyala, atau Uno tidak menjawab | Robot harus diam selama flash ditulis |
| — | Selama update dan masa percobaan, perintah gerak dari dashboard ditolak ESP | Supaya health check "motor diam" tidak terganggu |
| MD5 | MD5 + SHA-256 + penanda versi di dalam file + tanda tangan digital (opsional) | MD5 hanya membuktikan file utuh, bukan asli |
| "Lupa naik versi" baru ketahuan setelah reboot | `publish_fw.py` menolak menerbitkannya, dan ESP menolak memasangnya | Isi file `.bin` membawa penanda `FWID:<produk>:<versi>;` |
| Rollback mengunduh versi `stable` dari server | Rollback dulu ke **slot lama di flash** (tanpa server, tanpa internet). Server hanya cadangan kalau slot lama kosong | Kelemahan yang disebut di modul ("rollback butuh server") jadi hilang |
| Health check: WiFi, memori, I2C | Ditambah: Uno mengirim data, isi Uno memang firmware FireGuard, motor diam, setiap sensor api dan MQ-2 tersambung dan bertenaga, parameter baru sudah diterapkan | Sesuai contoh Smart Robot di slide 18 |
| Crash dihitung sampai 3 kali | Sama, ditambah **watchdog**: program yang macet (bukan crash) di-restart dan ikut dihitung | Program macet tidak akan pernah sampai ke health check |
| Password di `config.h` | Password di `secrets.h` yang tidak ikut ke GitHub. Tanpa password, Push OTA tidak dinyalakan | Repo ini publik |
| Satu Root CA | Beberapa Root CA sekaligus, plus saklar uji `UJI_ROOT_CA_SALAH` | Server bisa ganti penerbit sertifikat |

---

## Persiapan (sekali saja)

1. **Arduino IDE**: Boards Manager → *esp32 by Espressif Systems* versi 3.x. Library Manager:
   **WebSockets** (Markus Sattler) dan **ArduinoJson** (Benoit Blanchon, versi 7.x).
2. **Partition Scheme** (menu Tools), penting untuk OTA:
   - ESP32 DevKit (*ESP32 Dev Module*): **Default 4MB with spiffs**. Jangan *Huge APP (No OTA)*.
   - ESP32-CAM (*AI Thinker ESP32-CAM*): **Minimal SPIFFS (1.9MB APP with OTA)**. Bawaan board ini adalah
     *Huge APP (No OTA)* yang tidak punya slot kedua.

   Skema partisi hanya berubah kalau di-upload lewat USB. Jadi upload lewat USB dulu sekali dengan skema
   yang benar, baru setelah itu OTA bisa dipakai.
3. **Isi `secrets.h`**. Di Arduino IDE, buka `firmware/esp_bridge/esp_bridge.ino`, klik tombol `...` di kanan
   deretan tab → *New Tab* → ketik `secrets.h`. Salin isi `secrets.example.h` ke tab itu, lalu isi:

   ```cpp
   #define WIFI_SSID     "LAB-IOT-OTA"            // WiFi lab dari dosen (atau hotspot HP)
   #define WIFI_PASS     "..."
   #define GROUP_ID      "kel04"                  // ID kelompok
   #define OTA_PASSWORD  "..."                    // password OTA kelompok
   #define SERVER_BASE   "http://192.168.10.23:8000"   // IP laptop yang menjalankan server (Pertemuan 2)
   ```

   `secrets.h` tidak ikut ter-upload ke GitHub (sudah ada di `.gitignore`). Lakukan hal yang sama untuk
   ESP32-CAM di folder `firmware/esp32cam_stream`.
4. **Firmware Uno minimal v1.4.0** (`firmware/fireguard_uno`), upload lewat USB seperti biasa. Versi ini
   menyala dalam mode Manual, menerima perintah `CFG`, dan melaporkan kabel sensor yang lepas (`fe`/`ge` di
   telemetri). Tanpa itu, health check C3.4 tidak bisa membedakan sensor yang dicabut.
5. Upload `esp_bridge` lewat USB. Buka Serial Monitor (115200). Baris pertamanya kira-kira:

   ```
   === kel04 | fireguard | esp32 | firmware v1.2.0 ===
   Penanda versi: FWID:fireguard-bridge:1.2.0;
   [State] versi v1.2.0 | pending='' attempts=0 blacklisted='' lastGood='1.2.0'
   Tersambung. IP: 192.168.10.31
   [OTA] Push OTA siap. Di Arduino IDE pilih port jaringan "fireguard" (192.168.10.31).
   [OTA] Pull OTA: http://192.168.10.23:8000/kel04/manifest-fireguard-bridge.json
   ```

   Kalau WiFi di `WIFI_SSID` tidak ditemukan, robot membuat WiFi sendiri (`fireguard-robot`). Push OTA tetap
   bisa (laptop disambungkan ke WiFi robot), tapi Pull OTA tidak, karena robot tidak bisa menjangkau server.

Nama robot di jaringan (`fireguard`) juga dipakai Arduino IDE sebagai nama port. Kalau asisten meminta format
`iot-kel04`, tambahkan `#define NET_HOSTNAME "iot-kel04"` di `secrets.h`. Alamat di dashboard ikut menjadi
`iot-kel04.local` (atau tetap pakai IP).

**Sebelum OTA apa pun, angkat roda robot dari meja** (aturan 3 di modul). Robot memang dihentikan otomatis,
tapi tetap lebih aman.

---

## Pertemuan 1 — Push OTA

### C1.1 Upload USB, hostname & IP

Sudah dilakukan di persiapan nomor 5. Untuk laporan, foto/tangkap layar baris `===`, `Tersambung. IP:` dan
`[OTA] Push OTA siap`.

### C1.2 Upload lewat WiFi

1. Di `config.h`, naikkan `FW_VERSION`, misalnya `"1.2.0"` → `"1.2.1"`. Kalau perlu tanda yang terlihat,
   ubah juga salah satu parameter di bagian bawah `config.h`.
2. Tools → Port → di bagian *Network ports* pilih **fireguard at 192.168.10.31**. Laptop harus di WiFi yang
   sama. Kalau tidak muncul setelah satu menit, izinkan Arduino IDE di firewall.
3. Klik Upload, ketik password OTA. Di Serial Monitor (lewat USB) atau di kartu **Update Firmware ESP** di
   dashboard akan terlihat:

   ```
   [OTA] Mulai menerima firmware lewat WiFi. Robot dihentikan.
   [OTA] Progres: 10% ... 100%
   [OTA] v1.2.1 diterima lewat Push OTA. Restart ke masa percobaan...
   [SafeOTA] TRIAL BOOT v1.2.1, percobaan 1/3
   [Health] Menjalankan health check (maks 30 detik)...
   [Health] LULUS
   [SafeOTA] v1.2.1 dikonfirmasi VALID
   ```

   Ya, Push OTA juga mendapat masa percobaan. Health check-nya dijelaskan di Pertemuan 3.

### C1.3 Uji password salah dan cabut daya

- **Password salah**: Arduino IDE menulis *Authentication Failed*, Serial Monitor/dashboard menulis
  `Push OTA gagal (Error[0]): password OTA salah. Firmware lama tetap dipakai.`
- **Cabut daya di tengah upload**: naikkan versi lagi, upload, cabut daya saat progres sekitar 50%, nyalakan
  lagi. Yang jalan tetap versi lama. Firmware baru ditulis ke slot yang sedang tidak dipakai, dan ESP baru
  pindah slot setelah seluruh file diterima dan dicek. Slot lama tidak tersentuh sama sekali.

### C1.4 Safe state

Jalankan robot (roda diangkat) dalam mode Manual sambil joystick ditahan, lalu mulai Push OTA. Roda harus
berhenti begitu transfer dimulai (ESP mengirim `STOP` ke Uno). Selama transfer, perintah gerak dari dashboard
ditolak. Setelah ESP restart, ia mengirim `STOP` lagi, jadi robot tidak mungkin melanjutkan gerak lama.

Safe state robot ini: **semua motor berhenti, pompa mati, nozzle kembali ke tengah, mode Manual.** Uno
sendiri juga menyala dalam mode Manual, jadi kalau Uno ikut restart pun robot tetap diam.

---

## Pertemuan 2 — Pull OTA

### C2.1 Server lokal + manifest

1. Buat folder server di luar repo, misalnya `../fireguard-ota` (sejajar dengan folder repo ini).
2. Di Arduino IDE: **Sketch → Export Compiled Binary**. Hasilnya ada di
   `firmware/esp_bridge/build/esp32.esp32.esp32/esp_bridge.ino.bin`. Pilih file itu, **bukan**
   `...merged.bin`, `...bootloader.bin`, atau `...partitions.bin`.
3. Terbitkan versi yang sedang terpasang sebagai `latest` sekaligus `stable` (jalankan dari folder repo):

   ```
   python tools/ota/publish_fw.py --root ../fireguard-ota --base-url http://192.168.10.23:8000 \
       --group kel04 --channel both --bin firmware/esp_bridge/build/esp32.esp32.esp32/esp_bridge.ino.bin
   ```

   Versi dan nama produk dibaca dari isi file, jadi `--version` tidak perlu ditulis. Skrip menolak file yang
   salah pilih, bukan untuk ESP32, terlalu besar untuk slot OTA, atau versinya tidak naik.
4. Jalankan server: `python -m http.server 8000 --directory ../fireguard-ota`. IP laptop harus sama dengan
   `SERVER_BASE` di `secrets.h`.

Isi manifest yang dibuat (`../fireguard-ota/kel04/manifest-fireguard-bridge.json`):

```json
{
  "product": "fireguard-bridge",
  "board": "esp32",
  "latest": {
    "version": "1.2.0",
    "url": "http://192.168.10.23:8000/kel04/fireguard-bridge-1.2.0.bin",
    "md5": "…", "sha256": "…", "size": 1043568
  },
  "stable": { "...": "sama" }
}
```

Nama manifest memakai nama produk (`fireguard-bridge`), bukan `esp32` seperti di modul, karena satu kelompok
bisa punya beberapa ESP32 (bridge FireGuard, bridge EcoBot, kamera) dan masing-masing butuh manifest sendiri.

### C2.2 ESP update sendiri 1.2.0 → 1.3.0

1. Naikkan `FW_VERSION` ke `"1.3.0"`, Export Compiled Binary, terbitkan (tanpa `--channel`, artinya `latest`).
2. ESP mengecek server 10 detik setelah menyala lalu tiap 5 menit (`CHECK_INTERVAL_MS`), tapi hanya saat
   robot diam. Bisa juga langsung: klik **Cek update** di dashboard, atau ketik `c` di Serial Monitor.
3. Dashboard menampilkan **Update tersedia v1.3.0**. Pastikan robot di mode Manual dan diam, lalu klik
   **Pasang v1.3.0**, dan klik sekali lagi untuk konfirmasi. Dari Serial Monitor: ketik `u`.
4. Yang terjadi: robot dihentikan → unduh (ada progres) → SHA-256, penanda versi, tanda tangan, dan MD5
   diperiksa → ESP restart → masa percobaan → **VALID**.

Kalau ingin persis seperti modul (langsung dipasang tanpa tombol), ubah `OTA_PASANG_OTOMATIS` jadi `1` di
`config.h`. Syarat robot diam tetap berlaku.

### C2.3 Tiga pengaman (+ satu jebakan)

| Uji | Cara | Yang terlihat |
|---|---|---|
| Downgrade | `publish_fw.py ... --paksa` dengan file versi lebih rendah (`--paksa` diperlukan karena skrip sendiri menolak versi turun) | `Sudah versi terbaru (perangkat v1.3.0, server v1.0.5).` |
| MD5 salah | Ubah satu huruf `md5` di manifest | File selesai diunduh, lalu `Verifikasi akhir gagal (MD5 Check Failed). Firmware lama tetap dipakai.` |
| Board salah | Ubah `"board"` jadi `"esp8266"` | `manifest untuk board 'esp8266', perangkat ini 'esp32'`, file `.bin` tidak diunduh sama sekali |
| Lupa naik versi | Terbitkan file v1.3.0 sebagai 1.4.0: `publish_fw.py ... --version 1.4.0 --lewati-cek-versi` | `Isi file melapor v1.3.0, padahal manifest v1.4.0 (lupa menaikkan FW_VERSION?). Tidak dipasang.` Tidak ada siklus unduh berulang seperti di slide 15 |

Kembalikan manifest seperti semula setelah tiap uji (terbitkan ulang dengan `publish_fw.py`). Untuk bukti,
simpan baris log `[Manifest]`, `[Versi]`, dan `[OTA]`.

Uji tambahan yang tidak ada di modul:

| Uji | Cara | Yang terlihat |
|---|---|---|
| File diganti di server | Ganti isi file `.bin` di server tanpa mengubah manifest | `Sidik jari SHA-256 tidak cocok dengan manifest...` |
| Firmware robot lain | Terbitkan firmware EcoBot ke folder FireGuard | ESP tidak pernah mengambilnya (manifest berbeda). Kalau dipaksa lewat Push OTA: `upload 'ecobot-bridge' ... dibatalkan` |
| Firmware Uno terlalu lama | `publish_fw.py ... --min-uno 1.5.0` | `butuh firmware Uno minimal v1.5.0, Uno masih v1.4.0. Update Uno lewat USB dulu.` |

### C2.4 HTTPS lewat GitHub Pages

1. Buat repo publik baru di GitHub, mis. `fireguard-ota`. Settings → Pages → *Deploy from a branch* → `main`,
   folder `/ (root)`. Clone repo itu ke laptop, misalnya ke `../fireguard-ota` (pakai folder ini sebagai
   `--root`). Tambahkan file kosong bernama `.nojekyll` di dalamnya supaya GitHub tidak memproses ulang file.
2. Terbitkan dengan alamat GitHub Pages, lalu commit dan push repo `fireguard-ota`:

   ```
   python tools/ota/publish_fw.py --root ../fireguard-ota --base-url https://NAMAAKUN.github.io/fireguard-ota \
       --group kel04 --bin firmware/esp_bridge/build/esp32.esp32.esp32/esp_bridge.ino.bin
   ```
3. Di `secrets.h`: `#define SERVER_BASE "https://NAMAAKUN.github.io/fireguard-ota"`. Robot harus tersambung ke
   WiFi yang punya internet (WiFi lab belum tentu; hotspot HP bisa). Upload lewat USB/Push OTA.
4. Saat cek update lewat HTTPS, ESP menyamakan jam lewat NTP dulu, lalu memeriksa sertifikat server dengan
   Root CA di `root_ca.h`. Tidak ada `setInsecure()`.
5. **Uji Root CA salah**: set `UJI_ROOT_CA_SALAH 1` di `config.h`, upload, klik **Cek update**. Harus gagal:
   `Tidak bisa tersambung aman ke server (...). Server mati, atau Root CA tidak cocok.` Kembalikan ke `0`.

`root_ca.h` sudah berisi beberapa Root CA umum (ISRG/Let's Encrypt, USERTrust/Sectigo, DigiCert G2, Google).
Cara mengecek Root CA server sendiri ada di komentar file itu (perintah `openssl` dari modul bagian 5.4).

---

## Pertemuan 3 — Safe OTA

### Cara kerjanya di robot ini

```
pasang v1.3.0 (Pull/Push) ─► ESP restart ─► TRIAL BOOT, percobaan 1/3
                                              │
                         health check (maks 30 detik, harus lolos terus 3 detik):
                         WiFi/AP aktif · memori cukup · Uno mengirim data · isi Uno = fireguard ·
                         motor diam · tiap sensor api & MQ-2 tersambung dan bertenaga ·
                         parameter dari config.h sudah diterapkan di Uno
                                              │
                    lolos ◄───────────────────┴──────────────────► gagal / crash 3× / macet 3×
                      │                                                   │
          VALID: v1.3.0 dicatat lastGood                 ROLLBACK: v1.3.0 masuk blacklist,
                                                         ESP boot lagi dari slot lama (v1.2.0),
                                                         tanpa server. Kalau slot lama kosong,
                                                         baru unduh versi "stable" dari server.
```

Status disimpan di NVS (`Preferences`), jadi tetap ada walau listrik mati atau firmware diganti.
Ketik `s` di Serial Monitor untuk melihatnya. Hasil terakhir juga tampil di dashboard (baris **Terakhir**).

### C3.1 Trial boot → VALID

Terbitkan versi baru seperti C2.2. Log yang dicari: `TRIAL BOOT`, `[Health] LULUS`, `dikonfirmasi VALID`.
Setelah VALID, jadikan versi itu juga `stable`:

```
python tools/ota/publish_fw.py --root ../fireguard-ota --group kel04 --promosikan
```

### C3.2 Health check gagal (FAULT_MODE 1)

`FAULT_MODE 1` di `config.h`, naikkan versi, terbitkan, pasang. Selama 30 detik dashboard menulis
`Masa percobaan v...: menunggu FAULT_MODE 1: health check sengaja digagalkan`, lalu:

```
[Health] TIDAK LULUS: FAULT_MODE 1: health check sengaja digagalkan
[SafeOTA] ROLLBACK v1.4.0: health check gagal (...)
```

ESP restart ke versi lama. Coba terbitkan versi yang sama lagi: ESP menolak (`pernah gagal di robot ini`).
**Kembalikan `FAULT_MODE` ke `0`** sebelum membuat versi berikutnya.

### C3.3 Crash berulang (FAULT_MODE 2)

`FAULT_MODE 2`: firmware baru crash di setiap boot masa percobaan. Hitung bersama di Serial Monitor:
`percobaan 1/3` crash, `2/3` crash, `3/3` crash, lalu di boot ke-4
`ROLLBACK v...: crash/reboot 3 kali saat masa percobaan`. Hitungan dicek paling awal di `setup()`, sebelum
kode yang crash sempat berjalan.

`FAULT_MODE 3` (tambahan): program macet tanpa crash. Watchdog me-restart ESP setelah `LOOP_WDT_MS`
(15 detik) dan restart itu ikut dihitung. Hasil akhirnya sama: rollback setelah percobaan ke-3.

### C3.4 Health check nyata: sensor dicabut

1. Pastikan `FAULT_MODE 0`. Cabut **kabel AO salah satu sensor api** di sisi Uno (A0 atau A1). Dalam ±2
   detik dashboard menandai kartu sensor itu **Kabel lepas** dan muncul banner kuning. Uno mendeteksinya
   sendiri: pin yang tidak tersambung ke apa pun ditarik LOW lalu HIGH sebentar, dan pin yang mengambang
   terbaca ikut berubah, sedangkan sensor yang tersambung tetap di nilainya.
2. Naikkan versi, terbitkan, pasang. Hasilnya:

   ```
   [Health] TIDAK LULUS: sensor api Kanan tidak tersambung (kabel AO lepas?)
   [SafeOTA] ROLLBACK v1.5.0: health check gagal (sensor api Kanan tidak tersambung (kabel AO lepas?))
   ```
3. Pasang lagi kabelnya, naikkan versi sekali lagi (versi yang gagal tadi sudah masuk blacklist), terbitkan,
   pasang. Kali ini **VALID**.

Bisa juga dengan MQ-2 (kabel AO) atau dengan mencabut kabel VCC sensor: sensor tanpa daya terbaca 0, dan
health check menulis `terbaca 0 (tanpa daya?)`.

Kenapa batasnya begitu (pertanyaan analisis nomor 4): health check menunggu sampai 30 detik dan baru
menyatakan lolos setelah semua pemeriksaan lolos terus selama 3 detik. Sensor yang lambat tidak langsung
membuat rollback, tapi sensor yang benar-benar lepas pasti ketahuan. Yang **tidak** diperiksa: ada atau
tidaknya api, dan kadar gas, karena keduanya bergantung pada keadaan ruangan, bukan pada firmware.

### Rollback lewat bootloader (pengayaan)

Dengan `ROLLBACK_BOOTLOADER 1`, firmware baru tidak langsung ditandai sah saat menyala. Kalau ia crash sebelum
health check selesai, bootloader ESP-IDF sendiri yang kembali ke versi lama pada boot berikutnya, tanpa
menunggu 3 kali. Ini menutup celah yang disebut di slide 11: crash yang terjadi sebelum kode penghitung
sempat berjalan. Bawaannya `0` supaya log C3.3 sama seperti di modul.

---

## Demo: ubah parameter robot lewat OTA

Ambang sensor dan kecepatan mode otomatis tersimpan di Uno, tapi bisa diganti dari firmware ESP:

1. Di `config.h`: misalnya `PARAM_API_WASPADA 650` dan `PARAM_API_BAHAYA 350` (aturannya: waspada > bahaya,
   karena nilai kecil berarti api). Naikkan versi, terbitkan, pasang.
2. Setelah restart, ESP mengirim `CFG F 650 350` ke Uno. Uno membalas pesan `info` dengan nilai baru, dan garis
   ambang di grafik **Riwayat Sensor** di dashboard ikut berpindah.
3. Masa percobaan baru lolos kalau nilai itu benar-benar sudah dipakai Uno.

Parameter lain: `PARAM_GAS_WASPADA`/`PARAM_GAS_BAHAYA` (gas: waspada < bahaya), `PARAM_PWM_PUTAR`/`PARAM_PWM_MAJU`
(1..255). Nilai `0` berarti memakai nilai bawaan Uno. Kalau Uno restart, ESP mengirim ulang nilainya.

Untuk demo 2 menit: tunjukkan grafik sebelum update → tekan **Pasang** di dashboard (robot berhenti) →
masa percobaan → VALID → garis ambang di grafik sudah pindah. Lalu jelaskan health check-nya.

---

## Tanda tangan digital (pengayaan)

MD5 dan HTTPS tidak cukup kalau server sendiri yang dibobol: penyerang bisa mengganti file sekaligus sidik
jarinya. Tanda tangan dibuat dengan kunci rahasia yang hanya ada di laptop kelompok, tidak pernah di server.

1. Sekali saja: `python tools/ota/keygen.py`. Kunci rahasia disimpan di `tools/ota/kunci/ota_private.pem`
   (tidak ikut ke GitHub). Kunci publik ditulis ke `firmware/esp_bridge/ota_pubkey.h`.
2. Upload `esp_bridge` lewat USB sekali. Serial Monitor menulis `Tanda tangan firmware: WAJIB`.
3. Sejak itu `publish_fw.py` otomatis menandatangani setiap file (field `sig` di manifest), dan ESP menolak
   firmware tanpa tanda tangan atau dengan tanda tangan yang salah:
   `Tanda tangan tidak sah (...). File ini bukan dari pemegang kunci rahasia. Tidak dipasang.`

Yang ditandatangani adalah gabungan produk, board, versi, ukuran, dan SHA-256 file. Akibatnya, orang yang
tidak punya kunci juga tidak bisa memberi nomor versi baru pada file lama. Simpan cadangan kunci rahasia di
flashdisk. Kalau kunci hilang, buat kunci baru (`keygen.py --ganti`) dan upload ulang ESP lewat USB.

Alat ini hanya butuh Python 3 biasa, tanpa `pip install`.

---

## ESP32-CAM

Kamera hanya mendukung Push OTA: isi `OTA_PASSWORD` di `firmware/esp32cam_stream/secrets.h`, pilih Partition
Scheme **Minimal SPIFFS (1.9MB APP with OTA)**, upload lewat USB sekali. Setelah itu kamera muncul sebagai
port jaringan `fireguard-cam`, dan GPIO0 tidak perlu disentuh lagi. Saat upload dimulai, stream dihentikan dan
lampu flash dimatikan. Kalau partisinya tanpa OTA, Serial Monitor kamera menulis
`Push OTA tidak bisa dipakai: Partition Scheme tanpa slot OTA`.

---

## Bagaimana dengan Arduino Uno?

Uno tidak punya WiFi dan hanya bisa diprogram lewat bootloader-nya di jalur serial (D0/D1) dengan sinyal
reset tepat sebelum upload. Secara teknis ESP32 bisa menjadi "programmer" Uno lewat WiFi, tapi butuh rangkaian
tambahan (transistor NPN + resistor dari GPIO ESP32 ke pin RESET Uno), jalur serial yang dibagi antara
telemetri dan upload, dan firmware ESP yang meniru protokol STK500. Itu kami catat sebagai pengembangan
berikutnya. Untuk sekarang:

- Firmware Uno tetap di-upload lewat USB (cabut kabel D0/D1 dulu).
- Parameter yang paling sering diubah (ambang dan kecepatan) sudah bisa diganti lewat OTA ESP dengan `CFG`.
- Kalau sebuah firmware ESP butuh Uno versi tertentu, terbitkan dengan `--min-uno`, maka ESP tidak akan
  memasangnya sebelum Uno diperbarui.

---

## Log untuk laporan

Ambil potongan yang memuat kata kunci ini saja:

| Checkpoint | Kata kunci di log |
|---|---|
| C1.1 | `===`, `Tersambung. IP`, `Push OTA siap` |
| C1.2 | `Mulai menerima firmware`, `diterima lewat Push OTA`, `dikonfirmasi VALID` |
| C1.3 | `password OTA salah`, versi yang jalan setelah cabut daya |
| C1.4 | `Robot dihentikan`, baris `"m":"M"` dan `"sp":0` di telemetri |
| C2.2 | `[Manifest] GET`, `[Versi]`, `[OTA] Mengunduh`, `semua pemeriksaan lolos` |
| C2.3 | `Sudah versi terbaru`, `MD5 Check Failed`, `manifest untuk board`, `Isi file melapor` |
| C2.4 | URL `https://`, `Tidak bisa tersambung aman` (uji Root CA salah) |
| C3.1 | `TRIAL BOOT`, `[Health] LULUS`, `VALID` |
| C3.2–3.4 | `TIDAK LULUS`, `percobaan 1/3 … 3/3`, `ROLLBACK`, `blacklisted=` |

Dashboard juga mencatat setiap langkah update di kartu **Aktivitas Terbaru** (bisa diunduh sebagai CSV).

---

## Kalau macet

| Gejala | Penyebab dan solusi |
|---|---|
| Port jaringan tidak muncul di Arduino IDE | Laptop beda WiFi dengan robot, firewall memblokir Arduino IDE, atau `OTA_PASSWORD` masih kosong (Serial Monitor menulis `Push OTA mati`) |
| `Error[1]` / `begin error` saat Push OTA | Partition Scheme tanpa OTA. Pilih *Default 4MB with spiffs*, upload lewat USB sekali |
| Upload berhenti di tengah / timeout | WiFi lemah. Dekatkan laptop ke robot |
| `Pull OTA mati: SERVER_BASE belum diisi` | Isi `SERVER_BASE` di `secrets.h` |
| `Robot sedang membuat WiFi sendiri (mode AP)` | WiFi di `WIFI_SSID` tidak ditemukan saat ESP menyala. Cek nama/password, harus 2,4 GHz |
| `Manifest gagal diambil, HTTP -1` | Server di laptop belum jalan, IP laptop berubah, atau firewall memblokir Python |
| `Manifest tidak ada di server (HTTP 404)` | `GROUP_ID` di `secrets.h` beda dengan `--group`, atau belum menjalankan `publish_fw.py` |
| `Ukuran file di server ... manifest bilang ...` | File disalin manual. Terbitkan ulang dengan `publish_fw.py` |
| `Jam belum tersinkron (NTP gagal)` | WiFi tanpa internet. Pakai hotspot HP untuk Langkah B |
| `Tidak bisa tersambung aman ke server` padahal `UJI_ROOT_CA_SALAH 0` | Root CA server tidak ada di `root_ca.h`. Cek dengan `openssl` (lihat komentar di `root_ca.h`) |
| `Update ... belum dipasang: Robot sedang mode Otomatis` | Klik Manual (atau STOP) di dashboard, lalu Pasang lagi |
| `Uno tidak mengirim data` | Kabel TX/RX Uno ↔ ESP32 atau daya Uno. Untuk menguji ESP sendirian di meja, set `OTA_BUTUH_UNO 0` |
| Rollback terus padahal `FAULT_MODE 0` | Baca alasan di `[Health] TIDAK LULUS: ...`. Paling sering sensor lepas/tanpa daya, atau Uno belum v1.4.0 (`Uno belum mendukung CFG`) |
| `pernah gagal di robot ini` | Versi itu masuk blacklist. Perbaiki, naikkan nomor versi, terbitkan lagi |
| `Firmware tidak ditandatangani` | Robot sudah punya kunci publik. Terbitkan dengan kunci rahasia (`tools/ota/kunci/ota_private.pem`) |
| `Tanda tangan tidak sah` | Kunci rahasia yang dipakai bukan pasangan kunci publik di robot (mis. kunci dibuat ulang). Upload ulang ESP lewat USB setelah `keygen.py` |
| `GAGAL: ... versi latest sekarang v...` di `publish_fw.py` | Versi harus naik. Naikkan `FW_VERSION`, compile, Export Compiled Binary lagi |
| `GAGAL: ... lupa naik versi` di `publish_fw.py` | `--version` beda dengan isi file. Hapus `--version` (versi dibaca dari file) atau naikkan `FW_VERSION` |
| Status OTA aneh setelah memakai sketch lain | Sisa NVS dari sketch lain. Status otomatis dibuang kalau tidak cocok; kalau masih aneh, Tools → Erase All Flash Before Sketch Upload → Enabled, upload sekali, lalu kembalikan |

---

## Menguji tanpa hardware

Alur di atas sudah diuji di PC dengan menjalankan sketch `esp_bridge.ino` yang asli di atas ESP32 tiruan
(flash dua slot, bootloader, NVS, server, Uno palsu). Skenarionya mengikuti checkpoint C1–C3:

```
node --test tests/bridge-host/core.test.mjs tests/bridge-host/ota.test.mjs   # butuh g++ dan libmbedtls-dev
python -m unittest discover -s tools/ota -p "test_*.py"                      # publish_fw.py, keygen.py
```

Mode **Demo** di dashboard juga punya simulasi update (tombol Cek update dan Pasang bisa dicoba tanpa robot).
