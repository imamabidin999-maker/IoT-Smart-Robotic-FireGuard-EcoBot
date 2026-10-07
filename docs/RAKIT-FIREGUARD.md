# Merakit FireGuard (robot pemadam api) langkah demi langkah

Panduan ini mengikuti pin dan pengaturan di `firmware/fireguard_uno/fireguard_uno.ino`. Detail teknis tiap
bagian ada di [WIRING.md](WIRING.md); di sini fokusnya urutan kerja.

Sama seperti EcoBot: **rakit sedikit, uji, lalu lanjut.** Apalagi robot ini membawa air dan nantinya diuji
dengan api sungguhan, jadi tiap bagian harus sudah pasti jalan sebelum digabung.

---

## 0. Siapkan komponen dan alat

**Dari daftar Anda**

- Chassis 4WD + 4 motor DC TT + roda
- 1 modul L298N
- 2 baterai 18650
- 2 sensor api IR (modul 4 pin: VCC, GND, DO, AO)
- 1 sensor gas MQ-2 (boleh 2)
- Arduino Uno
- ESP32 (ESP extension)
- ESP32-CAM
- 1 mini servo (SG90 / MG90S), untuk mengarahkan nozzle

**Yang perlu ditambah**

| Barang | Untuk apa |
|---|---|
| Holder baterai 2S (2 sel seri) + BMS 2S | baterai jadi 7,4 V, dan aman dari kelebihan/kekurangan isi |
| Saklar on/off | memutus baterai (sering sudah ikut di kit chassis) |
| Buck converter 5 V, minimal 3 A (LM2596, atau XL4015 yang lebih kuat) | daya 5 V untuk ESP32, ESP32-CAM, servo, MQ-2, relay, dan pompa |
| Pompa air celup mini DC 3–6 V | penyemprot air |
| Selang silikon ±50 cm (diameter mengikuti pipa pompa, biasanya 5–8 mm) | dari pompa ke nozzle |
| Botol plastik 300–600 ml | tangki air |
| Modul relay 1 kanal 5 V | saklar pompa |
| Dioda 1N4007 | pelindung kontak relay dari lonjakan tegangan pompa |
| Resistor 1 kΩ dan 2 kΩ | menurunkan tegangan sinyal Uno → ESP32 |
| Kapasitor elektrolit 470 µF 16 V | penstabil daya ESP32-CAM |
| Kabel jumper, terminal, baut-spacer, lem tembak, isolasi, cable tie | perakitan |
| Adaptor USB-TTL atau papan ESP32-CAM-MB | upload ke ESP32-CAM |
| (opsional) 2 resistor 10 kΩ | mengukur baterai |
| Untuk uji: lilin kecil, piring/nampan logam, korek, ember kecil | kalibrasi dan uji semprot |

Kalau tidak mau memakai air, pompa bisa diganti kipas kecil (motor DC + baling-baling) yang disambung lewat
relay yang sama. Kode tidak perlu diubah, tapi kipas hanya cukup untuk api kecil seperti lilin.

**Alat:** obeng, tang potong, solder, **multimeter** (wajib untuk mengecek tegangan), cutter, lem tembak, lap.

---

## 1. Rakit bagian mekanik

Lihat robot dari atas:

```
                          DEPAN
     [Api Kiri]      nozzle di servo      [Api Kanan]
          \            ESP32-CAM             /
      ┌───────────────────────────────────────┐
      │(roda)                           (roda)│
      │      Uno · L298N · ESP32 · buck ·     │  ← dek atas
      │      relay        MQ-2 (paling atas)  │
      │                                       │
      │    ┌─────────────────────────────┐    │
      │    │  TANGKI AIR + pompa celup   │    │  ← dek bawah, serendah mungkin
      │    └─────────────────────────────┘    │
      │(roda)       baterai 2S          (roda)│
      └───────────────────────────────────────┘
                        BELAKANG
```

