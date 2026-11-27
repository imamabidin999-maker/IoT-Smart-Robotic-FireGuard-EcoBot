// secrets.example.h — CONTOH. Jangan diisi di file ini.
// ------------------------------------------------------------------
// 1. Salin file ini menjadi secrets.h di folder yang sama
//    (di Arduino IDE: tombol ... di kanan tab > New Tab > ketik secrets.h, lalu tempel isinya).
// 2. Isi nilai yang benar di secrets.h.
// secrets.h masuk .gitignore, jadi password tidak ikut ter-upload ke GitHub.
// Baris yang tidak dibutuhkan boleh dihapus; nilai bawaannya ada di config.h.
#pragma once

#define WIFI_SSID     "LAB-IOT-OTA"            // WiFi lab / hotspot HP / WiFi rumah
#define WIFI_PASS     "password-wifi"
#define AP_PASS       "ganti-password-ap"      // WiFi yang dibuat robot sendiri kalau WIFI_SSID tidak ada (min. 8 karakter)

#define GROUP_ID      "kel04"                  // ID kelompok dari dosen
#define OTA_PASSWORD  "password-ota-kelompok"  // password upload lewat WiFi (Arduino IDE akan menanyakannya)
#define SERVER_BASE   "http://192.168.10.23:8000"   // server update. Kosongkan ("") kalau belum dipakai

// #define NET_HOSTNAME "iot-kel04"            // kalau asisten meminta nama host format iot-kelNN
// #define ROBOT_NAME   "ecobot"               // untuk ESP di robot EcoBot
