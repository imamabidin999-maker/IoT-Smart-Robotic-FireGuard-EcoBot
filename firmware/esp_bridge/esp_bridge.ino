/*
  ESP bridge — jembatan WiFi <-> Arduino Uno (untuk FireGuard maupun EcoBot)
  ------------------------------------------------------------------
  Sketch yang sama dipakai di dua robot. Bedanya cuma ROBOT_NAME di config.h.

  Yang dikerjakan ESP di sini hampir cuma "meneruskan":
    Uno  --(Serial, JSON per baris)-->  ESP  -->  dashboard (WebSocket, dan MQTT kalau diaktifkan)
    Uno  <--(Serial, teks per baris)--  ESP  <--  dashboard

  Jadi semua logika robot tetap ada di Uno. ESP menjawab "PING" sendiri (untuk mengukur latensi dan
  kekuatan sinyal), memberi tahu alamat IP-nya, dan mengurus update firmware-nya sendiri lewat WiFi:
    - Push OTA : upload dari Arduino IDE lewat port jaringan (butuh OTA_PASSWORD)
    - Pull OTA : ESP mengecek server update, dipasang setelah disetujui dari dashboard
    - Safe OTA : firmware baru diperiksa dulu (health check), kalau gagal kembali ke versi lama
  Penjelasan lengkap dan langkah praktikumnya ada di docs/OTA.md.

  SEMUA PENGATURAN ada di config.h. Password WiFi/OTA ditulis di secrets.h (salin dari
  secrets.example.h), supaya tidak ikut ter-upload ke GitHub.

  Board yang didukung: ESP32 (DevKit) dan ESP8266 (NodeMCU / Wemos D1 mini, tanpa Pull OTA).
  Arduino IDE, ESP32: Tools > Partition Scheme > "Default 4MB with spiffs" (JANGAN "Huge APP",
  skema itu tidak punya slot kedua untuk OTA).
  Library yang dibutuhkan (Library Manager):
    - "WebSockets" oleh Markus Sattler
    - "ArduinoJson" oleh Benoit Blanchon, versi 7.x
    - "PubSubClient" oleh Nick O'Leary  (hanya kalau USE_MQTT = 1)

  Wiring (ESP32):   Uno TX (pin 1) --[pembagi tegangan]--> ESP32 GPIO16 (RX2)
                    Uno RX (pin 0) <------------------------ ESP32 GPIO17 (TX2)
                    GND Uno <-> GND ESP
  Uno bekerja di 5 V sedangkan ESP di 3,3 V. Jalur ESP -> Uno aman langsung,
  tapi jalur Uno -> ESP HARUS diturunkan tegangannya. Detail lengkap ada di docs/WIRING.md.
*/

#include "config.h"

#if defined(ESP32)
  #include <WiFi.h>
  #include <ESPmDNS.h>
  #define UnoSerial  Serial2
  #define LOG(...)   Serial.printf(__VA_ARGS__)
  #define BOARD_NAME "esp32"
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266mDNS.h>
  #define UnoSerial  Serial             // di ESP8266 satu-satunya UART dipakai untuk Uno, jadi tidak ada log
  #define LOG(...)
  #define BOARD_NAME "esp8266"
#else
  #error "Board tidak didukung. Pilih ESP32 atau ESP8266."
#endif

#include <WebSocketsServer.h>
#include <ArduinoOTA.h>
#include <ArduinoJson.h>
#include "ota_core.h"

#if USE_MQTT
  #include <PubSubClient.h>
#endif

// Penanda versi di dalam file .bin: "FWID:<produk>:<versi>;". publish_fw.py dan ESP sendiri
// membacanya untuk memastikan file yang akan dipasang memang firmware bridge robot ini dengan
// versi yang sama seperti di manifest.
#define FW_PRODUCT ROBOT_NAME "-bridge"
const char FW_ID[] = "FWID:" FW_PRODUCT ":" FW_VERSION ";";

