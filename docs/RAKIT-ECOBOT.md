# Merakit EcoBot (robot penyapu) langkah demi langkah

Panduan ini mengikuti pin dan pengaturan di `firmware/ecobot_uno/ecobot_uno.ino`. Detail teknis tiap bagian
ada di [WIRING.md](WIRING.md); di sini fokusnya urutan kerja.

Prinsipnya: **rakit sedikit, uji, lalu lanjut.** Jangan menyambung semuanya sekaligus lalu baru dinyalakan,
karena kalau ada yang salah akan sulit mencari penyebabnya.

Alat dan rangkaiannya sengaja disamakan dengan FireGuard: 4 baterai 18650 seri, buck LM2596 yang diatur
5,0 V, relay SONGLE 1 kanal, ESP32 di papan ekstensi, dan 3 resistor yang sama untuk kabel Uno → ESP32.
Masalah yang kemarin muncul saat merakit FireGuard (V dan G tertukar, pin sisi kanan papan ekstensi yang
urutannya terbalik, buck belum diatur, relay tanpa VCC, baterai habis) sudah dimasukkan ke langkah di bawah
supaya tidak terulang. Sketch `ecobot_uno.ino` dari GitHub juga sudah diisi sesuai rangkaian ini, jadi
tinggal di-upload.

---

## 0. Siapkan komponen dan alat

| Barang | Keterangan |
|---|---|
| Chassis + 4 motor DC TT + roda | sama seperti FireGuard (2WD juga boleh) |
| Modul L298N (HW-095) | driver motor roda |
| 4 baterai 18650 + holder 4 slot | disusun **seri**: 14,8 V, penuh 16,8 V |
| Buck LM2596 dengan layar angka | diatur **5,0 V** untuk semua modul 5 V |
| Arduino Uno | membaca sensor, menggerakkan roda, sapu, dan servo |
| ESP32 DevKit + papan ekstensinya | jembatan WiFi ke dashboard |
| ESP32-CAM (+ ESP32-CAM-MB, USB-TTL, atau Uno untuk upload) | kamera |
| 6 sensor ultrasonik HC-SR04 | Depan, Kiri-depan, Kanan-depan, Kiri, Kanan, Wadah |
| 1 mini servo SG90 / MG90S | mengangkat dan menurunkan sapu |
| Modul relay 1 kanal 5 V (SONGLE SRD-05VDC-SL-C) | saklar motor sapu |
| Motor DC kecil (TT kuning atau tipe 130) + sikat roller | sapu |
| 3 resistor yang gelang warnanya sama (mis. 1 kΩ) | menurunkan sinyal Uno 5 V → ESP32 3,3 V |
| Dioda 1N4007 (disarankan, murah) | pelindung relay dan Uno dari lonjakan tegangan motor sapu. Belum punya? Lihat langkah 4 |
| Kapasitor 470 µF 16 V (opsional) | penstabil daya ESP32-CAM |
| Wadah sampah (kotak plastik kecil) + lembaran plastik/akrilik untuk bidang miring | tempat sampah masuk |
| Kabel jumper female–female dan female–male | pin sensor dan pin papan ekstensi sama-sama jantan |
| Baut-spacer, lem tembak, isolasi/selotip, cable tie | perakitan |

Tidak ada saklar? Sama seperti FireGuard: **baterai ke-4 dipakai sebagai saklar.** Robot menyala saat baterai
itu dipasang dan mati saat dicabut, jadi letakkan holder di tempat yang mudah dijangkau.

**Alat:** obeng kecil, tang potong, **multimeter** (wajib untuk mengecek tegangan), cutter, lem tembak,
charger 18650.

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
      │ (roda)  Uno · L298N · ESP32 (roda)│  ← dek atas / belakang
      │      holder baterai · buck · relay│  ← dek bawah
      └─────────────────────────────────┘
```

1. **Pasang motor roda dan roda** ke chassis sesuai petunjuk kit. Kabel motor biarkan panjang dulu.
2. **Buat modul sapu**: tempel/kopel sikat roller ke poros motor sapu. Pasang motor dan roller di satu
   pelat kecil (akrilik/kayu/PCB bekas).
3. **Buat engsel**: pelat modul sapu dipasang dengan engsel di sisi belakangnya, supaya ujung depannya bisa
   naik-turun ±1–2 cm. Sambungkan lengan servo ke pelat itu (langsung, atau lewat kawat kaku sebagai tuas).
   **Jangan pasang lengan servo (horn) dulu**, nanti di langkah 5 setelah posisi servo diketahui.
4. **Pasang bidang miring dan wadah** di belakang sikat. Ujung bawah bidang miring dibuat hampir menyentuh
   lantai (sisakan 2–3 mm) supaya sampah yang disapu bisa naik ke wadah.
5. **Siapkan dudukan sensor**:
   - Depan: di tengah, **di atas sikat**, ±8–10 cm dari lantai, menghadap lurus ke depan. Lebih tinggi dari
     sampah supaya sampah kecil tidak dikira rintangan.
   - Kiri-depan dan Kanan-depan: di sudut depan, serong ±45° ke luar.
   - Kiri dan Kanan: di samping, menghadap 90° ke luar.
   - Wadah: di tutup/atas wadah, menghadap ke bawah ke dasar wadah.
6. **Holder baterai dan buck** di dek bawah, holder di tempat yang mudah dijangkau (baterai ke-4 = saklar),
   layar buck menghadap ke atas supaya angkanya terbaca. Uno, L298N, ESP32, dan relay di dek atas, jauh dari
   jalur sampah.

---

## 2. Jalur daya (4 baterai seri + buck)

```
4 × 18650 SERI (14,8 V) ──┬── L298N +12V            (motor roda)
                          └── buck IN+ ──► OUT 5,0 V ──┬── pin V papan ekstensi ──► Uno 5V, sensor, servo, relay VCC, ESP32-CAM
                                                       └── COM relay (daya motor sapu)
