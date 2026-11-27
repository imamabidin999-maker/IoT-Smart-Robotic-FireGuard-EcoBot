// config.h — semua pengaturan ESP bridge ada di sini.
// ------------------------------------------------------------------
// Password WiFi dan password OTA JANGAN ditulis di file ini, karena repo ini publik.
// Salin secrets.example.h menjadi secrets.h di folder yang sama lalu isi di sana.
// secrets.h sudah masuk .gitignore, jadi tidak ikut ter-upload ke GitHub.
// Nilai di secrets.h selalu menang atas nilai bawaan di bawah.
#pragma once

#if __has_include("secrets.h")
  #include "secrets.h"
#endif

// ==================================================================
//  Robot
// ==================================================================
#ifndef ROBOT_NAME
  #define ROBOT_NAME "fireguard"        // "fireguard" atau "ecobot"
#endif

// NAIKKAN setiap kali membuat firmware baru (MAJOR.MINOR.PATCH), lalu terbitkan dengan nomor yang
// sama. ESP menolak file yang isinya tidak cocok dengan nomor di manifest.
#define FW_VERSION "1.2.0"

// ==================================================================
//  WiFi
// ==================================================================
// Biarkan "NAMA_WIFI" supaya robot langsung membuat WiFi sendiri: nama "<ROBOT_NAME>-robot"
// (mis. fireguard-robot), password AP_PASS, alamat robot 192.168.4.1. Kalau WiFi yang diisi tidak
// ditemukan, robot juga membuat WiFi sendiri. Untuk Pull OTA, robot HARUS tersambung ke WiFi yang
// bisa menjangkau server update (WiFi lab, hotspot HP, atau WiFi rumah).
#ifndef WIFI_SSID
  #define WIFI_SSID "NAMA_WIFI"
#endif
#ifndef WIFI_PASS
  #define WIFI_PASS "PASSWORD_WIFI"
#endif
#ifndef AP_PASS
  #define AP_PASS "kopak1234"           // password WiFi mode AP (minimal 8 karakter). Sebaiknya diganti di secrets.h
#endif
#define WIFI_TIMEOUT_MS 15000UL

// Nama robot di jaringan: <NET_HOSTNAME>.local untuk dashboard, juga nama port jaringan di Arduino IDE.
// Kalau asisten praktikum meminta format iot-kelNN, isi NET_HOSTNAME "iot-kel04" di secrets.h,
// lalu di dashboard pakai alamat iot-kel04.local (atau tetap IP).
#ifndef NET_HOSTNAME
  #define NET_HOSTNAME ROBOT_NAME
#endif

#define WS_PORT      81
#define UART_BAUD    57600              // harus sama dengan SERIAL_BAUD di sketch Uno
#define UART_RX_PIN  16                 // hanya dipakai di ESP32 (RX2)
#define UART_TX_PIN  17                 // hanya dipakai di ESP32 (TX2)

// ==================================================================
//  MQTT (opsional). 0 = mati, 1 = hidup.
// ==================================================================
#ifndef USE_MQTT
  #define USE_MQTT   0
#endif
#define MQTT_HOST    "broker.hivemq.com"
#define MQTT_PORT    1883
#define MQTT_PREFIX  "kopak"            // HARUS sama dengan "Awalan topik" di pengaturan dashboard; buat yang unik
#ifndef MQTT_USER
  #define MQTT_USER  NULL
#endif
#ifndef MQTT_PASS
  #define MQTT_PASS  NULL
#endif

// ==================================================================
//  Update firmware lewat WiFi (OTA). Penjelasan lengkap: docs/OTA.md
// ==================================================================
// ID kelompok dari dosen, mis. "kel04". Dipakai sebagai folder di server update.
#ifndef GROUP_ID
  #define GROUP_ID "kel00"
#endif

// ---- Push OTA (upload dari Arduino IDE lewat port jaringan) ----
// Kosong = Push OTA mati. Upload lewat WiFi tanpa password sama saja membiarkan siapa pun di
// jaringan mengganti program robot, jadi tanpa password fitur ini sengaja tidak dinyalakan.
#ifndef OTA_PASSWORD
  #define OTA_PASSWORD ""