#if PARAM_API_WASPADA && PARAM_API_BAHAYA && (PARAM_API_WASPADA <= PARAM_API_BAHAYA)
  #error "PARAM_API_WASPADA harus lebih besar dari PARAM_API_BAHAYA (sensor api: nilai kecil = api)"
#endif
#if PARAM_GAS_WASPADA && PARAM_GAS_BAHAYA && (PARAM_GAS_WASPADA >= PARAM_GAS_BAHAYA)
  #error "PARAM_GAS_WASPADA harus lebih kecil dari PARAM_GAS_BAHAYA (sensor gas: nilai besar = gas)"
#endif
#if PARAM_API_WASPADA > 1023 || PARAM_API_BAHAYA > 1023 || PARAM_GAS_WASPADA > 1023 || PARAM_GAS_BAHAYA > 1023 || PARAM_PWM_PUTAR > 255 || PARAM_PWM_MAJU > 255
  #error "Nilai PARAM_ di config.h terlalu besar (ambang maks 1023, PWM maks 255)"
#endif

enum Source : uint8_t { SRC_WS, SRC_MQTT };

static WebSocketsServer ws(WS_PORT);
static bool apMode = false;

static char lineBuf[384];
static size_t lineLen = 0;
static bool lineOverflow = false;

// kondisi robot terakhir menurut Uno (dipakai untuk syarat update dan health check)
static ota::RobotSnap robot;

#if USE_MQTT
static WiFiClient netClient;
static PubSubClient mqtt(netClient);
static String topicCmd, topicTel, topicStatus;
static unsigned long lastMqttTry = 0;
#endif

// ------------------------------------------------------------------
//  Pembantu
// ------------------------------------------------------------------
static String ipString() {
  return (apMode ? WiFi.softAPIP() : WiFi.localIP()).toString();
}

static void sendToClient(Source src, uint8_t num, const char* line) {
  if (src == SRC_WS) {
    ws.sendTXT(num, line);
  }
#if USE_MQTT
  else if (mqtt.connected()) {
    mqtt.publish(topicTel.c_str(), line);
  }
#endif
}

static void broadcastLine(const char* line) {
  ws.broadcastTXT(line);
#if USE_MQTT
  if (mqtt.connected()) mqtt.publish(topicTel.c_str(), line);
#endif
}

static void forwardToUno(const char* cmd) {
  UnoSerial.print(cmd);
  UnoSerial.print('\n');
}

// ------------------------------------------------------------------
//  Data dari Uno -> semua klien
// ------------------------------------------------------------------
static void readUno() {
  while (UnoSerial.available() > 0) {
    char c = (char)UnoSerial.read();
    if (c == '\n') {
      if (lineLen > 0 && !lineOverflow) {
        lineBuf[lineLen] = '\0';
        if (lineBuf[lineLen - 1] == '\r') lineBuf[--lineLen] = '\0';
        if (lineBuf[0] == '{') {                 // hanya JSON yang diteruskan; teks lain = sampah/debug
          ota::parseUnoLine(lineBuf, robot, millis());
          broadcastLine(lineBuf);
        }
      }
      lineLen = 0;
      lineOverflow = false;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineOverflow = true;
    }
  }
}

// Tetap melayani dashboard dan Uno saat ESP sedang sibuk (mis. mengunduh firmware)
static void bridgeService() {
  ws.loop();
  readUno();
#if USE_MQTT
  if (mqtt.connected()) mqtt.loop();
#endif
}

// ------------------------------------------------------------------
//  Parameter robot dari config.h -> Uno (perintah CFG)
// ------------------------------------------------------------------
static void paramWanted(int th[4], int spd[2]) {
  th[0] = PARAM_API_WASPADA; th[1] = PARAM_API_BAHAYA;
  th[2] = PARAM_GAS_WASPADA; th[3] = PARAM_GAS_BAHAYA;
  spd[0] = PARAM_PWM_PUTAR;  spd[1] = PARAM_PWM_MAJU;
}