GND baterai ─── L298N GND ─── buck IN− ;  buck OUT− ─── pin G papan ekstensi ─── GND Uno, GND semua modul
```

1. Masukkan **3 baterai** saja dulu. Baterai ke-4 dipakai sebagai saklar. Setelah keempatnya terpasang,
   ukur di kabel holder: harus **14–16,8 V**. Kalau cuma ±7–8 V, holder Anda tersusun 2S2P, bukan 4 seri:
   ubah `BAT_CELLS` jadi `2` di `ecobot_uno.ino` dan `tes_motor.ino`.
2. Kabel merah holder dan satu kabel jumper dijepit bersama di terminal **+12V** L298N; ujung jumper ke **IN+**
   buck. Kabel hitam sama: terminal **GND** L298N, jumper ke **IN−** buck.
3. **Atur buck dulu, sebelum OUT disambung ke apa pun.** Pasang baterai ke-4. Tekan tombol di samping layar
   sampai lampu **OUT** yang menyala (lampu **IN** = tegangan baterai, tidak perlu diatur). Putar sekrup
   kuningan di atas kotak biru (trimpot) sampai layar menunjukkan **5.0**. Biasanya diputar ke kiri untuk
   menurunkan; kalau angkanya malah naik, putar ke kanan. Trimpot ini jenis banyak putaran, jadi bisa butuh
   belasan putaran. Cabut lagi baterai ke-4.
   Angka OUT tidak boleh di atas 5,5: Uno dan ESP32 bisa rusak. Angka OUT yang lebih tinggi dari IN berarti
   modulnya penaik tegangan (boost), bukan buck, dan tidak bisa dipakai.
4. **OUT+ → pin V papan ekstensi, OUT− → pin G.** Pindahkan jumper pilihan tegangan pin V ke **5V**. Di papan
   ekstensi tiap GPIO punya tiga pin berjejer **G V S**: semua G saling tersambung (GND), begitu juga semua V.
   Pin V dan G dari baris mana saja boleh dipakai untuk daya, **asal pin S di baris itu dibiarkan kosong**
   (pin S adalah GPIO ESP32).
   - Pakai baris di **sisi kiri** untuk daya. Di papan milik tim, urutan pin di sisi kanan terbalik dari sisi
     kiri (sudah terbukti di FireGuard). Kalau terpaksa memakai sisi kanan, ikuti tulisan G/V/S yang tercetak di
     papan, bukan urutan sisi kiri, dan ukur dulu dengan multimeter: antara V dan G harus ±5 V.
   - **Jangan sampai V dan G tertukar.** Kemarin di FireGuard, V/G yang terbalik membuat Uno, relay, dan
     sensor tidak menyala sama sekali.
5. **Pin V lain → 5V Uno, pin G lain → GND Uno.** Pin 5V ada di deretan POWER Uno (IOREF, RESET, 3.3V,
   **5V**, GND, GND, VIN). **VIN dibiarkan kosong**, begitu juga jack DC papan ekstensi (maksimal 16 V,
   sedangkan baterai penuh 16,8 V). Jangan pernah menyambung kabel holder 14,8 V ke pin V, 5V Uno, sensor,
   atau COM relay.
6. **Cek:** pasang baterai ke-4. LED Uno (ON), LED papan ESP32, dan LED L298N menyala. Lihat lagi angka OUT di
   buck setelah semua tersambung; kalau turun di bawah 5,0, putar sedikit ke kanan sampai 5,0–5,1.

**Kalau mau mencolok USB laptop ke Uno** (untuk upload atau Serial Monitor): cabut dulu kabel **5V Uno**, dan
juga **D0** dan **D1** kalau sudah dipasang di langkah 7. USB laptop tersambung langsung ke pin 5V Uno, jadi
kalau kabel 5V masih terpasang, laptop ikut menyuplai seluruh robot. Pasang lagi kabel-kabel itu setelah USB
dilepas. Selama upload, baterai ke-4 sebaiknya dicabut supaya roda dan sapu diam.

**Baterai:** isi ulang kalau angka IN di buck sudah di bawah ±13,2 V. Gejala baterai habis: buck berbunyi
"titit", angka OUT terus turun, WiFi robot hilang, dan motor melemah.

---

## 3. Arduino Uno + L298N + motor roda

1. **Cabut jumper kecil di pin ENA dan ENB** pada L298N. Jumper 5V-EN di dekat terminal +12V biarkan, dan
   terminal +5V L298N tidak dipakai.
2. Motor roda kiri → OUT1/OUT2, motor roda kanan → OUT3/OUT4. Untuk 4WD, dua motor di sisi yang sama diparalel;
   cek dulu keduanya berputar ke arah yang sama.
3. Kabel sinyal L298N ke Uno:

   | L298N | Uno |
   |---|---|
   | ENA | D5 |
   | IN1 | D7 |
   | IN2 | D8 |
   | IN3 | D9 |
   | IN4 | D10 |
   | ENB | D6 |

   **GND Uno wajib tersambung ke GND L298N** (lewat pin G papan ekstensi dari langkah 2, karena GND buck dan
   GND L298N menyatu di baterai). Tanpa GND bersama, sinyal dari Uno tidak dikenali L298N dan roda diam.
4. **Uji motor dulu dengan sketch `firmware/tes_motor/tes_motor.ino`.** Sketch ini memutar roda sendiri
   dengan urutan tetap, tanpa perlu mengetik apa pun. `BAT_CELLS` di sketch itu sudah `4`, sama dengan baterai
   tim. Angkat robot, cabut kabel 5V Uno, upload lewat USB, lepas USB, pasang lagi kabel 5V, lalu pasang
   baterai ke-4 dan perhatikan roda.

   | Yang terlihat | Artinya |
   |---|---|
   | Urutannya pas: kiri maju, kiri mundur, kanan maju, kanan mundur, lalu dua sisi makin kencang | Kabel, motor, dan daya beres. Lanjut ke nomor 5 |
   | Satu sisi berputar ke arah yang terbalik | Tukar dua kabel motor di terminal OUT sisi itu |
   | Tertulis "KIRI", tapi yang berputar roda kanan | Kabel OUT1/OUT2 tertukar dengan OUT3/OUT4, atau IN1/IN2 tertukar dengan IN3/IN4 |
   | Hanya satu sisi yang berputar | Cek kabel sisi yang diam: kiri = IN1, IN2, ENA; kanan = IN3, IN4, ENB. Cek juga terminal OUT dan kabel motornya |
   | Tidak ada roda yang berputar, lampu L298N menyala | GND Uno belum tersambung ke GND bersama; jumper ENA/ENB sudah dicabut tapi ENA/ENB belum disambung ke D5/D6; kabel IN di pin yang salah; atau baterai lemah |
   | Tidak ada roda yang berputar, lampu L298N mati | Daya L298N belum masuk: cek langkah 2 |
   | Tulisan `=== TES MOTOR RODA ===` muncul lagi setiap roda mulai berputar | Uno restart karena tegangan turun: baterai lemah, atau OUT buck di bawah 5 V |
   | Saat `5/5` (kecepatan naik pelan) kecepatannya tidak berubah, langsung kencang | Jumper ENA/ENB masih terpasang. Cabut sebelum memakai firmware robot |
   | Saat `5/5` roda baru mulai berputar di PWM tinggi (mis. di atas 120) | Motor butuh tenaga lebih. Di firmware robot naikkan `MIN_PWM` ke angka itu + ±20 dan `DEFAULT_SPEED` ke ±200 |

5. **Upload `firmware/ecobot_uno/ecobot_uno.ino`** dengan cara yang sama (kabel 5V, D0, D1 Uno dicabut dulu).
   Pastikan Arduino IDE menulis *Done uploading*; kalau upload gagal, sketch lama yang tetap berjalan. Nilai
   bawaan sketch sudah sesuai robot tim: `BAT_CELLS 4`, `BRUSH_USE_PWM 0`, `BRUSH_ACTIVE_HIGH 0`.
6. **Uji lewat Serial Monitor**, dengan roda **diangkat**. Uno boleh tetap tercolok USB (kabel 5V tetap
   dicabut) asal baterai ke-4 terpasang:
   - Serial Monitor, baud **57600**. Pilihan akhir baris apa saja boleh, huruf kecil juga boleh. Huruf acak =
     baud-nya belum 57600.
   - Muncul `# EcoBot 2.2.0 siap, mode MANUAL.` EcoBot selalu menyala dalam mode Manual, jadi roda dan sapu
     diam sampai diperintah. Baris JSON yang muncul 4× per detik itu normal.
   - Ketik `DRV 0 60`. Uno membalas `# Roda diperintah berputar: kiri 124, kanan 124 ...` dan roda berputar
     **maju** sekitar setengah detik lalu berhenti sendiri (pengaman dead-man). Angka 124 memakai skala 2 sel;
     yang sampai ke L298N otomatis dibagi dua karena baterainya 4 sel.
   - Ketik `DRV 60 0`. Robot harus berputar ke **kanan**: roda kiri maju, roda kanan mundur. Terbalik? Tukar
     dua kabel motor di OUT sisi itu, atau ubah `INVERT_LEFT` / `INVERT_RIGHT` jadi `1`.
   - Ketik `SPD 90` lalu `DRV 0 60`. Roda harus lebih pelan. Tetap kencang = jumper ENA/ENB belum dicabut.
   - Sensor ultrasonik belum dipasang? Akan muncul pesan seperti `# Sensor Depan: pin Echo HIGH terus. Kabel
     Echo lepas?`. Itu normal untuk sekarang, langkah 6 akan membereskannya. Perintah tetap ditulis persis tanpa
     titik: `GET`, bukan `GET.`.

