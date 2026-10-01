/*
  ESP bridge — jembatan WiFi <-> Arduino Uno (untuk FireGuard maupun EcoBot)
  ------------------------------------------------------------------
  Sketch yang sama dipakai di dua robot. Bedanya cuma ROBOT_NAME di bawah.

  Yang dikerjakan ESP di sini hampir cuma "meneruskan":
    Uno  --(Serial, JSON per baris)-->  ESP  -->  dashboard (WebSocket, dan MQTT kalau diaktifkan)
    Uno  <--(Serial, teks per baris)--  ESP  <--  dashboard

  Jadi semua logika robot tetap ada di Uno. ESP hanya menjawab "PING" sendiri
  (untuk mengukur latensi dan kekuatan sinyal) dan memberi tahu alamat IP-nya.

  Board yang didukung: ESP32 (DevKit) dan ESP8266 (NodeMCU / Wemos D1 mini).
  Library yang dibutuhkan (Library Manager):
    - "WebSockets" oleh Markus Sattler
    - "PubSubClient" oleh Nick O'Leary  (hanya kalau USE_MQTT = 1)

  Wiring (ESP32):   Uno TX (pin 1) --[pembagi tegangan 1k/2k]--> ESP32 GPIO16 (RX2)
                    Uno RX (pin 0) <------------------------------ ESP32 GPIO17 (TX2)
                    GND Uno <-> GND ESP
  Uno bekerja di 5 V sedangkan ESP di 3,3 V. Jalur ESP -> Uno aman langsung,
  tapi jalur Uno -> ESP HARUS diturunkan tegangannya (pembagi 1k dan 2k sudah cukup).
  Detail lengkap ada di docs/WIRING.md.
*/

// ==================================================================
//  KONFIGURASI
// ==================================================================
#define ROBOT_NAME   "fireguard"        // "fireguard" atau "ecobot" (dipakai untuk mDNS dan topik MQTT)
#define FW_VERSION   "1.0.0"

#define WIFI_SSID    "NAMA_WIFI"        // WiFi rumah / kampus / hotspot HP
#define WIFI_PASS    "PASSWORD_WIFI"
#define WIFI_TIMEOUT_MS 15000UL         // kalau gagal tersambung, ESP membuat WiFi sendiri (mode AP)
#define AP_PASS      "kopak1234"        // password WiFi mode AP (minimal 8 karakter)

#define WS_PORT      81
#define UART_BAUD    57600              // harus sama dengan SERIAL_BAUD di sketch Uno
#define UART_RX_PIN  16                 // hanya dipakai di ESP32 (RX2)
#define UART_TX_PIN  17                 // hanya dipakai di ESP32 (TX2)

// MQTT (opsional). 0 = mati, 1 = hidup.
#define USE_MQTT     0
#define MQTT_HOST    "broker.hivemq.com"
#define MQTT_PORT    1883
#define MQTT_PREFIX  "kopak"            // HARUS sama dengan "Awalan topik" di pengaturan dashboard; buat yang unik
#define MQTT_USER    NULL
#define MQTT_PASS    NULL

// ==================================================================

#if defined(ESP32)
  #include <WiFi.h>
  #include <ESPmDNS.h>
  #define UnoSerial Serial2
  #define LOG(...)  Serial.printf(__VA_ARGS__)
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266mDNS.h>
  #define UnoSerial Serial              // di ESP8266 satu-satunya UART dipakai untuk Uno, jadi tidak ada log
  #define LOG(...)
#else
  #error "Board tidak didukung. Pilih ESP32 atau ESP8266."
#endif

#include <WebSocketsServer.h>

#if USE_MQTT
  #include <PubSubClient.h>
#endif

enum Source : uint8_t { SRC_WS, SRC_MQTT };

static WebSocketsServer ws(WS_PORT);
static bool apMode = false;

static char lineBuf[384];
static size_t lineLen = 0;
static bool lineOverflow = false;

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
    String s(line);
    ws.sendTXT(num, s);
  }
#if USE_MQTT
  else if (mqtt.connected()) {
    mqtt.publish(topicTel.c_str(), line);
  }
#endif
}