static unsigned long lastParamSend = 0;

// Uno membalas CFG dengan pesan info berisi nilai barunya, jadi perintah hanya dikirim ulang
// kalau nilainya memang masih berbeda (mis. Uno baru saja restart dan kembali ke nilai bawaan).
static void paramSync(unsigned long now) {
  int th[4], spd[2];
  paramWanted(th, spd);
  if (!(th[0] || th[1] || th[2] || th[3] || spd[0] || spd[1])) return;
  if (!robot.info || !robot.cfg || (lastParamSend && now - lastParamSend < 5000UL)) return;
  char cmd[32];
  bool sent = false;
  if ((th[0] || th[1]) && robot.haveTh) {
    int w = th[0] ? th[0] : robot.th[0], d = th[1] ? th[1] : robot.th[1];
    if ((w != robot.th[0] || d != robot.th[1]) && d >= 1 && d < w && w <= 1023) {
      snprintf(cmd, sizeof(cmd), "CFG F %d %d", w, d);
      forwardToUno(cmd);
      sent = true;
    }
  }
  if ((th[2] || th[3]) && robot.haveTh) {
    int w = th[2] ? th[2] : robot.th[2], d = th[3] ? th[3] : robot.th[3];
    if ((w != robot.th[2] || d != robot.th[3]) && w >= 1 && w < d && d <= 1023) {
      snprintf(cmd, sizeof(cmd), "CFG G %d %d", w, d);
      forwardToUno(cmd);
      sent = true;
    }
  }
  if ((spd[0] || spd[1]) && robot.haveSpd) {
    int t = spd[0] ? spd[0] : robot.spd[0], f = spd[1] ? spd[1] : robot.spd[1];
    if (t != robot.spd[0] || f != robot.spd[1]) {
      snprintf(cmd, sizeof(cmd), "CFG A %d %d", t, f);
      forwardToUno(cmd);
      sent = true;
    }
  }
  if (sent) {
    lastParamSend = now;
    LOG("[Param] Parameter dari firmware ESP dikirim ke Uno.\n");
  }
}

// ------------------------------------------------------------------
//  Update firmware (OTA)
// ------------------------------------------------------------------
#if defined(ESP32)
  #include "ota_esp32.h"
#else
  #include "ota_esp8266.h"
#endif

// ------------------------------------------------------------------
//  Perintah dari dashboard
// ------------------------------------------------------------------
static void sendBridgeInfo(Source src, uint8_t num) {
  JsonDocument d;
  d["t"] = "bridge";
  d["robot"] = ROBOT_NAME;
  d["fw"] = FW_VERSION;
  d["id"] = FW_ID;
  d["board"] = BOARD_NAME;
  String ip = ipString();                     // disimpan dulu: ArduinoJson lama hanya menyimpan alamat teksnya
  d["ip"] = ip.c_str();
  d["rssi"] = apMode ? 0 : (int)WiFi.RSSI();
  d["mode"] = apMode ? "ap" : "sta";
  otaFillInfo(d["ota"].to<JsonObject>());
  char out[560];
  serializeJson(d, out, sizeof(out));
  sendToClient(src, num, out);
}

// Perintah yang tetap boleh lewat saat firmware sedang diperbarui / diperiksa: berhenti,
// minta data, dan mengatur batas kecepatan. Selain itu ditolak supaya robot tetap diam.
static bool isSafeCommand(const char* cmd) {
  if (!strncmp(cmd, "GET", 3) || !strncmp(cmd, "INFO", 4) || !strncmp(cmd, "STOP", 4) ||
      !strncmp(cmd, "SPD", 3) || !strncmp(cmd, "HELP", 4)) return true;
  if (!strcmp(cmd, "MODE M") || !strcmp(cmd, "PUMP 0") || !strcmp(cmd, "BRUSH 0")) return true;
  if (!strncmp(cmd, "DRV ", 4)) {
    int x = 1, y = 1;
    return sscanf(cmd + 4, "%d %d", &x, &y) == 2 && x == 0 && y == 0;
  }
  return false;
}