1. **Rakit chassis, motor, dan roda** sesuai petunjuk kit. Kabel motor biarkan panjang dulu.
2. **Pisahkan air dan elektronik.** Tangki air dan baterai di dek bawah, elektronik di dek atas. Kalau
   chassis cuma satu tingkat, tambah pelat akrilik/PCB bekas di atas spacer sebagai dek kedua. Ikat tangki
   dengan kuat, karena air yang bergoyang bisa membuat robot oleng saat berbelok.
3. **Buat nozzle.** Masukkan pompa ke tangki, sambungkan selang, lalu ujung selang dijepit/dilem ke lengan
   servo. Ujung selang yang dipersempit (pakai sedotan kaku atau ujung pulpen bekas) membuat semprotan lebih
   jauh. Servo dipasang di depan tengah. **Lengan servo (horn) jangan dipasang dulu**, nanti di langkah 6.
4. **Pasang dua sensor api** di sudut depan kiri dan kanan, setinggi ±5–10 cm dari lantai (kira-kira setinggi
   api lilin). Hadapkan ke depan dan sedikit serong ke luar (±20–30°), supaya api yang lurus di depan
   terlihat oleh keduanya. Pastikan tidak tertutup selang atau nozzle.
5. **MQ-2** di bagian paling atas (asap naik ke atas), jauh dari arah semprotan air.
6. **ESP32-CAM** di depan, sedikit lebih tinggi dari nozzle, menghadap ke depan. Beri pelindung kecil supaya
   tidak terkena cipratan.
7. Uno, L298N, ESP32, buck, dan relay ditaruh di dek atas, tidak tepat di bawah sambungan selang.

---

## 2. Jalur daya (sebelum ada modul lain yang tersambung)

```
Baterai 2S (+) ── saklar ──┬── L298N +12V
                           ├── Uno VIN
                           └── buck IN+ ──► 5 V: ESP32, ESP32-CAM, servo, MQ-2, relay, pompa
Baterai 2S (−) ────────────┴── GND semua modul (L298N, Uno, buck, ESP32, ESP32-CAM, relay, sensor)
```

1. Pasang 2 sel 18650 di holder 2S (+ BMS). Ukur dengan multimeter: harus **7,4–8,4 V**.
2. Pasang saklar di kabel + baterai.
3. Sambungkan baterai ke **input buck converter saja dulu**. Nyalakan, ukur output buck, lalu putar trimpot
   sampai **5,0–5,1 V**. Matikan lagi. Langkah ini wajib: buck baru biasanya keluar tegangan sembarang dan bisa
   merusak ESP32.
4. Siapkan "jalur GND bersama" (satu terminal atau titik solder) untuk semua GND.

---

## 3. Arduino Uno + L298N + motor roda

1. **Cabut jumper kecil di pin ENA dan ENB** pada L298N. Jumper 5V-EN di dekat terminal +12V biarkan.
2. Dua motor kiri (depan + belakang) dipasang **paralel** ke OUT1/OUT2. Dua motor kanan ke OUT3/OUT4.
   Sebelum dikunci, cek dulu: kalau diberi daya, dua motor di sisi yang sama harus berputar ke arah yang sama.
   Kalau tidak, tukar dua kabel salah satu motor.
3. L298N +12V ← baterai (+), GND ← GND bersama.
4. Kabel sinyal L298N ke Uno:

   | L298N | Uno |
   |---|---|
   | ENA | D5 |
   | IN1 | D7 |
   | IN2 | D8 |
   | IN3 | D9 |
   | IN4 | D10 |
   | ENB | D6 |