#endif

// ---- Pull OTA (ESP mengecek server update sendiri) ----
// Alamat server tanpa garis miring di akhir. Kosong = Pull OTA mati. Contoh:
//   "http://192.168.10.23:8000"                     (laptop: python -m http.server 8000)
//   "https://namaakun.github.io/fireguard-ota"     (GitHub Pages, butuh internet)
// ESP mengambil <SERVER_BASE>/<GROUP_ID>/manifest-<ROBOT_NAME>-bridge.json
#ifndef SERVER_BASE
  #define SERVER_BASE ""
#endif
#define CHECK_INTERVAL_MS    300000UL   // cek otomatis tiap 5 menit, hanya saat robot diam
// 0 = update yang ditemukan menunggu tombol "Pasang" di dashboard (atau ketik u di Serial Monitor).
// 1 = langsung dipasang begitu robot diam (seperti contoh di modul praktikum).
#define OTA_PASANG_OTOMATIS  0

// ---- Syarat sebelum update dipasang ----
// 1 = update hanya dipasang kalau Uno terbaca dan robot benar-benar diam (mode Manual, roda dan
//     pompa mati). 0 = boleh tanpa Uno, hanya untuk menguji ESP sendirian di meja.
#define OTA_BUTUH_UNO        1
#define OTA_MIN_BAT_MV       0          // tegangan baterai minimal (mV) kalau Uno punya sensor baterai, mis. 13600 untuk 4 sel. 0 = tidak dicek

// ---- Masa percobaan & rollback (Safe OTA) ----
#define MAX_TRIAL_BOOTS      3          // berapa kali firmware baru boleh crash/reboot sebelum dibatalkan
#define MIN_FREE_HEAP        40000      // sisa memori minimal (byte) supaya dianggap sehat
#define HEALTH_TIMEOUT_MS    30000UL    // firmware baru harus lolos health check dalam waktu ini
#define HEALTH_STABIL_MS     3000UL     // semua pemeriksaan harus lolos terus-menerus selama ini
// 0 = rollback diatur program (seperti modul praktikum: crash dihitung sampai MAX_TRIAL_BOOTS).
// 1 = rollback juga dijaga bootloader ESP-IDF: kalau firmware baru crash sebelum dinyatakan sehat,
//     boot berikutnya langsung kembali ke versi lama, tanpa server dan tanpa menghitung.
#define ROLLBACK_BOOTLOADER  0
// Program dianggap macet kalau loop() tidak berputar selama ini, lalu ESP di-restart.
#define LOOP_WDT_MS          15000UL

// ---- Injeksi kesalahan untuk pengujian (KEMBALIKAN ke 0 setelah uji) ----
//  0 = normal
//  1 = health check selalu gagal
//  2 = crash saat masa percobaan (menulis ke alamat null)
//  3 = macet saat masa percobaan (loop berhenti, ditangkap watchdog)
#define FAULT_MODE 0

// ---- Uji Root CA (Pertemuan 2, C2.4) ----
// 1 = ESP memakai sertifikat palsu, jadi pengambilan manifest lewat https HARUS gagal.
#define UJI_ROOT_CA_SALAH    0

// ==================================================================
//  Parameter robot yang dikirim ESP ke Uno (FireGuard)
// ==================================================================
// Ambang sensor dan PWM mode otomatis ada di Uno. Kalau diisi di sini, ESP mengirim perintah CFG
// ke Uno setiap kali tersambung, jadi parameter robot bisa diubah cukup dengan update firmware ESP
// lewat OTA (demo "ubah satu parameter proyek lewat OTA"). 0 = pakai nilai bawaan Uno.
// Aturan: api waspada > api bahaya (nilai kecil = api), gas waspada < gas bahaya, nilai 1..1023.
#define PARAM_API_WASPADA    0          // mis. 650
#define PARAM_API_BAHAYA     0          // mis. 350
#define PARAM_GAS_WASPADA    0
#define PARAM_GAS_BAHAYA     0
#define PARAM_PWM_PUTAR      0          // 1..255
#define PARAM_PWM_MAJU       0          // 1..255