static void handleCommand(const char* raw, Source src, uint8_t num) {
  // bersihkan: hanya ASCII yang bisa dicetak, huruf besar, maksimal 40 karakter
  char cmd[41];
  size_t n = 0;
  while (*raw == ' ') raw++;
  for (; *raw && n < sizeof(cmd) - 1; raw++) {
    char c = *raw;
    if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
    if (c >= 32 && c < 127) cmd[n++] = c;
  }
  while (n > 0 && cmd[n - 1] == ' ') n--;
  cmd[n] = '\0';
  if (n == 0) return;

  if (strncmp(cmd, "PING", 4) == 0) {
    char out[120];
    snprintf(out, sizeof(out), "{\"t\":\"pong\",\"n\":%ld,\"rssi\":%d,\"up\":%lu}",
             atol(cmd + 4), apMode ? 0 : (int)WiFi.RSSI(), millis() / 1000UL);
    sendToClient(src, num, out);
    return;
  }
  if (strncmp(cmd, "OTA", 3) == 0 && (cmd[3] == '\0' || cmd[3] == ' ')) {
    otaCommand(cmd + 3, src, num);           // urusan ESP sendiri, tidak diteruskan ke Uno
    return;
  }
  const bool motion = !isSafeCommand(cmd);
  if (motion && otaLocksMotion()) {
    otaLockedReply(src, num);
    return;
  }
  if (motion) otaNoteMotion();
  if (strcmp(cmd, "INFO") == 0) {             // lalu tetap diteruskan ke Uno
    sendBridgeInfo(src, num);
    otaSendStatus(src, num);
  }
  forwardToUno(cmd);
}

static void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      LOG("[ws] klien %u tersambung\n", num);
      sendBridgeInfo(SRC_WS, num);
      otaSendStatus(SRC_WS, num);
      break;
    case WStype_DISCONNECTED:
      LOG("[ws] klien %u putus\n", num);
      forwardToUno("DRV 0 0");          // dashboard hilang: pastikan robot tidak melaju terus
      forwardToUno("BRUSH 0");          // EcoBot: matikan sapu (FireGuard mengabaikan perintah ini)
      break;
    case WStype_TEXT: {
      char buf[64];
      size_t n = length < sizeof(buf) - 1 ? length : sizeof(buf) - 1;
      memcpy(buf, payload, n);
      buf[n] = '\0';
      handleCommand(buf, SRC_WS, num);
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------------
//  WiFi
// ------------------------------------------------------------------
static void startWifi() {
  WiFi.persistent(false);
  // WIFI_SSID belum diisi: tidak usah menunggu, langsung buat WiFi sendiri
  const bool adaWifi = strlen(WIFI_SSID) > 0 && strcmp(WIFI_SSID, "NAMA_WIFI") != 0;
  if (adaWifi) {
    WiFi.mode(WIFI_STA);
#if defined(ESP32)
    WiFi.setHostname(NET_HOSTNAME);
    WiFi.setSleep(false);               // latensi lebih rendah
#else
    WiFi.hostname(NET_HOSTNAME);
    WiFi.setSleepMode(WIFI_NONE_SLEEP);
#endif
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    LOG("Menyambung ke WiFi \"%s\"", WIFI_SSID);

    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) {
      otaBeat();
      delay(250);
      LOG(".");
    }
    LOG("\n");

    if (WiFi.status() == WL_CONNECTED) {
      apMode = false;
      LOG("Tersambung. IP: %s\n", WiFi.localIP().toString().c_str());
      return;
    }
    WiFi.disconnect();
    LOG("WiFi \"%s\" tidak tersambung.\n", WIFI_SSID);
  } else {
    LOG("WIFI_SSID belum diisi, langsung membuat WiFi sendiri.\n");
  }

  // buat WiFi sendiri supaya dashboard tetap bisa tersambung (alamat 192.168.4.1)
  apMode = true;
  WiFi.mode(WIFI_AP);
  String apName = String(ROBOT_NAME) + "-robot";
  WiFi.softAP(apName.c_str(), AP_PASS);
  LOG("Mode AP: WiFi \"%s\", alamat robot %s (password ada di config.h / secrets.h)\n",
      apName.c_str(), WiFi.softAPIP().toString().c_str());
}