5. Uno VIN ← baterai (+), Uno GND ← GND bersama.
6. **Upload sketch** `firmware/fireguard_uno/fireguard_uno.ino` lewat USB (D0/D1 jangan dulu disambung ke apa pun).
7. **Uji lewat Serial Monitor**, dengan roda **diangkat** dari lantai:
   - Arduino IDE → Serial Monitor, baud **57600**, akhir baris **Newline**.
   - Akan terlihat baris JSON 4× per detik. Itu normal.
   - **Ketik `MODE M` dulu.** FireGuard selalu menyala dalam mode Otomatis (diam menunggu api), dan di mode
     itu perintah gerak dari luar diabaikan.
   - Ketik `DRV 0 60` lalu Enter. Semua roda harus berputar **maju** sekitar setengah detik lalu berhenti
     sendiri. Robot memang berhenti sendiri kalau perintah tidak diulang (pengaman dead-man).
   - Ketik `DRV 60 0`. Robot harus berputar ke **kanan**: roda kiri maju, roda kanan mundur.
   - Roda berputar terbalik? Tukar dua kabel motor di OUT sisi itu, atau ubah `INVERT_LEFT` / `INVERT_RIGHT`
     jadi `1` lalu upload ulang.
   - Ketik `SPD 90` lalu `DRV 0 60` lagi. Roda harus lebih pelan. Kalau tetap kencang, jumper ENA/ENB belum dicabut.

---

## 4. Dua sensor api

Setiap modul punya 4 pin. Yang dipakai **AO** (analog), DO dibiarkan kosong.

| Pin modul | Sensor Kiri | Sensor Kanan |
|---|---|---|
| AO | A0 | A1 |
| VCC | 5V Uno | 5V Uno |
| GND | GND | GND |
| DO | — | — |

**Uji:** ketik `GET`, lalu cari `"fl":[...]` di baris yang muncul. Angka pertama = Kiri, kedua = Kanan.

- Tanpa api, angkanya besar (biasanya ratusan sampai mendekati 1023, tergantung cahaya ruangan).
- Nyalakan korek ±30 cm di depan sensor kiri: angka pertama harus turun. Pindah ke kanan: angka kedua yang turun.
  Kalau tertukar, tukar kabel AO-nya.
- `"fs":[...]` adalah statusnya: `0` aman, `1` waspada, `2` api.

Catatan:

- Pada kebanyakan modul, potensio biru hanya mengatur kapan pin **DO** dan LED kecilnya menyala, tidak
  mengubah angka AO. Karena firmware membaca AO, kalibrasi dilakukan lewat angka `FLAME_WARN` dan
  `FLAME_DANGER` di sketch (langkah 11).
- Sensor ini juga peka sinar matahari dan lampu pijar. Uji dan pakai robot jauh dari jendela.
- Kalau Anda punya **3 sensor**, urutannya menjadi Kiri **A0**, Depan **A1**, Kanan **A2** (kabel Kanan pindah ke
  A2), lalu ubah `FLAME_COUNT` jadi `3`. Dashboard menyesuaikan sendiri.

---

## 5. Sensor gas MQ-2

1. **VCC → 5 V dari buck** (pemanas MQ-2 memakan ±150 mA, terlalu berat untuk pin 5V Uno), **GND → GND
   bersama**, **AO → A3**. DO dibiarkan kosong.
2. Nyalakan. Sensor akan terasa hangat, itu normal. 20 detik pertama setelah Uno menyala, firmware
   menganggap MQ-2 masih pemanasan dan belum memberi alarm. Untuk pemakaian pertama, biarkan menyala beberapa
   jam (kalau bisa semalam) supaya pembacaannya stabil.
3. **Uji:** setelah 20 detik ketik `GET`, lihat `"gs":[...]`. Catat angkanya di udara bersih. Lalu tekan korek
   gas **tanpa dinyalakan** di dekat sensor: angkanya harus naik.
4. Atur `GAS_WARN` sedikit di atas angka udara bersih (mis. udara bersih 180 → `GAS_WARN` sekitar 300) dan
   `GAS_DANGER` lebih tinggi lagi (mis. 500). Upload ulang.
5. MQ-2 kedua (kalau ada): AO → **A4**, lalu ubah `GAS_COUNT` jadi `2`.

Gas hanya memunculkan peringatan di dashboard. Robot tidak bergerak karena gas, yang menggerakkan robot di
mode otomatis hanya sensor api.

---

## 6. Servo nozzle

