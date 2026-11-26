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
- 3 sensor api IR (modul 4 pin: VCC, GND, DO, AO)
- 1 sensor gas MQ-2 (boleh 2)
- Arduino Uno
- ESP32 DevKit yang ditancapkan ke papan ekstensinya (ESP extension)
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
| Kabel jumper female–female dan female–male | pin sensor dan pin papan ekstensi sama-sama jantan, jadi butuh ujung female |
| Colokan DC jantan 5,5 mm dengan terminal sekrup | memberi daya papan ekstensi ESP32 dari baterai lewat jack DC-nya |
| (opsional) Breadboard kecil | tempat membagi 5V/GND dan memasang resistor. Tanpa breadboard, pakai pin V/G papan ekstensi ESP32 (langkah 2) |
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
     [Api Kiri]        [Api Depan]        [Api Kanan]
          \          nozzle + servo         /
           \           ESP32-CAM           /
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
4. **Pasang tiga sensor api** setinggi ±5–10 cm dari lantai (kira-kira setinggi api lilin):
   - **Depan** di tengah, menghadap lurus ke depan. Boleh sedikit di bawah atau di samping nozzle, asal tidak
     terhalang.
   - **Kiri** dan **Kanan** di sudut depan, serong ke luar ±30°.

   Dengan susunan ini, api yang lurus di depan paling kuat terbaca sensor Depan sehingga robot maju, sedangkan
   api di samping terbaca sensor Kiri atau Kanan sehingga robot berbelok ke arahnya. Pastikan ketiganya tidak
   tertutup selang atau nozzle.
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

1. Pasang 2 sel 18650 di holder 2S (+ BMS). Ukur dengan multimeter: harus **7,4–8,4 V**. Holder 4 sel juga
   boleh, asal susunannya 2S2P (hasil ukurnya tetap 7,4–8,4 V). Kalau terukur 14–16,8 V, holder itu 4 seri:
   jangan dipakai untuk rangkaian ini.
2. Pasang saklar di kabel + baterai.
3. Sambungkan baterai ke **input buck converter saja dulu**. Nyalakan, ukur output buck, lalu putar trimpot
   sampai **5,0–5,1 V**. Matikan lagi. Langkah ini wajib: buck baru biasanya keluar tegangan sembarang dan bisa
   merusak ESP32.
4. **5V dan GND untuk sensor: pakai pin V dan G di papan ekstensi ESP32.** Uno hanya punya satu pin 5V, jadi tidak
   cukup untuk banyak sensor. Di papan ekstensi, tiap GPIO punya tiga pin berjejer **G V S**. Semua pin **G**
   saling tersambung (GND), begitu juga semua pin **V**. Jadi pin V dan G dari baris mana saja boleh dipakai
   untuk daya sensor, **asal pin S di baris itu dibiarkan kosong** (pin S adalah GPIO ESP32).
   - Pindahkan jumper pilihan tegangan pin V ke **5V**, nyalakan papan, lalu ukur antara pin V dan G: harus
     ±4,7–5,2 V. Ini penting: kalau V hanya 3,3 V, angka sensor api ikut turun dan robot mengira selalu ada api.
   - Sambungkan GND Uno, GND L298N, dan GND buck masing-masing ke satu pin G papan ekstensi, supaya semua GND
     menyatu.
   - Jangan menyambung pin V papan ke pin 5V Uno: dua regulator yang disatukan bisa saling melawan.
   - Kalau punya breadboard kecil, itu juga boleh dipakai untuk membagi 5V dan GND.
5. **Daya papan ekstensi:** saat uji cukup lewat kabel USB ESP32. Di robot, lewat jack DC papan dari baterai 2S
   (cek tulisan di dekatnya; banyak yang menerima 6,5–16 V) memakai colokan DC jantan bersekrup, atau 5V dari
   buck ke pin 5V papan. Uno dan papan ekstensi sebaiknya menyala bersamaan dari saklar yang sama: kalau papan
   ekstensi mati, sensor api tidak dapat daya, angkanya jadi 0, dan itu terbaca seperti api besar.

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

5. Uno VIN ← baterai (+), Uno GND ← GND bersama. **GND Uno wajib tersambung ke GND L298N**, juga saat Uno
   hanya diberi daya dari USB laptop. Tanpa GND bersama, sinyal dari Uno tidak dikenali L298N dan roda diam.