---

## 4. Motor sapu lewat modul relay

Motor sapu tidak boleh disambung langsung ke pin Uno: pin Uno hanya kuat ±20 mA, sedangkan motor butuh
ratusan mA. Relay yang menjadi saklarnya, jadi sapu hanya bisa nyala/mati (slider kecepatan sapu di dashboard
otomatis disembunyikan). Kerjakan dua tahap: relay dulu tanpa motor, baru motornya.

**Tahap A, relay saja**

1. Modul relay: **VCC → pin V**, **GND → pin G** papan ekstensi, **IN → D3** Uno. **VCC wajib disambung**: pin
   IN hanya sinyal, daya koil relay datang dari VCC. Kemarin di FireGuard, relay tanpa VCC tidak mau klik.
2. **Cek jenis relay.** Modul SONGLE biru (pin IN/GND/VCC) dijual dalam versi aktif-LOW dan aktif-HIGH yang
   bentuknya hampir sama. Relay FireGuard ternyata aktif-LOW, dan sketch sudah `BRUSH_ACTIVE_HIGH 0`. Untuk
   memastikan relay EcoBot: lepas kabel IN dari D3, pasang baterai ke-4, lalu tempelkan ujung kabel IN ke pin
   G. Klik = aktif-LOW (biarkan `0`). Diam = aktif-HIGH: ubah jadi `1` lalu upload. Pasang lagi IN ke D3.
