// esp32_sim.h — ESP32 palsu untuk menjalankan esp_bridge.ino di PC.
// ------------------------------------------------------------------
// Bukan emulator: hanya meniru perilaku API yang dipakai sketch, cukup untuk menguji alur OTA:
//   - flash dengan dua slot aplikasi (ota_0, ota_1) + otadata (slot boot dan status tiap slot),
//     disimpan di folder SIM_STATE supaya bertahan antar "boot" (antar proses)
//   - NVS (Preferences), HTTP(S) dari folder SIM_SERVER, WebSocket, ArduinoOTA, Update, esp_timer
//   - ESP.restart() menyimpan semuanya lalu keluar dengan kode 77; skrip uji menjalankan proses
//     berikutnya sesuai slot boot (meniru bootloader)
// Satu baris keluaran per kejadian, supaya mudah diperiksa skrip uji:
//   LOG <teks>       Serial.printf dari sketch
//   WS* <json>       broadcast WebSocket       WS0 <json>   kirim ke klien 0
//   UNO <perintah>   baris yang dikirim ESP ke Uno
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
#include <string>
#include <vector>
#include <deque>
#include <functional>
#include <map>
#include <algorithm>
#include <ctime>

// ------------------------------------------------------------------
//  Waktu
// ------------------------------------------------------------------
extern uint32_t g_ms;
void sim_advance(uint32_t ms);           // majukan waktu + jalankan timer (didefinisikan di harness)
inline unsigned long millis() { return g_ms; }
inline unsigned long micros() { return (unsigned long)g_ms * 1000UL; }
inline void delay(uint32_t ms) { sim_advance(ms); }
inline void yield() {}

#define HEX 16
#define DEC 10
typedef uint8_t byte;

// ------------------------------------------------------------------
//  String Arduino (secukupnya)
// ------------------------------------------------------------------
class String {
 public:
  String() {}
  String(const char* s) : s_(s ? s : "") {}
  String(const std::string& s) : s_(s) {}
  String(int v) : s_(std::to_string(v)) {}
  String(unsigned long v, int base = 10) {
    char b[24];
    snprintf(b, sizeof(b), base == 16 ? "%lx" : "%lu", v);
    s_ = b;
  }
  const char* c_str() const { return s_.c_str(); }
  size_t length() const { return s_.size(); }
  bool startsWith(const char* p) const { return s_.rfind(p, 0) == 0; }
  void toLowerCase() { for (auto& c : s_) c = (char)tolower(c); }
  String operator+(const String& o) const { return String(s_ + o.s_); }
  String operator+(const char* o) const { return String(s_ + (o ? o : "")); }
  friend String operator+(const char* a, const String& b) { return String(std::string(a) + b.s_); }
  String& operator+=(const String& o) { s_ += o.s_; return *this; }
  bool operator==(const char* o) const { return s_ == (o ? o : ""); }
  std::string s_;
};

// ------------------------------------------------------------------
//  Serial
// ------------------------------------------------------------------
#define SERIAL_8N1 0x800001c

class HardwareSerial {
 public:
  explicit HardwareSerial(int id) : id_(id) {}
  void begin(unsigned long, uint32_t = SERIAL_8N1, int8_t = -1, int8_t = -1) {}
  void setRxBufferSize(size_t) {}
  int available() { return (int)in.size(); }
  int read() {
    if (in.empty()) return -1;
    char c = in.front();
    in.pop_front();
    return (unsigned char)c;
  }
  size_t print(const char* s) { out_(s); return strlen(s); }
  size_t print(char c) { char b[2] = {c, 0}; out_(b); return 1; }
  size_t print(int v) { return print(std::to_string(v).c_str()); }
  size_t println(const char* s = "") { print(s); return print('\n'); }
  size_t printf(const char* fmt, ...) __attribute__((format(printf, 2, 3))) {
    char b[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(b, sizeof(b), fmt, ap);
    va_end(ap);
    out_(b);
    return strlen(b);
  }
  std::deque<char> in;
  std::string pending;

 private:
  void out_(const char* s);
  int id_;
};
extern HardwareSerial Serial;
extern HardwareSerial Serial2;

// ------------------------------------------------------------------
//  ESP
// ------------------------------------------------------------------
[[noreturn]] void sim_restart(const char* why);
inline void esp_restart() { sim_restart("esp_restart"); }
extern uint32_t g_free_heap;
class EspClass {
 public:
  [[noreturn]] void restart() { sim_restart("ESP.restart"); }
  uint32_t getFreeHeap() { return g_free_heap; }
  uint64_t getEfuseMac() { return 0x1234567890ULL; }
};
extern EspClass ESP;

// ------------------------------------------------------------------
//  Jaringan
// ------------------------------------------------------------------
class IPAddress {
 public:
  IPAddress(uint8_t a = 0, uint8_t b = 0, uint8_t c = 0, uint8_t d = 0) : a_{a, b, c, d} {}
  String toString() const {
    char s[20];
    snprintf(s, sizeof(s), "%u.%u.%u.%u", a_[0], a_[1], a_[2], a_[3]);
    return String(s);
  }

 private:
  uint8_t a_[4];
};

#define WL_CONNECTED 3
#define WL_DISCONNECTED 6
enum wifi_mode_t { WIFI_OFF = 0, WIFI_STA = 1, WIFI_AP = 2, WIFI_AP_STA = 3 };

extern bool g_sta_available;
class WiFiClass {
 public:
  void persistent(bool) {}
  void mode(wifi_mode_t m) { mode_ = m; }
  void setHostname(const char*) {}
  void setSleep(bool) {}
  void setAutoReconnect(bool) {}
  void begin(const char*, const char*) { status_ = g_sta_available ? WL_CONNECTED : WL_DISCONNECTED; }
  int status() { return status_; }
  void disconnect() { status_ = WL_DISCONNECTED; }
  bool softAP(const char*, const char*) { return true; }
  IPAddress localIP() { return IPAddress(192, 168, 10, 31); }
  IPAddress softAPIP() { return IPAddress(192, 168, 4, 1); }
  int RSSI() { return -55; }

 private:
  int status_ = WL_DISCONNECTED;
  wifi_mode_t mode_ = WIFI_OFF;
};
extern WiFiClass WiFi;

inline void configTime(long, int, const char*, const char* = nullptr, const char* = nullptr) {}

class WiFiClient {
 public:
  virtual ~WiFiClient() {}
  int available() { return (int)(data.size() - pos); }
  int read(uint8_t* b, size_t n) {
    size_t k = std::min(n, data.size() - pos);
    memcpy(b, data.data() + pos, k);
    pos += k;
    return (int)k;
  }
  bool connected() { return pos < data.size(); }
  std::string data;
  size_t pos = 0;
};

class WiFiClientSecure : public WiFiClient {
 public:
  void setCACert(const char* ca) { ca_ = ca; }
  void setHandshakeTimeout(unsigned long) {}
  const char* ca_ = nullptr;
};

class MDNSResponder {
 public:
  bool begin(const char*) { return true; }
  bool addService(const char*, const char*, uint16_t) { return true; }
};
extern MDNSResponder MDNS;