6. **Uji motor dulu dengan sketch `firmware/tes_motor/tes_motor.ino`.** Sketch ini memutar roda sendiri
   dengan urutan tetap, tanpa perlu mengetik apa pun, jadi masalah kabel dan daya bisa dipisahkan dari masalah
   perintah. Angkat robot, upload, nyalakan saklar baterai, lalu perhatikan roda. Buka Serial Monitor
   (baud 57600) kalau ingin melihat langkah yang sedang berjalan.

   | Yang terlihat | Artinya |
   |---|---|
   | Urutannya pas: kiri maju, kiri mundur, kanan maju, kanan mundur, lalu dua sisi makin kencang | Kabel, motor, dan daya beres. Lanjut ke nomor 7 |
   | Satu sisi berputar ke arah yang terbalik | Tukar dua kabel motor di terminal OUT sisi itu |
   | Tertulis "KIRI", tapi yang berputar roda kanan | Kabel OUT1/OUT2 tertukar dengan OUT3/OUT4, atau IN1/IN2 tertukar dengan IN3/IN4 |
   | Hanya satu sisi yang berputar | Cek kabel sisi yang diam: kiri = IN1, IN2, ENA; kanan = IN3, IN4, ENB. Cek juga terminal OUT dan kabel motornya |
   | Tidak ada roda yang berputar, lampu L298N menyala | GND Uno belum tersambung ke GND L298N; jumper ENA/ENB sudah dicabut tapi ENA/ENB belum disambung ke D5/D6; kabel IN di pin yang salah; atau baterai terlalu lemah |
   | Tidak ada roda yang berputar, lampu L298N mati | Daya L298N belum masuk: cek langkah 2 (tegangan baterai, terminal 12V, jumper 5V-EN) |
   | Tulisan `=== TES MOTOR RODA ===` muncul lagi setiap roda mulai berputar | Uno restart karena tegangan turun saat motor menyala: baterai lemah atau cuma satu sel. Isi baterai, atau sementara beri daya Uno dari USB |
   | Saat `5/5` (kecepatan naik pelan) kecepatannya tidak berubah, langsung kencang | Jumper ENA/ENB masih terpasang. Untuk tes ini tidak apa, tapi cabut sebelum memakai firmware robot |
   | Saat `5/5` roda baru mulai berputar di PWM tinggi (mis. di atas 120) | Motor butuh tenaga lebih. Di firmware robot naikkan `MIN_PWM` ke angka itu + ±20 dan `DEFAULT_SPEED` ke ±200, karena di lantai bebannya lebih berat daripada saat roda diangkat |

7. **Upload sketch** `firmware/fireguard_uno/fireguard_uno.ino` lewat USB (D0/D1 jangan dulu disambung ke apa
   pun). Pastikan Arduino IDE menulis *Done uploading*; kalau upload gagal, sketch lama yang tetap berjalan.
8. **Uji lewat Serial Monitor**, dengan roda **diangkat** dari lantai:
   - Arduino IDE → Serial Monitor, baud **57600**. Pilihan akhir baris apa saja boleh, huruf kecil juga boleh.
     Kalau yang muncul huruf acak, baud-nya belum 57600.
   - Begitu terbuka, muncul beberapa baris yang diawali `#`, misalnya `# FireGuard 1.1.0 siap, mode OTOMATIS`.
     Baris `#` adalah pesan untuk Anda. Setelah itu baris JSON muncul 4× per detik, itu juga normal.
   - **Ketik `MODE M` dulu.** FireGuard selalu menyala dalam mode Otomatis (diam menunggu api), dan di mode
     itu perintah gerak dari luar diabaikan (Uno akan menulis `# Diabaikan: robot sedang mode OTOMATIS`).
     Selama sensor api belum dipasang, ini juga mencegah robot bergerak sendiri, karena pin sensor yang masih
     kosong bisa terbaca seperti ada api.
   - Ketik `DRV 0 60` lalu Enter. Uno membalas `# Roda diperintah berputar: kiri 124, kanan 124 ...` dan semua
     roda harus berputar **maju** sekitar setengah detik lalu berhenti sendiri. Robot memang berhenti sendiri
     kalau perintah tidak diulang (pengaman dead-man).
   - Pesan itu muncul tapi roda diam? Berarti perintahnya sudah sampai dan Uno sudah mengirim sinyal; masalahnya
     di kabel atau daya. Kembali ke nomor 6 (`tes_motor`). Kalau roda cuma berdengung, ketik `SPD 255` lalu `DRV 0 100`.
   - Ketik `DRV 60 0`. Robot harus berputar ke **kanan**: roda kiri maju, roda kanan mundur.
   - Roda berputar terbalik? Tukar dua kabel motor di OUT sisi itu, atau ubah `INVERT_LEFT` / `INVERT_RIGHT`
     jadi `1` lalu upload ulang.
   - Ketik `SPD 90` lalu `DRV 0 60` lagi. Roda harus lebih pelan. Kalau tetap kencang, jumper ENA/ENB belum dicabut.