3. Nyalakan robot. **LED relay harus mati dan tidak ada bunyi klik.** Kalau relay langsung menyala, nilai
   `BRUSH_ACTIVE_HIGH` terbalik.
4. Serial Monitor: `BRUSH 50` → relay klik (menyala). `BRUSH 0` → klik lagi (mati). Angka berapa pun di atas 0
   artinya nyala. Beda dengan roda, sapu tidak mati sendiri setelah 0,6 detik; ia menyala terus sampai
   dimatikan, ditekan STOP, atau mode diganti.

**Tahap B, motor sapu**

```
Modul relay
  VCC ◄── pin V papan ekstensi
  GND ◄── pin G
  IN  ◄── Uno D3

  COM ◄── OUT+ buck (5,0 V)      terminal tengah
  NO  ──► motor sapu (+)         常开
  NC      tidak dipakai          常闭
motor sapu (−) ──► GND (OUT− buck atau pin G)

Dioda 1N4007 melintang di dua kabel motor: sisi bergaris (katoda) ke (+), sisi lain ke (−)
```

1. **COM diambil dari OUT+ buck**, satu kabel lagi dijepit bersama kabel OUT+ yang ke pin V. **Jangan dari
   kabel holder baterai**: 14,8 V akan membakar motor 3–6 V. Di modul 1 kanal, terminal sekrup **tengah adalah
   COM**. Kalau tulisannya huruf Cina: 常开 = NO, 公共端 = COM, 常闭 = NC.
2. Motor di **NO**, bukan NC, supaya sapu mati saat relay tidak aktif. Dioda dipasang di terminal tempat kabel
   motor masuk, bukan di badan motor, supaya kabel motor bisa ditukar tanpa ikut membalik dioda. Dioda kecil
   di modul relay hanya melindungi koil relay, jadi 1N4007 ini tetap perlu.
3. Uji: `BRUSH 50` → sikat berputar, `BRUSH 0` → berhenti.
4. **Cek arah putar:** bagian **bawah** sikat harus bergerak **ke belakang** (ke arah wadah), supaya sampah
   terlempar masuk. Kalau sampah malah terdorong ke depan, tukar dua kabel motor sapu (dioda jangan ikut
   dibalik).
5. **Belum punya dioda?** Sapu tetap bisa dipakai, sama seperti pompa FireGuard yang dirakit tanpa dioda:
   pilin dua kabel motor sapu berdua, jauhkan dari kabel sensor dan D0/D1, dan jangan letakkan relay menempel
   ke Uno. Kalau Uno atau ESP32 restart setiap sapu dinyalakan atau dimatikan, itu tanda dioda memang
   dibutuhkan.