static void sendBridgeInfo(Source src, uint8_t num) {
  char out[200];
  snprintf(out, sizeof(out),
           "{\"t\":\"bridge\",\"robot\":\"%s\",\"fw\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,\"mode\":\"%s\"}",
           ROBOT_NAME, FW_VERSION, ipString().c_str(), apMode ? 0 : (int)WiFi.RSSI(), apMode ? "ap" : "sta");
  sendToClient(src, num, out);
}

// ------------------------------------------------------------------
//  Perintah dari dashboard
// ------------------------------------------------------------------
static void forwardToUno(const char* cmd) {
  UnoSerial.print(cmd);
  UnoSerial.print('\n');
}

static void handleCommand(const char* raw, Source src, uint8_t num) {
  // bersihkan: hanya ASCII yang bisa dicetak, maksimal 40 karakter
  char cmd[41];
  size_t n = 0;
  while (*raw == ' ') raw++;
  for (; *raw && n < sizeof(cmd) - 1; raw++) {
    if (*raw >= 32 && *raw < 127) cmd[n++] = *raw;
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
  if (strcmp(cmd, "INFO") == 0) sendBridgeInfo(src, num);   // lalu tetap diteruskan ke Uno
  forwardToUno(cmd);
}

static void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      LOG("[ws] klien %u tersambung\n", num);
      sendBridgeInfo(SRC_WS, num);
      break;
    case WStype_DISCONNECTED:
      LOG("[ws] klien %u putus\n", num);
      forwardToUno("DRV 0 0");          // dashboard hilang: pastikan robot tidak melaju terus
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
//  Data dari Uno -> semua klien
// ------------------------------------------------------------------
static void publishLine(char* line) {
  String s(line);
  ws.broadcastTXT(s);
#if USE_MQTT
  if (mqtt.connected()) mqtt.publish(topicTel.c_str(), line);
#endif
}

static void readUno() {
  while (UnoSerial.available() > 0) {
    char c = (char)UnoSerial.read();
    if (c == '\n') {
      if (lineLen > 0 && !lineOverflow) {
        lineBuf[lineLen] = '\0';
        if (lineBuf[lineLen - 1] == '\r') lineBuf[--lineLen] = '\0';
        if (lineBuf[0] == '{') publishLine(lineBuf);   // hanya JSON yang diteruskan; teks lain = sampah/debug
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

// ------------------------------------------------------------------
//  WiFi
// ------------------------------------------------------------------
static void startWifi() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
#if defined(ESP32)
  WiFi.setHostname(ROBOT_NAME);
  WiFi.setSleep(false);                 // latensi lebih rendah
#else
  WiFi.hostname(ROBOT_NAME);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
#endif
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  LOG("Menyambung ke WiFi \"%s\"", WIFI_SSID);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) {
    delay(250);
    LOG(".");
  }
  LOG("\n");

  if (WiFi.status() == WL_CONNECTED) {
    apMode = false;
    LOG("Tersambung. IP: %s\n", WiFi.localIP().toString().c_str());
    return;
  }

  // gagal: buat WiFi sendiri supaya dashboard tetap bisa tersambung (alamat 192.168.4.1)
  apMode = true;
  WiFi.disconnect();
  WiFi.mode(WIFI_AP);
  String apName = String(ROBOT_NAME) + "-robot";
  WiFi.softAP(apName.c_str(), AP_PASS);
  LOG("WiFi gagal. Mode AP \"%s\", IP: %s\n", apName.c_str(), WiFi.softAPIP().toString().c_str());
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
  UnoSerial.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
#else
  UnoSerial.begin(UART_BAUD);
#endif

  startWifi();

  if (MDNS.begin(ROBOT_NAME)) {
    MDNS.addService("ws", "tcp", WS_PORT);
    LOG("mDNS: %s.local\n", ROBOT_NAME);
  }

  ws.begin();
  ws.onEvent(onWsEvent);

#if USE_MQTT
  String base = String(MQTT_PREFIX) + "/" + ROBOT_NAME + "/";
  topicCmd = base + "cmd";
  topicTel = base + "tel";
  topicStatus = base + "status";
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setCallback(mqttCallback);
#endif
}

void loop() {
#if defined(ESP8266)
  MDNS.update();
#endif
  ws.loop();
  readUno();
#if USE_MQTT
  mqttLoop();
#endif
}
