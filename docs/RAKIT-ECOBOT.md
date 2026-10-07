# Merakit EcoBot (robot penyapu) langkah demi langkah

Panduan ini mengikuti pin dan pengaturan di `firmware/ecobot_uno/ecobot_uno.ino`. Detail teknis tiap bagian
ada di [WIRING.md](WIRING.md); di sini fokusnya urutan kerja.

Prinsipnya: **rakit sedikit, uji, lalu lanjut.** Jangan menyambung semuanya sekaligus lalu baru dinyalakan,
karena kalau ada yang salah akan sulit mencari penyebabnya.

---

## 0. Siapkan komponen dan alat

**Dari daftar Anda**

- Chassis + motor DC TT + roda (2WD seperti gambar, atau 4WD)
- 1 modul L298N
- 2 baterai 18650
- Arduino Uno
- ESP32 (ESP extension)
- ESP32-CAM
- 6 sensor ultrasonik HC-SR04
- 1 mini servo (SG90 / MG90S)

**Yang perlu ditambah**

| Barang | Untuk apa |
|---|---|
| Holder baterai 2S (2 sel seri) + BMS 2S | baterai jadi 7,4 V, dan aman dari kelebihan/kekurangan isi |
| Saklar on/off | memutus baterai |
| Buck converter 5 V ≥ 2 A (LM2596 atau MP1584) | daya 5 V untuk ESP32, ESP32-CAM, dan servo |
| Motor DC kecil untuk sapu (TT kuning atau tipe 130) | memutar sikat |
| Sikat roller | bisa dari sikat botol, sikat gigi, atau potongan sedotan/plastik yang ditempel melingkar seperti di gambar |
| Modul MOSFET (D4184 / AOD4184, atau IRF520) | saklar motor sapu |
| Dioda 1N4007 atau 1N5819 | pelindung MOSFET dari lonjakan tegangan motor |
| Resistor 1 kΩ dan 2 kΩ | menurunkan tegangan sinyal Uno → ESP32 |
| Kapasitor elektrolit 470 µF 16 V | penstabil daya ESP32-CAM |
| Wadah sampah (kotak plastik kecil) + lembaran plastik/akrilik untuk bidang miring | tempat sampah masuk |
| Kabel jumper, PCB lubang/terminal, baut-spacer, lem tembak, isolasi | perakitan |
| Adaptor USB-TTL atau papan ESP32-CAM-MB | upload ke ESP32-CAM |
| (opsional) 2 resistor 10 kΩ | mengukur baterai |

**Alat:** obeng, tang potong, solder, **multimeter** (wajib untuk mengecek tegangan), cutter, lem tembak.

---

## 1. Rakit bagian mekanik

Lihat robot dari atas:

```
                     DEPAN
     [Kiri-depan]   [Depan]   [Kanan-depan]
           \           |           /
      ┌─────────────────────────────────┐
      │  ═══════ sikat sapu ═══════      │  ← motor sapu di ujung poros, bisa diangkat servo
      │      \___ bidang miring ___/     │
[Kiri]│    ┌─────────────────────┐       │[Kanan]
      │    │       WADAH         │       │
      │    │  (sensor Wadah di   │       │
      │    │   tutup, ke bawah)  │       │
      │    └─────────────────────┘       │
      │ (roda)   elektronik    (roda)    │
      └─────────────────────────────────┘
```

1. **Pasang motor roda dan roda** ke chassis sesuai petunjuk kit. Kabel motor biarkan panjang dulu.
2. **Buat modul sapu**: tempel/kopel sikat roller ke poros motor sapu. Pasang motor dan roller di satu
   pelat kecil (akrilik/kayu/PCB bekas).
3. **Buat engsel**: pelat modul sapu dipasang dengan engsel di sisi belakangnya, supaya ujung depannya bisa
   naik-turun ±1–2 cm. Sambungkan lengan servo ke pelat itu (langsung, atau lewat kawat kaku sebagai tuas).
   **Jangan pasang lengan servo (horn) dulu**, nanti di langkah 6 setelah posisi servo diketahui.