6. Kalau ESP32 atau kamera ikut restart setiap sapu mulai berputar, buck kewalahan: pastikan dioda terpasang,
   kabel GND motor cukup besar, dan OUT buck tetap 5,0 saat sapu menyala.

**Hati-hati saat upload Uno:** relay aktif-LOW ikut menyala kalau Uno mati sementara relay masih dapat VCC.
Jadi selama upload (kabel 5V Uno dicabut), cabut baterai ke-4 supaya sapu tidak tiba-tiba berputar.

**Mau kecepatan sapu bisa diatur?** Ganti relay dengan transistor TIP120 atau modul MOSFET, ubah
`BRUSH_USE_PWM` jadi `1`, lalu sambungkan seperti [WIRING.md](WIRING.md) bagian 4. Dengan `BAT_CELLS 4`,
firmware membagi dua PWM sapu, sama seperti roda.

---

## 5. Servo pengangkat sapu

1. Servo: kabel **oranye/kuning (sinyal) → D11 Uno**, **merah → pin V**, **coklat/hitam → pin G** papan
   ekstensi. **Jangan tancapkan konektor servo langsung ke satu baris G-V-S**: kabel sinyalnya akan masuk ke
   GPIO ESP32, bukan ke Uno. Pisahkan ketiga kabelnya dengan kabel jumper.
2. Nyalakan. Firmware langsung menggerakkan servo ke **80° (sapu terangkat)**.
3. Sekarang **pasang lengan servo (horn)** dalam posisi sapu terangkat ±1–2 cm dari lantai.
4. Uji: `LIFT 0` → sapu turun, `LIFT 1` → sapu naik.
5. Kalau saat turun sikat terlalu menekan lantai (servo berdengung) atau malah tidak menyentuh lantai, ubah
   `LIFT_DOWN_ANGLE` (bawaan 20). Kalau saat naik kurang tinggi, ubah `LIFT_UP_ANGLE` (bawaan 80). Upload ulang.
   Kalau servo terpasang terbalik arah, angka "turun" boleh lebih besar dari "naik", kode tetap jalan.

---

## 6. Enam sensor ultrasonik

Setiap HC-SR04 punya 4 pin: VCC, Trig, Echo, GND. **VCC → pin V**, **GND → pin G** papan ekstensi (kabel
female–female). Trig dan Echo ke Uno (female–male):

| Sensor | Trig | Echo |
|---|---|---|
| Depan | D2 | A0 |
| Kiri-depan | D4 | A1 |
| Kanan-depan | D4 | A2 |
| Kiri | D12 | A3 |
| Kanan | D12 | A4 |
| Wadah | D2 | D13 |

Satu pin Trig memang dipakai dua sensor (dicabang dengan kabel Y, atau dua kaki kabel dipelintir lalu
diselotip). Ini sengaja karena pin Uno habis. Butuh 12 pin daya (6 V + 6 G): pakai baris di sisi kiri papan
ekstensi, atau ukur dulu sisi kanan seperti langkah 2.

**Uji:** ketik `GET`. Cari dua bagian di baris yang muncul:

- `"d":[...]`: enam angka jarak dalam cm dengan urutan seperti tabel. `-1` = tidak ada benda dalam jangkauan
  (±2,5 m), itu normal kalau di depan sensor kosong. Dekatkan tangan ke tiap sensor satu per satu: angka yang
  berubah harus berada di urutan yang benar. Kalau tertukar, tukar kabel Echo-nya.
- `"ue":[...]`: hasil pemeriksaan kabel tiap sensor oleh Uno. Semua harus `0`.
  - `1` = pin Echo HIGH terus: **kabel Echo lepas** atau salah pin.
  - `2` = sensor **tidak menjawab** sama sekali: VCC, GND, atau kabel Trig lepas (atau V/G tertukar).
  - Serial Monitor juga menulis pesannya, misalnya `# Sensor Kiri-depan tidak menjawab. Cek kabel VCC, GND,
    dan Trig.`, dan dashboard menandai kartu sensor itu **Kabel lepas** / **Tidak menjawab**.

Kenapa perlu diperiksa? Sensor yang kabelnya lepas terbaca "tidak ada benda", sama seperti ruangan kosong,
padahal robot jadi buta di arah itu. Karena itu di mode Otomatis robot **berhenti** kalau salah satu sensor
depan (Depan, Kiri-depan, Kanan-depan) bermasalah, dan baru jalan lagi setelah sensornya tersambung.

**Kalibrasi wadah:** saat wadah kosong, lihat angka ke-6 di `"d"`. Isi angka itu ke `BIN_EMPTY_CM` di sketch
(bawaan 20), lalu upload ulang. Kapasitas wadah di dashboard dihitung dari sini.

---

## 7. ESP32 (jembatan WiFi)