// ------------------------------------------------------------------
//  MQTT
// ------------------------------------------------------------------
#if USE_MQTT
static void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char buf[64];
  size_t n = length < sizeof(buf) - 1 ? length : sizeof(buf) - 1;
  memcpy(buf, payload, n);
  buf[n] = '\0';
  handleCommand(buf, SRC_MQTT, 0);
}

static void mqttLoop() {
  if (apMode || WiFi.status() != WL_CONNECTED) return;
  if (!mqtt.connected()) {
    if (millis() - lastMqttTry < 5000UL) return;
    lastMqttTry = millis();
#if defined(ESP32)
    uint32_t chip = (uint32_t)ESP.getEfuseMac();
#else
    uint32_t chip = ESP.getChipId();
#endif
    String cid = String("kopak-") + ROBOT_NAME + "-" + String(chip, HEX);
    // will: kalau ESP mati mendadak, broker otomatis menandai robot "offline"
    if (mqtt.connect(cid.c_str(), MQTT_USER, MQTT_PASS, topicStatus.c_str(), 0, true, "offline")) {
      mqtt.publish(topicStatus.c_str(), "online", true);
      mqtt.subscribe(topicCmd.c_str());
      LOG("[mqtt] tersambung ke %s\n", MQTT_HOST);
    } else {
      LOG("[mqtt] gagal, kode %d\n", mqtt.state());
    }
    return;
  }
  mqtt.loop();
}
#endif

// ------------------------------------------------------------------
//  setup & loop
// ------------------------------------------------------------------
void setup() {
#if defined(ESP32)
  Serial.begin(115200);                                        // log lewat USB
  UnoSerial.setRxBufferSize(1024);                             // telemetri tetap tertampung saat ESP sibuk
  UnoSerial.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
#else
  UnoSerial.begin(UART_BAUD);
#endif
  forwardToUno("STOP");             // safe state: setiap kali ESP menyala atau restart, robot berhenti dulu

  LOG("\n=== %s | %s | %s | firmware v%s ===\n", GROUP_ID, ROBOT_NAME, BOARD_NAME, FW_VERSION);
  LOG("Penanda versi: %s\n", FW_ID);
  otaEarlyBoot();                   // masa percobaan / rollback dicek sebelum hal lain

  startWifi();
  otaSetup();                       // Push OTA ikut menyalakan mDNS dengan nama NET_HOSTNAME

  if (!otaPushOn) MDNS.begin(NET_HOSTNAME);
  MDNS.addService("ws", "tcp", WS_PORT);
  LOG("mDNS: %s.local\n", NET_HOSTNAME);

  ws.begin();
  ws.onEvent(onWsEvent);
  forwardToUno("INFO");             // minta versi firmware dan pengaturan Uno

#if USE_MQTT
  String base = String(MQTT_PREFIX) + "/" + ROBOT_NAME + "/";
  topicCmd = base + "cmd";
  topicTel = base + "tel";
  topicStatus = base + "status";
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(640);
  mqtt.setCallback(mqttCallback);
#endif
}

void loop() {
#if defined(ESP8266)
  MDNS.update();
#endif
  otaLoop();
  ws.loop();
  readUno();
  paramSync(millis());
#if USE_MQTT
  mqttLoop();
#endif
}
