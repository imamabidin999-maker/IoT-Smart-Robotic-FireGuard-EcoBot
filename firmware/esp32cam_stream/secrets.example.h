// secrets.example.h — CONTOH untuk ESP32-CAM. Jangan diisi di file ini.
// ------------------------------------------------------------------
// Salin menjadi secrets.h di folder yang sama (Arduino IDE: ... di kanan tab > New Tab > secrets.h),
// lalu isi. secrets.h masuk .gitignore, jadi tidak ikut ter-upload ke GitHub.
#pragma once

#define WIFI_SSID     "LAB-IOT-OTA"            // WiFi utama (boleh dihapus kalau kamera cukup ikut WiFi robot)
#define WIFI_PASS     "password-wifi"
#define AP_PASS       "ganti-password-ap"      // HARUS sama dengan AP_PASS di secrets.h ESP bridge
#define OTA_PASSWORD  "password-ota-kelompok"  // password upload lewat WiFi
// #define ROBOT_NAME    "ecobot"              // kamera di robot EcoBot: nama ecobot-cam, ikut WiFi ecobot-robot