ESP32 hanya butuh **3 kabel** ke Uno, sama persis seperti FireGuard:

```
Uno D1 (TX) ──[R1]──┬──► pin S 16 papan ekstensi (GPIO16 / RX2)
                    [R2]
                    [R3]
                     └──► pin G papan ekstensi
Uno D0 (RX) ◄──────────── pin S 17 papan ekstensi (GPIO17 / TX2)
```

- R1, R2, R3 = **3 resistor yang gelang warnanya sama persis** (nilainya tidak harus 1 kΩ). R1 di atas, R2 + R3
  diseri di bawah, sehingga sinyal 5 V dari Uno turun jadi ±3,3 V. Jangan menyambung D1 langsung ke S16: ESP32
  bekerja di 3,3 V dan bisa rusak.
- Tanpa solder: pelintir kaki R2 dengan R3 lalu bungkus selotip; pelintir kaki R1 dengan kaki R2 yang satunya,
  masukkan ke ujung betina kabel jumper ke **S16**; kaki R1 yang bebas → jumper → **D1**; kaki R3 yang bebas →
  jumper → **G**. Semua kaki yang terbuka dibungkus selotip.
- **D0 Uno ← S17**, langsung tanpa resistor.
- Cari label **16** dan **17** di papan ekstensi (kadang ditulis RX2/TX2 atau IO16/IO17). Keduanya ada di sisi
  yang sama dengan pin 23, 22, dan 18, yaitu sisi yang urutan G-V-S-nya terbalik. Jadi ikuti tulisan G/V/S
  yang tercetak di papan, dan pastikan kabel sinyal masuk ke pin **S** di baris itu, bukan V atau G.

1. Buka `firmware/esp_bridge/esp_bridge.ino`. Buat tab baru `secrets.h` (tombol `...` di kanan deretan tab →
   *New Tab*) dan isi **hanya** dua baris ini. **Wajib untuk EcoBot**, karena bawaan sketch adalah FireGuard:

   ```cpp
   #pragma once
   #define ROBOT_NAME "ecobot"
   ```

   Pengaturan lain memakai nilai bawaan di `config.h`: robot membuat WiFi sendiri bernama `ecobot-robot`
   (password `kopak1234`, alamat robot `192.168.4.1`). Jangan menyalin seluruh isi `secrets.example.h` kalau
   belum perlu: di dalamnya ada contoh WiFi lab dan password WiFi robot yang berbeda (`ganti-password-ap`),
   sehingga robot mencoba WiFi lab dulu dan password WiFi robotnya ikut berubah. Baris-baris itu baru
   ditambahkan saat memakai WiFi rumah/hotspot atau praktikum OTA ([OTA.md](OTA.md)). `secrets.h` tidak ikut
   ke GitHub, jadi password aman.
2. Board **ESP32 Dev Module**, Partition Scheme **Default 4MB with spiffs** (jangan *Huge APP*, supaya update
   lewat WiFi bisa dipakai). Library yang dibutuhkan sama seperti FireGuard: **WebSockets** (Markus Sattler)
   dan **ArduinoJson** (Benoit Blanchon, versi 7). Langkah rincinya (paket board, driver CP210x, tombol BOOT/EN)
   ada di [RAKIT-FIREGUARD.md](RAKIT-FIREGUARD.md) langkah 8 nomor 2.
3. **Upload ke ESP32 tidak perlu mencabut kabel apa pun.** Pasang baterai ke-4 dulu supaya robot menyala, baru
   colok USB ke port micro-USB **di papan ESP32-nya** (bukan port papan ekstensi). Kalau baterai dicabut,
   laptop ikut menyuplai semua sensor lewat ESP32 dan upload bisa gagal.
4. Serial Monitor ESP32 (baud 115200) harus menulis `Mode AP: WiFi "ecobot-robot"`. Kalau yang tertulis
   `fireguard-robot`, baris `ROBOT_NAME` di `secrets.h` belum terbaca: cek tab `secrets.h` ada di folder yang
   sama dengan `esp_bridge.ino`.

---

## 8. ESP32-CAM

1. Buka `firmware/esp32cam_stream/esp32cam_stream.ino` dan buat tab `secrets.h` yang isinya sama seperti
   ESP32: `#pragma once` dan `#define ROBOT_NAME "ecobot"`. Satu baris itu sudah mengganti nama kamera jadi
   `ecobot-cam` dan membuat kamera ikut WiFi `ecobot-robot` dengan password `kopak1234`. Kalau nanti password
   WiFi robot diganti (`AP_PASS` di ESP32), tambahkan `AP_PASS` yang sama di `secrets.h` kamera.
2. Board **AI Thinker ESP32-CAM**, Partition Scheme **Minimal SPIFFS (1.9MB APP with OTA)** kalau kamera mau
   di-update lewat WiFi nanti. Untuk upload: sambungkan **GPIO0 ke GND**, tekan reset, upload, lalu lepas GPIO0
   dan tekan reset lagi. Tidak punya ESP32-CAM-MB atau USB-TTL? Pakai Uno seperti di
   [RAKIT-FIREGUARD.md](RAKIT-FIREGUARD.md) langkah 9.