4. **Pasang bidang miring dan wadah** di belakang sikat. Ujung bawah bidang miring dibuat hampir menyentuh
   lantai (sisakan 2–3 mm) supaya sampah yang disapu bisa naik ke wadah.
5. **Siapkan dudukan sensor**:
   - Depan: di tengah, **di atas sikat**, ±8–10 cm dari lantai, menghadap lurus ke depan. Lebih tinggi dari
     sampah supaya sampah kecil tidak dikira rintangan.
   - Kiri-depan dan Kanan-depan: di sudut depan, serong ±45° ke luar.
   - Kiri dan Kanan: di samping, menghadap 90° ke luar.
   - Wadah: di tutup/atas wadah, menghadap ke bawah ke dasar wadah.
6. Sisakan tempat untuk Uno, L298N, ESP32, buck, dan modul MOSFET di bagian belakang/atas, jauh dari jalur sampah.

---

## 2. Jalur daya (sebelum ada modul lain yang tersambung)

```
Baterai 2S (+) ── saklar ──┬── L298N +12V
                           ├── Uno VIN
                           ├── modul MOSFET VIN+
                           └── buck IN+
Baterai 2S (−) ────────────┴── GND semua modul (L298N, Uno, MOSFET VIN−, buck IN−, ESP32, ESP32-CAM)
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
2. Motor roda kiri → OUT1/OUT2. Motor roda kanan → OUT3/OUT4. (4WD: dua motor sisi yang sama diparalel.)
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
6. **Upload sketch** `firmware/ecobot_uno/ecobot_uno.ino` lewat USB (D0/D1 jangan dulu disambung ke apa pun).
7. **Uji lewat Serial Monitor**, dengan roda **diangkat** dari lantai:
   - Arduino IDE → Serial Monitor, baud **57600**, akhir baris **Newline**.
   - Akan terlihat baris JSON 4× per detik. Itu normal.
   - Ketik `DRV 0 60` lalu Enter. Kedua roda harus berputar **maju** sekitar setengah detik lalu berhenti
     sendiri. Robot memang berhenti sendiri kalau perintah tidak diulang (pengaman dead-man).
   - Ketik `DRV 60 0`. Robot harus berputar ke **kanan**: roda kiri maju, roda kanan mundur.
   - Roda berputar terbalik? Tukar dua kabel motor di OUT sisi itu, atau ubah `INVERT_LEFT` / `INVERT_RIGHT`
     jadi `1` lalu upload ulang.
   - Ketik `SPD 90` lalu `DRV 0 60` lagi. Roda harus lebih pelan. Kalau tetap kencang, jumper ENA/ENB belum dicabut.

---

## 4. Motor sapu (modul MOSFET)

```
Uno D3  ────────► SIG/PWM ┐
Uno GND ────────► GND     │
Baterai + ──────► VIN+    │ modul MOSFET
GND bersama ────► VIN−    │
Motor sapu ◄──── OUT+ ────┤  ← dioda: katoda (garis) ke OUT+, anoda ke OUT−
Motor sapu ◄──── OUT− ────┘
```

1. Sambungkan sisi sinyal, sisi daya, dan sisi motor seperti gambar.
2. Solder/pasang **dioda melintang di terminal OUT modul**: sisi bergaris (katoda) ke OUT+. Dengan dioda di
   terminal modul, kabel motor boleh dibalik nanti tanpa membalik dioda.
3. Uji di Serial Monitor: `BRUSH 50`. Sikat harus mulai berputar pelan lalu stabil. `BRUSH 0` → berhenti.
4. **Cek arah putar:** bagian **bawah** sikat harus bergerak **ke belakang** (ke arah wadah), supaya sampah
   terlempar masuk. Kalau sampah malah terdorong ke depan, tukar dua kabel motor sapu di OUT+/OUT−.
5. Motor sapu 3–6 V: dari mode manual, jangan naikkan kecepatan sapu di atas ±75% (mode otomatis sudah dibatasi 70%).

---

## 5. Servo pengangkat sapu

1. Servo: kabel **oranye/kuning (sinyal) → D11**, **merah → 5 V dari buck**, **coklat/hitam → GND bersama**.
2. Nyalakan. Saat menyala, firmware menggerakkan servo ke sudut **80° (sapu terangkat)**.
3. Sekarang **pasang lengan servo (horn)** dalam posisi sapu terangkat ±1–2 cm dari lantai.
4. Uji: `LIFT 0` → sapu turun, `LIFT 1` → sapu naik.
5. Kalau saat turun sikat terlalu menekan lantai (servo berdengung) atau malah tidak menyentuh lantai, ubah
   `LIFT_DOWN_ANGLE` (bawaan 20). Kalau saat naik kurang tinggi, ubah `LIFT_UP_ANGLE` (bawaan 80). Upload ulang.
   Kalau servo Anda terpasang terbalik arah, angka "turun" boleh lebih besar dari "naik", kode tetap jalan.

---

## 6. Enam sensor ultrasonik

Setiap HC-SR04 punya 4 pin: VCC, Trig, Echo, GND. **VCC → 5 V** (pin 5V Uno cukup karena arusnya kecil),
**GND → GND bersama**. Trig dan Echo:

| Sensor | Trig | Echo |
|---|---|---|
| Depan | D2 | A0 |
| Kiri-depan | D4 | A1 |
| Kanan-depan | D4 | A2 |
| Kiri | D12 | A3 |
| Kanan | D12 | A4 |
| Wadah | D2 | D13 |

Satu pin Trig memang dipakai dua sensor (dicabang dengan kabel Y atau di PCB). Ini sengaja karena pin Uno habis.

**Uji:** di Serial Monitor ketik `GET`. Cari bagian `"d":[...]` di baris yang muncul: enam angka jarak dalam cm
dengan urutan seperti tabel di atas (`-1` = tidak ada benda dalam jangkauan). Dekatkan tangan ke tiap sensor satu
per satu dan pastikan angka yang berubah berada di urutan yang benar. Kalau tertukar, tukar kabel Echo-nya.

**Kalibrasi wadah:** saat wadah kosong, lihat angka ke-6 di `"d"`. Isi angka itu ke `BIN_EMPTY_CM` di sketch
(bawaan 20), lalu upload ulang. Kapasitas wadah di dashboard dihitung dari sini.

---

## 7. ESP32 (jembatan WiFi)

```
Uno TX (D1) ──[1 kΩ]──┬──► ESP32 GPIO16 (RX2)
                      [2 kΩ]
                       └── GND