1. Servo: kabel **oranye/kuning (sinyal) → D11**, **merah → 5 V dari buck**, **coklat/hitam → GND bersama**.
2. Nyalakan. Firmware langsung menggerakkan servo ke **90°**.
3. Sekarang **pasang lengan servo** sehingga nozzle menghadap **lurus ke depan**.
4. Uji: `MODE M`, lalu `NOZ 40`, `NOZ 140`, dan `NOZ 90`. Nozzle harus menoleh ke satu sisi, ke sisi lain, lalu
   kembali lurus.
5. Perhatikan selangnya di posisi 40° dan 140°. Kalau tertarik, tertekuk, atau nozzle menabrak badan robot,
   persempit `NOZ_MIN` / `NOZ_MAX` lalu upload ulang. Saat menyemprot otomatis, nozzle diayun ±25° dari tengah
   (`NOZ_SWEEP`), jadi rentang 65°–115° harus bebas.

---

## 7. Pompa lewat modul relay

Kerjakan dua tahap: relay dulu tanpa pompa, baru pompanya.

**Tahap A, relay saja**

1. Modul relay: **VCC ← 5 V buck**, **GND ← GND bersama**, **IN ← D4**.
2. Banyak modul relay 1 kanal (terutama yang memakai optocoupler) **aktif-LOW**: relay menyala kalau IN diberi
   LOW. Untuk modul seperti itu, ubah `PUMP_ACTIVE_HIGH` jadi `0` di sketch, lalu upload. Kalau modul Anda punya
   jumper pilihan **H/L**, pasang di **L**. Belum yakin modulnya jenis apa? Langkah 3 akan menunjukkannya.
3. Nyalakan robot. **LED relay harus mati dan tidak ada bunyi klik.** Kalau relay langsung menyala, berarti
   pengaturan tadi terbalik: ganti `PUMP_ACTIVE_HIGH` ke nilai sebaliknya dan upload ulang.
4. Ketik `MODE M`, lalu `PUMP 1`. Relay harus berbunyi klik (menyala), lalu ±0,6 detik kemudian klik lagi
   (mati sendiri). Itu pengaman dead-man, sama seperti roda. Dari dashboard nanti, pompa menyala selama tombol
   ditahan.

**Tahap B, pompa**

```
Modul relay
  VCC ◄── 5 V buck
  GND ◄── GND bersama
  IN  ◄── Uno D4

  COM ◄── 5 V buck
  NO  ──► pompa (+)  merah
  NC      tidak dipakai
pompa (−) hitam ──► GND bersama

Dioda 1N4007 melintang di kabel pompa: sisi bergaris (katoda) ke (+), sisi lain ke (−)
```

1. Sambungkan seperti gambar. Pompa ada di **NO** (normally open), bukan NC, supaya pompa mati saat relay
   tidak aktif.
2. **Pompa harus terendam air sebelum dinyalakan.** Pompa yang berputar kering cepat rusak.
3. Uji pertama di luar robot atau di atas ember: ujung selang diarahkan ke ember, lalu ketik `PUMP 1` beberapa
   kali berturut-turut. Air harus menyembur.
4. Cek semua sambungan selang tidak bocor, terutama yang dekat dek elektronik.
5. Kalau pompa Anda versi 6–12 V, ambil daya **COM dari baterai (+)**, bukan dari 5 V buck.
6. Kalau ESP32 atau kamera ikut restart setiap pompa menyala, buck-nya kurang kuat. Pakai buck yang lebih
   besar, atau buck kedua khusus untuk pompa.

---

## 8. ESP32 (jembatan WiFi)

```
Uno TX (D1) ──[1 kΩ]──┬──► ESP32 GPIO16 (RX2)
                      [2 kΩ]
                       └── GND
Uno RX (D0) ◄──────────── ESP32 GPIO17 (TX2)
ESP32 VIN (5V) ◄───────── buck 5 V
ESP32 GND ─────────────── GND bersama
```

1. Buka `firmware/esp_bridge/esp_bridge.ino`. `ROBOT_NAME` sudah `"fireguard"`, jadi cukup ubah
   `WIFI_SSID` dan `WIFI_PASS` sesuai WiFi/hotspot yang akan dipakai.