3. Pasang di depan robot menghadap ke depan. Daya: **pin V dan G papan ekstensi** (atau langsung OUT buck), dengan
   **kapasitor 470 µF** di pin 5V–GND-nya kalau ada (kaki minus ke GND). Tidak ada kabel ke Uno.

---

## 9. Sambungkan ke dashboard

1. Sambungkan laptop/HP ke WiFi **`ecobot-robot`** (password `kopak1234`). Buka `ecobot/index.html` dari folder
   di laptop, klik ikon roda gigi → mode **Langsung** → alamat robot **`192.168.4.1`** → alamat kamera
   **`192.168.4.2`** (kalau kosong, coba `192.168.4.3`) → **Simpan & Sambungkan**. Selama tersambung ke WiFi
   robot, laptop tidak bisa internet.
2. Status di pojok kanan atas harus **Terhubung**, lima kartu sensor menampilkan jarak, dan kamera tampil.
   - "Robot belum merespons": ESP32 tersambung tapi Uno diam. Cek kabel D0/D1, resistor, dan pin S16/S17.
3. **Dua robot sekaligus:** FireGuard dan EcoBot masing-masing membuat WiFi sendiri dengan alamat yang sama
   (`192.168.4.1`), jadi satu laptop hanya bisa ke salah satunya dalam satu waktu. Mau memantau keduanya
   bersamaan? Pakai satu hotspot HP untuk semua: isi `WIFI_SSID` dan `WIFI_PASS` hotspot itu di `secrets.h`
   kedua ESP32 dan kedua ESP32-CAM, lalu lihat IP tiap robot di daftar perangkat hotspot (namanya `fireguard`,
   `ecobot`, `fireguard-cam`, `ecobot-cam`). Buka dua tab dashboard, masing-masing dengan IP robotnya.

---

## 10. Uji bertahap sebelum dilepas di lantai

Dengan roda **masih diangkat**:

1. Mode **Manual**. Gerakkan joystick / WASD: arah roda sesuai.
2. Tekan **Turunkan Sapu** → sapu turun. **Nyalakan Sapu** → berputar.
3. Tekan **STOP** (atau Spasi): roda dan sapu berhenti, sapu terangkat.
4. Dekatkan tangan ke sensor depan: kartu sensor berubah kuning (terdeteksi) lalu merah (dekat).
5. **Uji pengaman sensor:** pilih **Otomatis**, lalu cabut kabel Echo sensor Depan. Dalam ±1 detik robot
   berhenti, sapu terangkat, kartu Depan menulis **Kabel lepas**, dan muncul banner *SENSOR TIDAK TERSAMBUNG*.
   Pasang lagi kabelnya: robot lanjut menyapu sendiri.

Lalu di lantai:

6. Mode manual dulu. Sapu turun dan berputar, maju pelan di atas sedikit sampah kertas. Sampah harus masuk wadah.
7. Coba **Otomatis**: sapu turun, berputar, robot maju pelan. Taruh kotak di depannya: robot harus berhenti
   menyapu, mundur sebentar, berbelok, lalu lanjut.
8. Isi wadah sampai hampir penuh: dashboard memunculkan banner "Kapasitas wadah hampir penuh" dan robot berhenti.

---

## 11. Update lewat WiFi (OTA)

EcoBot memakai firmware ESP bridge yang sama dengan FireGuard, jadi semua langkah di [OTA.md](OTA.md) berlaku.
Bedanya hanya:

- `ROBOT_NAME "ecobot"` di `secrets.h` membuat firmware-nya bernama `ecobot-bridge`, dan manifest-nya
  `manifest-ecobot-bridge.json`. Update FireGuard tidak akan pernah terpasang di EcoBot, begitu juga sebaliknya.
- Update baru dipasang kalau robot di mode Manual, roda diam, dan **sapu mati**.
- Pemeriksaan setelah update (health check) memakai keenam sensor ultrasonik: cabut kabel Echo salah satu sensor
  selama masa percobaan, dan update dibatalkan (setara checkpoint C3.4 FireGuard).
- Parameter yang bisa diubah lewat OTA: jarak menghindar (`PARAM_JARAK_DEPAN`, `PARAM_JARAK_SERONG`) dan PWM
  mode otomatis (`PARAM_PWM_PUTAR`, `PARAM_PWM_MAJU`). Butuh Uno EcoBot 2.2.0.

---

## Kalau ada masalah