---

## 4. Tiga sensor api

Setiap modul punya 4 pin. Yang dipakai **AO** (analog), DO dibiarkan kosong. AO masuk ke Uno, sedangkan VCC
dan GND diambil dari pin V dan G papan ekstensi ESP32 (langkah 2, nomor 4).

| Pin modul | Sensor Kiri | Sensor Depan | Sensor Kanan |
|---|---|---|---|
| AO | Uno A0 | Uno A1 | Uno A2 |
| VCC | pin V papan ekstensi | pin V | pin V |
| GND | pin G papan ekstensi | pin G | pin G |
| DO | — | — | — |

VCC dan GND memakai kabel female–female (pin sensor dan pin papan sama-sama jantan), AO memakai female–male.

**Uji:** papan ekstensi harus ikut menyala (misalnya lewat USB ESP32), karena sensor mendapat daya dari situ.
Ketik `GET`, lalu cari `"fl":[...]` di baris yang muncul. Urutan angkanya: Kiri, Depan, Kanan.

- Tanpa api, angkanya besar (biasanya ratusan sampai mendekati 1023, tergantung cahaya ruangan).
- Nyalakan korek ±30 cm di depan tiap sensor bergantian: angka sensor itulah yang paling turun. Kalau
  urutannya tertukar, tukar kabel AO-nya.
- `"fs":[...]` adalah statusnya: `0` aman, `1` waspada, `2` api.
- Pesan pembuka di Serial Monitor harus menulis `(3 sensor api, ...)`. Kalau tertulis 2, berarti firmware di
  Uno masih versi lama atau `FLAME_COUNT` di sketch masih `2`.

Catatan:

- Pada kebanyakan modul, potensio biru hanya mengatur kapan pin **DO** dan LED kecilnya menyala, tidak
  mengubah angka AO. Karena firmware membaca AO, kalibrasi dilakukan lewat angka `FLAME_WARN` dan
  `FLAME_DANGER` di sketch (langkah 11).
- Sensor ini juga peka sinar matahari dan lampu pijar. Uji dan pakai robot jauh dari jendela.
- Kalau hanya memakai **2 sensor**, ubah `FLAME_COUNT` jadi `2`, lalu pasang Kiri di **A0** dan Kanan di
  **A1**. Dashboard menyesuaikan sendiri.

---

## 5. Sensor gas MQ-2

1. **VCC → 5 V dari buck** (pemanas MQ-2 memakan ±150 mA). Kalau belum ada buck, boleh dari pin V papan
   ekstensi, asal papan diberi daya dari baterai lewat jack DC, bukan USB. **GND → pin G papan ekstensi**,
   **AO → A3** Uno. DO dibiarkan kosong.
2. Nyalakan. Sensor akan terasa hangat, itu normal. 20 detik pertama setelah Uno menyala, firmware
   menganggap MQ-2 masih pemanasan dan belum memberi alarm. Untuk pemakaian pertama, biarkan menyala beberapa
   jam (kalau bisa semalam) supaya pembacaannya stabil.
3. **Uji:** setelah 20 detik ketik `GET`, lihat `"gs":[...]`. Catat angkanya di udara bersih. Lalu tekan korek
   gas **tanpa dinyalakan** di dekat sensor: angkanya harus naik.
4. Atur `GAS_WARN` sedikit di atas angka udara bersih (mis. udara bersih 180 → `GAS_WARN` sekitar 300) dan
   `GAS_DANGER` lebih tinggi lagi (mis. 500). Upload ulang.