Uno RX (D0) ◄──────────── ESP32 GPIO17 (TX2)
ESP32 VIN (5V) ◄───────── buck 5 V
ESP32 GND ─────────────── GND bersama
```

1. Buka `firmware/esp_bridge/esp_bridge.ino`. Ubah:
   - `ROBOT_NAME` → `"ecobot"`
   - `WIFI_SSID` dan `WIFI_PASS` → WiFi/hotspot yang akan dipakai
2. Pasang library **WebSockets** (oleh Markus Sattler) lewat Library Manager, pilih board ESP32, lalu upload lewat USB ESP32.
3. Buka Serial Monitor ESP32 (baud 115200). Catat alamat IP yang muncul, mis. `Tersambung. IP: 192.168.1.23`.
   Kalau WiFi gagal, ESP32 membuat WiFi sendiri bernama `ecobot-robot` (password `kopak1234`) dengan alamat `192.168.4.1`.
4. Sambungkan kabel ke Uno sesuai gambar (pembagi tegangan 1k/2k **wajib** di jalur Uno TX → ESP32).
5. **Ingat:** setiap mau upload ulang sketch Uno, cabut dulu kabel di D0/D1.

---

## 8. ESP32-CAM

1. Buka `firmware/esp32cam_stream/esp32cam_stream.ino`. Ubah:
   - `CAM_HOSTNAME` → `"ecobot-cam"`
   - baris pertama `NETWORKS` → WiFi yang sama dengan ESP32
   - baris kedua `NETWORKS` → `{ "ecobot-robot", "kopak1234" }`
2. Board: **AI Thinker ESP32-CAM**. Untuk upload: sambungkan **GPIO0 ke GND**, tekan reset, upload, lalu lepas
   GPIO0 dan tekan reset lagi. Catat IP di Serial Monitor (115200).
3. Pasang di depan robot menghadap ke depan. Daya: **5V dan GND dari buck**, dengan **kapasitor 470 µF** di pin
   5V–GND-nya (kaki minus kapasitor ke GND). Tidak ada kabel ke Uno.

---

## 9. Sambungkan ke dashboard

1. Buka `ecobot/index.html` di laptop/HP yang tersambung ke WiFi yang sama.
2. Klik ikon roda gigi → mode **Langsung** → alamat robot `ecobot.local` atau IP ESP32 → alamat kamera
   `ecobot-cam.local` atau IP ESP32-CAM → **Simpan & Sambungkan**. Di HP Android pakai IP.
3. Status di pojok kanan atas harus **Terhubung**, angka sensor bergerak, dan kamera tampil.
   - "Robot belum merespons": ESP32 tersambung tapi Uno diam. Cek kabel TX/RX dan pembagi tegangan.

---

## 10. Uji bertahap sebelum dilepas di lantai

Dengan roda **masih diangkat**:

1. Mode **Manual**. Gerakkan joystick / WASD: arah roda sesuai.
2. Tekan **Turunkan Sapu** → sapu turun. **Nyalakan Sapu** → berputar. Geser slider kecepatan sapu.
3. Tekan **STOP** (atau Spasi): roda dan sapu berhenti, sapu terangkat.
4. Dekatkan tangan ke sensor depan: kartu sensor berubah kuning (terdeteksi) lalu merah (dekat).

Lalu di lantai:

5. Mode manual dulu. Sapu turun dan berputar, maju pelan di atas sedikit sampah kertas. Sampah harus masuk wadah.
6. Coba **Otomatis**: sapu turun, berputar, robot maju pelan. Taruh kotak di depannya: robot harus berhenti
   menyapu, mundur sebentar, berbelok, lalu lanjut.
7. Isi wadah sampai hampir penuh: dashboard memunculkan banner "Kapasitas wadah hampir penuh" dan robot berhenti.

---

## Kalau ada masalah

| Gejala | Yang dicek |
|---|---|
| Uno restart saat sapu/servo mulai bergerak | servo dan ESP harus dari buck, bukan pin 5V Uno; dioda motor sapu terpasang; naikkan `BRUSH_RAMP_MS` |
| Motor roda selalu kencang | jumper ENA/ENB di L298N belum dicabut |
| Motor sapu tidak berputar | sisi daya modul MOSFET (VIN dari baterai), GND bersama, kabel D3 |
| Sampah terdorong keluar, bukan masuk | arah putar sikat terbalik: tukar kabel motor sapu |
| Robot menghindari sampah kecil | sensor Depan terlalu rendah, naikkan posisinya |
| Kapasitas wadah tidak masuk akal | ukur ulang `BIN_EMPTY_CM` saat wadah kosong |
| Kamera sering putus / "Brownout" | daya ESP32-CAM kurang: kapasitor, kabel lebih pendek, buck ≥ 2 A |

Setelah semuanya jalan, rapikan kabel dengan cable tie, dan jauhkan kabel dari roda serta sikat.