| Gejala | Yang dicek |
|---|---|
| Uno, relay, atau sensor tidak menyala sama sekali, padahal ESP32 menyala | kabel V dan G tertukar, kabel 5V Uno belum dipasang lagi setelah upload, atau memakai baris di sisi kanan papan ekstensi yang urutannya terbalik. Pindahkan ke sisi kiri |
| Angka OUT buck di atas 5,5 atau di bawah 4,8 | atur ulang trimpot (langkah 2 nomor 3). Lebih dari 6 V bisa merusak Uno |
| Buck berbunyi "titit", angka OUT turun terus, WiFi robot hilang | baterai habis. Cek angka IN: di bawah ±13,2 V harus diisi |
| Roda tidak bergerak sama sekali | jalankan `tes_motor` (langkah 3 nomor 4) dan cocokkan hasilnya dengan tabel di sana |
| Roda lemah dan pelan sekali | `BAT_CELLS` masih `4` padahal baterainya 2 seri (atau sebaliknya `2` padahal 4 seri: roda terlalu kencang). Samakan di `ecobot_uno.ino` dan `tes_motor.ino` |
| Serial Monitor menampilkan huruf acak | baud belum 57600 |
| Muncul `# Roda diperintah berputar...` tapi roda diam | perintah sudah sampai ke Uno; cek kabel L298N, GND bersama, dan baterai dengan `tes_motor` |
| Roda cuma berdengung, tidak berputar | PWM terlalu kecil untuk beban robot: `SPD 255`, lalu naikkan `MIN_PWM` di sketch |
| Muncul `# Perintah tidak dikenal: GET.` | ada titik ikut terketik. Ketik perintahnya persis, tanpa titik |
| Kartu sensor menulis **Kabel lepas** (`"ue"` berisi 1) | kabel Echo sensor itu lepas atau di pin yang salah |
| Kartu sensor menulis **Tidak menjawab** (`"ue"` berisi 2) | VCC, GND, atau kabel Trig sensor itu lepas, atau VCC/GND tertukar. Sensor yang berbagi Trig (lihat tabel langkah 6) ikut mati kalau kabel Y-nya lepas |
| Mode Otomatis langsung berhenti, status "Berhenti: sensor depan lepas" | salah satu sensor Depan, Kiri-depan, atau Kanan-depan bermasalah. Lihat kartu yang merah |
| Lampu "L" di Uno menyala terus | normal selama sensor Wadah belum dipasang: pin Echo-nya (D13) sama dengan lampu itu dan sengaja ditarik ke HIGH |
| Muncul `# Maju ditahan` padahal tidak ada benda | sensor depan/serong depan membaca pantulan dari badan robot atau sikat: geser posisinya, lihat angka `"d"` di `GET` |
| Relay langsung menyala begitu robot dinyalakan | `BRUSH_ACTIVE_HIGH` terbalik (ulangi tes langkah 4 nomor 2), atau Uno belum menyala (kabel 5V Uno) |
| Relay diam dan LED-nya mati saat `BRUSH 50` | VCC relay belum dapat 5 V, GND relay belum ke G, kabel IN tidak di D3, atau robot masih mode Otomatis (`BRUSH` diabaikan) |
| Relay berbunyi klik tapi sapu diam | motor tersambung ke NC, bukan NO; COM belum diberi 5 V dari OUT+ buck; atau GND motor lepas |
| Sapu berputar sendiri saat Uno sedang di-upload | relay aktif-LOW menyala karena Uno mati. Cabut baterai ke-4 selama upload |
| Uno, ESP32, atau kamera restart saat sapu/servo mulai bergerak | dioda motor sapu belum terpasang, OUT buck turun di bawah 5 V, atau baterai lemah |
| Sampah terdorong keluar, bukan masuk | arah putar sikat terbalik: tukar kabel motor sapu |
| Robot menghindari sampah kecil | sensor Depan terlalu rendah, naikkan posisinya |
| Kapasitas wadah tidak masuk akal | ukur ulang `BIN_EMPTY_CM` saat wadah kosong |
| Serial Monitor ESP32 menulis `fireguard-robot`, bukan `ecobot-robot` | `#define ROBOT_NAME "ecobot"` belum ada di `secrets.h`, atau tab `secrets.h` tidak di folder `esp_bridge` |
| Kamera sering putus / "Brownout" | daya ESP32-CAM kurang: kapasitor, kabel lebih pendek, OUT buck 5,0 |
| Masalah upload ESP32 (port tidak muncul, `Connecting....`, ratusan `undefined reference`) | lihat tabel *Kalau ada masalah* di [RAKIT-FIREGUARD.md](RAKIT-FIREGUARD.md), penyebab dan caranya sama |
| Update firmware ESP lewat WiFi gagal, ditahan, atau dibatalkan | lihat tabel *Kalau macet* di [OTA.md](OTA.md) |
| Dashboard terus "Menyambung..." dengan alamat `ecobot.local`, padahal dengan IP bisa | laptop/HP atau jaringannya tidak mendukung alamat `.local`. Pakai IP |

Setelah semuanya jalan, rapikan kabel dengan cable tie, dan jauhkan kabel dari roda serta sikat.