5. MQ-2 kedua (kalau ada): VCC dan GND sama seperti yang pertama, AO → **A4**, lalu ubah `GAS_COUNT` jadi `2`.
   Di dashboard, sensor di A3 tampil sebagai *MQ-2 #1* dan yang di A4 sebagai *MQ-2 #2*. Supaya gampang
   diingat, pasang MQ-2 kiri di A3 dan yang kanan di A4. Dua MQ-2 memakan ±300 mA, jadi ambil 5 V-nya dari
   buck, jangan dari pin V papan ekstensi yang juga menghidupi ESP32 dan sensor api.
6. **Letak:** di dek atas bagian depan atau samping, menghadap keluar dan tidak tertutup, supaya asap dari arah
   api cepat sampai. Jauhkan dari jalur semprotan dan tetesan nozzle: MQ-2 yang basah angkanya kacau dan bisa
   rusak. Ujung nozzle sebaiknya lebih menjorok ke depan daripada MQ-2, dan MQ-2 jangan menghalangi pandangan
   sensor api.

Gas hanya memunculkan peringatan di dashboard. Robot tidak bergerak karena gas, yang menggerakkan robot di
mode otomatis hanya sensor api.

---

## 6. Servo nozzle

1. Servo: kabel **oranye/kuning (sinyal) → D11 Uno**, **merah → 5 V dari buck**, **coklat/hitam → pin G papan
   ekstensi**. Belum ada buck? Merah boleh ke pin V papan ekstensi, asal papan diberi daya dari baterai lewat
   jack DC; kalau ESP32 restart setiap servo bergerak, pindahkan ke buck.
   **Jangan tancapkan konektor servo langsung ke satu baris G-V-S** papan ekstensi: kabel sinyalnya akan masuk
   ke GPIO ESP32, bukan ke Uno. Pisahkan ketiga kabelnya dengan kabel jumper.
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

ESP32 hanya butuh **3 kabel** ke Uno. Semua sensor, servo, dan L298N tetap ke Uno, bukan ke ESP32.

```
Uno D1 (TX) ──[1 kΩ]──┬──► pin S 16 papan ekstensi (GPIO16 / RX2)
                      [2 kΩ]
                       └──► pin G papan ekstensi
Uno D0 (RX) ◄──────────── pin S 17 papan ekstensi (GPIO17 / TX2)
Uno GND ───────────────── pin G papan ekstensi (sudah dari langkah 2)
```

- Di papan ekstensi, cari label **16** dan **17** (kadang ditulis RX2/TX2, IO16/IO17, atau G16/G17). Kabel
  sinyal masuk ke pin **S** di baris itu.
- **Kabel pembagi tanpa breadboard.** Buat sekali saja: potong satu kabel jumper male–female di tengah, lalu
  solder resistor 1 kΩ di antara kedua potongannya (ujung male ke D1 Uno, ujung female ke pin S 16). Di
  sambungan antara resistor 1 kΩ dan ujung female, solder satu kaki resistor 2 kΩ. Kaki lainnya disolder ke
  potongan kabel berujung female untuk pin G. Bungkus semua sambungan dengan isolasi atau heat-shrink.
  Hasilnya satu kabel bercabang tiga: D1, S16, dan G.
- Belum bisa menyolder? Untuk uji sebentar, kaki resistor boleh dililit kencang lalu dibungkus isolasi, tapi
  sambungan seperti itu mudah lepas kalau robot bergetar. Pilihan lain tanpa solder: modul *logic level
  converter* 5V–3,3V.
- Tidak punya 2 kΩ? Pakai dua 1 kΩ yang diseri. Jangan menyambung D1 langsung ke GPIO16: ESP32 bekerja di
  3,3 V, sinyal 5 V dari Uno bisa merusaknya pelan-pelan.
- Daya ESP32: saat uji cukup kabel USB ke laptop. Di robot, lewat jack DC papan ekstensi dari baterai 2S
  (langkah 2, nomor 5) atau 5V dari buck ke pin 5V papan.

1. Buka `firmware/esp_bridge/esp_bridge.ino`. `ROBOT_NAME` sudah `"fireguard"`, jadi cukup ubah
   `WIFI_SSID` dan `WIFI_PASS` sesuai WiFi/hotspot yang akan dipakai. Setelah diisi password, jangan commit
   file ini ke GitHub.