2. Pasang library **WebSockets** (oleh Markus Sattler) lewat Library Manager, pilih board ESP32, lalu upload lewat USB ESP32.
3. Buka Serial Monitor ESP32 (baud 115200). Catat alamat IP yang muncul, mis. `Tersambung. IP: 192.168.1.24`.
   Kalau WiFi gagal, ESP32 membuat WiFi sendiri bernama `fireguard-robot` (password `kopak1234`) dengan alamat `192.168.4.1`.
4. Sambungkan kabel ke Uno sesuai gambar (pembagi tegangan 1k/2k **wajib** di jalur Uno TX → ESP32).
5. **Ingat:** setiap mau upload ulang sketch Uno, cabut dulu kabel di D0/D1.

---

## 9. ESP32-CAM

1. Buka `firmware/esp32cam_stream/esp32cam_stream.ino`. `CAM_HOSTNAME` sudah `"fireguard-cam"` dan baris kedua
   `NETWORKS` sudah berisi WiFi milik ESP32 (`fireguard-robot`). Cukup ubah **baris pertama** `NETWORKS`
   menjadi WiFi yang sama dengan ESP32.
2. Board: **AI Thinker ESP32-CAM**. Untuk upload: sambungkan **GPIO0 ke GND**, tekan reset, upload, lalu lepas
   GPIO0 dan tekan reset lagi. Catat IP di Serial Monitor (115200).
3. Daya: **5V dan GND dari buck**, dengan **kapasitor 470 µF** di pin 5V–GND-nya (kaki minus kapasitor ke GND).
   Tidak ada kabel ke Uno.

---

## 10. Sambungkan ke dashboard

1. Buka `fireguard/index.html` di laptop/HP yang tersambung ke WiFi yang sama.
2. Klik ikon roda gigi → mode **Langsung** → alamat robot `fireguard.local` atau IP ESP32 → alamat kamera
   `fireguard-cam.local` atau IP ESP32-CAM → **Simpan & Sambungkan**. Di HP Android pakai IP.
3. Status di pojok kanan atas harus **Terhubung**, kartu **Deteksi Api** menampilkan angka, gas menampilkan
   "Pemanasan" sebentar, dan kamera tampil.
   - "Robot belum merespons": ESP32 tersambung tapi Uno diam. Cek kabel TX/RX dan pembagi tegangan.

---

## 11. Kalibrasi jarak semprot

Bagian ini penting. FireGuard **tidak punya sensor rintangan**: di mode otomatis ia maju mendekati api dan
baru berhenti kalau angka sensor api turun sampai `FLAME_DANGER`. Jadi angka itulah yang menentukan seberapa
dekat robot ke api sebelum menyemprot.

1. **Ukur jangkauan pompa.** Mode Manual, tahan tombol **Tahan untuk Menyemprotkan Air** di dashboard (ujung
   selang ke ember). Lihat seberapa jauh air sampai, misalnya 40 cm. Jarak semprot yang aman kira-kira
   setengah sampai dua pertiganya, misalnya 25 cm.
2. Nyalakan lilin di atas piring logam, taruh di depan robot (di tengah, di antara dua sensor) sejauh jarak
   semprot tadi. Lihat angka sensor api (di kartu Deteksi Api, atau `GET` di Serial Monitor). Ambil angka yang
   paling kecil, misalnya 360. **`FLAME_DANGER` = angka itu + ±30**, jadi 390.
3. Mundurkan lilin ke jarak terjauh tempat robot sebaiknya mulai mencari api, misalnya 1 m. Catat angkanya,
   misalnya 640. **`FLAME_WARN` = angka itu + ±30**, jadi 670.
4. Cek dua hal: `FLAME_WARN` minimal ±50 di bawah angka saat tidak ada api sama sekali (supaya cahaya ruangan
   tidak dikira api), dan selisih `FLAME_WARN` dengan `FLAME_DANGER` minimal 100.
5. Upload ulang, lalu tiup lilinnya dulu sebelum lanjut.

---

## 12. Uji bertahap sebelum dilepas di lantai

