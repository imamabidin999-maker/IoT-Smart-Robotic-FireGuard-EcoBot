// ota_esp8266.h — versi sederhana untuk ESP8266: hanya Push OTA (upload dari Arduino IDE).
// ------------------------------------------------------------------
// Pull OTA, masa percobaan, dan rollback otomatis hanya ada di ESP32 (ota_esp32.h): ESP8266 tidak
// punya dua slot firmware yang bergantian, dan satu-satunya UART-nya sudah dipakai untuk Uno
// sehingga tidak ada log Serial untuk memantau prosesnya.
#pragma once

static bool otaBusy = false;
static bool otaPushOn = false;

static inline void otaBeat() {}
static void otaEarlyBoot() {}

static void otaSetup() {
  if (strlen(OTA_PASSWORD) == 0) return;                   // tanpa password, Push OTA tidak dinyalakan
  ArduinoOTA.setHostname(NET_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() {
    otaBusy = true;
    forwardToUno("STOP");                                   // safe state: semua motor dan pompa mati
    broadcastLine("{\"t\":\"ota\",\"st\":\"push\",\"cur\":\"" FW_VERSION "\",\"pct\":0,\"msg\":\"Menerima firmware dari Arduino IDE. Robot dihentikan.\"}");
  });
  ArduinoOTA.onError([](ota_error_t) {
    otaBusy = false;
    broadcastLine("{\"t\":\"ota\",\"st\":\"error\",\"cur\":\"" FW_VERSION "\",\"msg\":\"Push OTA gagal. Firmware lama tetap dipakai.\"}");
  });
  ArduinoOTA.begin();
  otaPushOn = true;
}

static void otaLoop() {
  if (otaPushOn) ArduinoOTA.handle();
}

static bool otaLocksMotion() { return otaBusy; }
static void otaNoteMotion() {}
static void otaLockedReply(Source, uint8_t) {}

static void otaFillInfo(JsonObject o) {
  o["push"] = otaPushOn ? 1 : 0;
  o["pull"] = 0;
  o["sig"] = 0;
  o["rb"] = "none";
  o["st"] = otaBusy ? "push" : "idle";
  o["host"] = NET_HOSTNAME;
  o["group"] = GROUP_ID;
}

static void otaSendStatus(Source src, uint8_t num) {
  sendToClient(src, num, "{\"t\":\"ota\",\"st\":\"off\",\"cur\":\"" FW_VERSION "\",\"msg\":\"Pull OTA hanya tersedia di ESP32.\"}");
}

static void otaCommand(const char*, Source src, uint8_t num) { otaSendStatus(src, num); }