2. **Upload ke ESP32** (Arduino IDE 2):
   - Sekali saja: File → Preferences → *Additional boards manager URLs* diisi
     `https://espressif.github.io/arduino-esp32/package_esp32_index.json`. Lalu di Boards Manager pasang
     **esp32 by Espressif Systems**, dan di Library Manager pasang **WebSockets** oleh **Markus Sattler** (bukan
     library lain yang namanya mirip). Paket **Arduino ESP32 Boards** (oleh Arduino) hanya untuk Arduino Nano
     ESP32 dan tidak dipakai di sini.
   - Kompilasi pertama untuk ESP32 bisa makan 5–10 menit karena seluruh core ESP32 ikut dibangun; berikutnya jauh
     lebih cepat. Supaya terlihat prosesnya, centang File → Preferences → *Show verbose output during: compile*.
     Tunggu sampai muncul `Sketch uses ... bytes` dan **jangan klik Cancel** di tengah jalan: file yang baru
     setengah ditulis bisa tertinggal di cache, lalu kompilasi berikutnya gagal dengan ratusan
     `undefined reference`. Cara membereskannya ada di tabel *Kalau ada masalah* di bagian bawah.
   - Colok kabel USB ke **port micro-USB di papan ESP32 itu sendiri** (di antara tombol EN dan BOOT), bukan ke
     port USB papan ekstensi: port papan ekstensi biasanya hanya untuk daya. Pakai kabel data, bukan kabel yang
     cuma untuk mengecas.
   - Pilih board **ESP32 Dev Module** dan port COM yang muncul saat ESP32 dicolok. Port bernama *Standard Serial
     over Bluetooth link* milik Bluetooth laptop, bukan ESP32. Kalau tidak ada port baru, buka Device Manager:
     ESP32 yang drivernya belum terpasang muncul di *Other devices* bertanda kuning, misalnya
     `CP2102 USB to UART Bridge Controller`. Untuk CP2102, unduh
     [CP210x Universal Windows Driver](https://www.silabs.com/documents/public/software/CP210x_Universal_Windows_Driver.zip)
     dan ekstrak ZIP-nya, lalu klik kanan perangkat tadi → *Update driver* → *Browse my computer for drivers* →
     pilih folder hasil ekstrak. Untuk chip CH340, driver-nya *CH341SER* dari situs WCH.
   - Klik Upload. Kalau berhenti di `Connecting....`, atau gagal dengan *Wrong boot mode* atau *Invalid head of
     packet*, berarti ESP32 belum masuk mode upload. Banyak papan ESP32 murah gagal masuk mode ini sendiri, jadi
     bantu dengan tombol: upload lagi, begitu muncul `Connecting....` tekan dan tahan **BOOT**, tekan **EN** sekali
     sambil BOOT tetap ditahan, lalu lepas BOOT setelah muncul `Writing at ...`. Selesai upload, tekan EN sekali
     supaya program barunya jalan. Masih gagal? Lepas kabel di pin TX0/RX0 ESP32 kalau ada, lalu Tools → Upload
     Speed → 115200.
   - WiFi yang dipakai harus 2,4 GHz. ESP32 tidak bisa tersambung ke WiFi 5 GHz; hotspot HP biasanya bisa
     diatur ke 2,4 GHz.
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

1. Buka `fireguard/index.html` di laptop/HP yang tersambung ke WiFi yang sama. Untuk lomba atau demo, pakai
   hotspot HP sendiri: WiFi tempat acara belum tentu mengizinkan sesama perangkat saling terhubung, dan IP
   robot bisa dilihat langsung di daftar perangkat hotspot (namanya `fireguard`).
2. Klik ikon roda gigi → mode **Langsung** → alamat robot: IP ESP32 dari Serial Monitor (mis. `192.168.1.24`)
   → alamat kamera: IP ESP32-CAM, atau kosongkan kalau kamera belum dipasang → **Simpan & Sambungkan**.
   Alamat `fireguard.local` lebih praktis karena tidak berubah, tapi sering tidak jalan di HP Android, di
   sebagian laptop Windows, dan di WiFi kampus. Kalau statusnya terus "Menyambung...", kembali pakai IP.
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
2. Nyalakan lilin di atas piring logam, taruh di depan robot (lurus di depan sensor Depan) sejauh jarak
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
| Roda tidak bergerak sama sekali | jalankan `tes_motor` (langkah 3, nomor 6) dan cocokkan hasilnya dengan tabel di sana |
| Serial Monitor menampilkan huruf acak | baud belum 57600 |
| Muncul `# Diabaikan: robot sedang mode OTOMATIS` | ketik `MODE M` dulu (robot menyala dalam mode Otomatis) |
| Muncul `# Roda diperintah berputar...` tapi roda diam | perintah sudah sampai ke Uno; cek kabel L298N, GND bersama, dan baterai dengan `tes_motor` |
| Roda cuma berdengung, tidak berputar | PWM terlalu kecil untuk beban robot: `SPD 255`, lalu naikkan `MIN_PWM` di sketch |
| Robot bergerak sendiri padahal tidak ada api | cahaya lampu/matahari terbaca sebagai api: jauhi jendela, atau **turunkan** `FLAME_WARN` |
| Api lurus di depan, tapi robot malah berbelok ke kanan | `FLAME_COUNT` masih `2`, sehingga sensor Depan di A1 dibaca sebagai Kanan. Ubah jadi `3` lalu upload ulang |
| Ketiga angka sensor api 0, robot mengira ada api besar | papan ekstensi belum menyala (sensor mendapat daya dari pin V-nya), atau kabel VCC sensor lepas |
| Angka sensor api tidak pernah di atas ±700 walau tidak ada api | pin V papan ekstensi masih 3,3 V: pindahkan jumpernya ke 5V |
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
| Kompilasi ESP32 gagal: ratusan `undefined reference` (`String`, `millis`, `yield`), di akhir `final link failed` atau `unsupported binding` | cache kompilasi rusak, biasanya karena kompilasi sebelumnya dihentikan. Tutup Arduino IDE, buka `%LOCALAPPDATA%\arduino` lewat Win+R, hapus folder `sketches` dan `cores` (folder `Arduino15` jangan), lalu Verify lagi sampai selesai. Masih gagal dengan pesan yang sama: di Boards Manager pasang esp32 versi 3.x yang paling baru, hapus kedua folder tadi sekali lagi, lalu Verify |
| Pojok kanan bawah Arduino IDE menulis `on COMx [not connected]`, padahal lampu ESP32 menyala | laptop tidak melihat ESP32 di port itu. Buka Tools → Port sebelum dan sesudah ESP32 dicolok, lalu pilih port yang baru muncul. Tidak ada port baru: buka Device Manager lalu colok ESP32. Muncul di *Other devices* bertanda kuning = driver belum terpasang (CP2102 → driver CP210x dari Silicon Labs, CH340 → CH341SER dari WCH, CH9102 → CH343SER dari WCH). Daftar tidak berubah sama sekali = kabelnya cuma kabel cas atau port USB laptop bermasalah: ganti kabel dan port |
| Upload ESP32 gagal: `Could not open COMx, the port is busy or doesn't exist`, sering disertai `semaphore timeout` | cabut kabel ESP32 lalu buka Tools → Port. Kalau COMx masih ada, port itu bukan ESP32 (sering port Bluetooth laptop): pilih port yang muncul saat ESP32 dicolok. Kalau COMx ikut hilang: tutup program lain yang memakai port, colok ke port USB lain tanpa hub, Upload Speed 115200, ganti kabel, atau pasang ulang driver |
| Upload ESP32 gagal setelah `Connecting....`: `Failed to connect to ESP32`, `Invalid head of packet`, atau `Wrong boot mode` | ESP32 belum masuk mode upload. Upload lagi, begitu muncul `Connecting....` tahan BOOT, tekan EN sekali sambil BOOT tetap ditahan, lepas BOOT setelah muncul `Writing at ...`. Kabel dari Uno harus di pin 16 dan 17, bukan RX0/TX0; untuk upload pertama lebih aman dicabut dulu. Masih gagal, dan Serial Monitor (115200) penuh kotak-kotak yang tetap muncul walau EN ditahan: papan ESP32-nya kemungkinan rusak, coba papan lain |
| Dashboard terus "Menyambung..." dengan alamat `fireguard.local`, padahal dengan IP bisa | laptop/HP atau jaringannya tidak mendukung alamat `.local` (sering di Android, sebagian laptop Windows, dan WiFi kampus). Pakai IP dari Serial Monitor atau dari daftar perangkat di hotspot HP |

Setelah semuanya jalan, rapikan kabel dengan cable tie, jauhkan dari roda, dan pastikan tidak ada kabel atau
sambungan terbuka di bawah jalur selang air.