Dengan roda **masih diangkat** dan ujung selang ke ember:

1. Mode **Manual**. Gerakkan joystick / WASD: arah roda sesuai. Geser slider **Arah nozzle**. Tahan tombol pompa.
2. Tekan **STOP** (atau Spasi): roda dan pompa berhenti.
3. Mode **Otomatis**, tanpa api: status **Siaga**, roda diam.
4. Nyalakan lilin agak ke kiri, ±1 m: roda kiri mundur dan roda kanan maju, artinya robot ingin berbelok ke
   kiri (**Mengarah ke api**). Karena roda diangkat, robotnya tidak benar-benar berbelok, jadi geser lilin ke
   tengah: sekarang kedua sisi maju (**Mendekati api**).
5. Dekatkan lilin sampai jarak semprot: roda berhenti, pompa menyala, nozzle mengayun (**Memadamkan api**).
6. Tiup lilinnya: ±2,5 detik kemudian pompa mati (**Jeda pompa**), lalu kembali **Siaga**.

Lalu di lantai:

> **Keselamatan:** selalu diawasi, hanya api kecil (lilin di atas piring logam), lantai tidak mudah terbakar
> (keramik/ubin), jauhkan dari kertas, kain, dan gorden, siapkan seember air atau APAR, dan jari siap di
> tombol STOP/Spasi. Jangan uji di dekat jendela yang terkena sinar matahari.

7. Taruh lilin ±1–1,5 m di depan robot. Mode **Otomatis**. Robot harus berbelok ke arah api, maju, berhenti di
   jarak semprot, lalu menyemprot sampai api padam.
8. Robot terlalu dekat ke lilin (hampir menabrak) → **naikkan** `FLAME_DANGER`. Berhenti terlalu jauh dan air
   tidak sampai → **turunkan** `FLAME_DANGER`.
9. Pompa dibatasi menyala 15 detik terus-menerus, lalu jeda 3 detik. Kalau api belum padam, robot menyemprot lagi.

---

## Kalau ada masalah

| Gejala | Yang dicek |
|---|---|
| `DRV`, `PUMP`, `NOZ` di Serial Monitor tidak berpengaruh | belum mengetik `MODE M` (robot menyala dalam mode Otomatis) |
| Robot bergerak sendiri padahal tidak ada api | cahaya lampu/matahari terbaca sebagai api: jauhi jendela, atau **turunkan** `FLAME_WARN` |
| Robot berputar terus tanpa pernah mendekat | kabel AO sensor Kiri dan Kanan tertukar, atau sensor terlalu serong ke luar |
| Robot menabrak lilin | `FLAME_DANGER` terlalu kecil, naikkan |
| Relay langsung menyala begitu robot dinyalakan | `PUMP_ACTIVE_HIGH` terbalik |
| Relay berbunyi klik tapi pompa diam | pompa tersambung ke NC, bukan NO; atau COM belum diberi 5 V |
| Pompa cuma menyala sebentar saat diuji dari Serial Monitor | normal, pengaman 0,6 detik. Ketik `PUMP 1` berulang, atau tahan tombol di dashboard |
| Uno/ESP32/kamera restart saat pompa menyala | dioda di pompa, buck kurang kuat, kabel daya terlalu kecil/panjang |
| Gas terus "Pemanasan" lebih dari 20 detik | Uno restart berulang (cek daya), karena hitungan pemanasan mulai lagi tiap Uno menyala |
| Nilai gas tinggi terus / naik-turun | MQ-2 baru, belum dipanaskan lama; atur ulang `GAS_WARN` / `GAS_DANGER` |
| Motor roda selalu kencang | jumper ENA/ENB di L298N belum dicabut |
| Kamera sering putus / "Brownout" | daya ESP32-CAM kurang: kapasitor, kabel lebih pendek, buck lebih kuat |

Setelah semuanya jalan, rapikan kabel dengan cable tie, jauhkan dari roda, dan pastikan tidak ada kabel atau
sambungan terbuka di bawah jalur selang air.
