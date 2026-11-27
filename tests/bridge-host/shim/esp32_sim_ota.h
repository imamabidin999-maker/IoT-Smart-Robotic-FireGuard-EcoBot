// esp32_sim_ota.h — flash dua slot, otadata, Update, ArduinoOTA, HTTPClient, Preferences,
// WebSocketsServer, esp_timer palsu. Lihat esp32_sim.h.
#pragma once

#include "esp32_sim.h"

// ------------------------------------------------------------------
//  esp_err / partisi / otadata
// ------------------------------------------------------------------
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NOT_FOUND 0x105
#define ESP_ERR_OTA_VALIDATE_FAILED 0x1503
#define ESP_ERR_OTA_ROLLBACK_FAILED 0x1504
inline const char* esp_err_to_name(esp_err_t e) {
  switch (e) {
    case ESP_OK: return "ESP_OK";
    case ESP_ERR_OTA_VALIDATE_FAILED: return "ESP_ERR_OTA_VALIDATE_FAILED";
    case ESP_ERR_OTA_ROLLBACK_FAILED: return "ESP_ERR_OTA_ROLLBACK_FAILED";
    default: return "ESP_FAIL";
  }
}

typedef struct {
  int index;
  uint32_t address;
  uint32_t size;
  char label[17];
} esp_partition_t;

typedef enum {
  ESP_OTA_IMG_NEW = 0,
  ESP_OTA_IMG_PENDING_VERIFY = 1,
  ESP_OTA_IMG_VALID = 2,
  ESP_OTA_IMG_INVALID = 3,
  ESP_OTA_IMG_ABORTED = 4,
  ESP_OTA_IMG_UNDEFINED = -1,
} esp_ota_img_states_t;

struct SimSlot {
  std::vector<uint8_t> img;
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
};
extern SimSlot g_slot[2];
extern esp_partition_t g_part[2];
extern int g_boot;
extern int g_running;
void sim_save_flash();
bool sim_image_ok(int slot);

inline const esp_partition_t* esp_ota_get_running_partition() { return &g_part[g_running]; }
inline const esp_partition_t* esp_ota_get_boot_partition() { return &g_part[g_boot]; }
inline const esp_partition_t* esp_ota_get_next_update_partition(const esp_partition_t*) { return &g_part[1 - g_running]; }
inline esp_err_t esp_ota_get_state_partition(const esp_partition_t* p, esp_ota_img_states_t* s) {
  *s = g_slot[p->index].state;
  return ESP_OK;
}
inline esp_err_t esp_ota_mark_app_valid_cancel_rollback() {
  g_slot[g_running].state = ESP_OTA_IMG_VALID;
  sim_save_flash();
  return ESP_OK;
}
inline esp_err_t esp_ota_set_boot_partition(const esp_partition_t* p) {
  if (!sim_image_ok(p->index)) return ESP_ERR_OTA_VALIDATE_FAILED;
  g_boot = p->index;
  g_slot[p->index].state = ESP_OTA_IMG_NEW;
  sim_save_flash();
  return ESP_OK;
}
inline esp_err_t esp_ota_mark_app_invalid_rollback_and_reboot() {
  int other = 1 - g_running;
  esp_ota_img_states_t s = g_slot[other].state;
  if (!sim_image_ok(other) || s == ESP_OTA_IMG_INVALID || s == ESP_OTA_IMG_ABORTED) return ESP_ERR_OTA_ROLLBACK_FAILED;
  g_slot[g_running].state = ESP_OTA_IMG_INVALID;
  g_boot = other;
  sim_save_flash();
  sim_restart("rollback (mark invalid)");
}
esp_err_t esp_partition_get_sha256(const esp_partition_t* p, uint8_t* out);
inline esp_err_t esp_partition_read(const esp_partition_t* p, size_t off, void* dst, size_t n) {
  const auto& img = g_slot[p->index].img;
  memset(dst, 0xFF, n);
  if (off < img.size()) memcpy(dst, img.data() + off, std::min(n, img.size() - off));
  return ESP_OK;
}

// ------------------------------------------------------------------
//  esp_timer
// ------------------------------------------------------------------
typedef void (*esp_timer_cb_t)(void*);
typedef enum { ESP_TIMER_TASK = 0 } esp_timer_dispatch_t;
typedef struct {
  esp_timer_cb_t callback;
  void* arg;
  esp_timer_dispatch_t dispatch_method;
  const char* name;
  bool skip_unhandled_events;
} esp_timer_create_args_t;
struct SimTimer {
  esp_timer_cb_t cb;
  void* arg;
  uint32_t periodMs;
  uint32_t next;
  bool on;
};
typedef SimTimer* esp_timer_handle_t;
extern std::vector<SimTimer*> g_timers;
inline esp_err_t esp_timer_create(const esp_timer_create_args_t* a, esp_timer_handle_t* h) {
  *h = new SimTimer{a->callback, a->arg, 0, 0, false};
  g_timers.push_back(*h);
  return ESP_OK;
}
inline esp_err_t esp_timer_start_periodic(esp_timer_handle_t h, uint64_t us) {
  h->periodMs = (uint32_t)(us / 1000ULL);
  h->next = g_ms + h->periodMs;
  h->on = true;
  return ESP_OK;
}

#define RTC_NOINIT_ATTR

// ------------------------------------------------------------------
//  Update
// ------------------------------------------------------------------
#define UPDATE_SIZE_UNKNOWN 0xFFFFFFFF
class UpdateClass {
 public:
  bool begin(size_t size, int = 0, int = -1, uint8_t = 0, const char* = nullptr);
  size_t write(uint8_t* data, size_t len);
  bool end(bool evenIfRemaining = false);
  void abort() { running_ = false; buf_.clear(); }
  bool setMD5(const char* md5) { md5_ = md5 ? md5 : ""; return true; }
  const char* errorString() { return err_.c_str(); }
  bool isRunning() { return running_; }

 private:
  bool running_ = false;
  size_t size_ = 0;
  std::vector<uint8_t> buf_;
  std::string md5_;
  std::string err_ = "No Error";
};
extern UpdateClass Update;

// ------------------------------------------------------------------
//  ArduinoOTA (Push OTA). Harness mengisi g_push_* untuk meniru upload dari Arduino IDE.
// ------------------------------------------------------------------
typedef enum { OTA_AUTH_ERROR, OTA_BEGIN_ERROR, OTA_CONNECT_ERROR, OTA_RECEIVE_ERROR, OTA_END_ERROR } ota_error_t;
extern std::string g_push_file, g_push_pass;
class ArduinoOTAClass {
 public:
  typedef std::function<void(void)> THandlerFunction;
  typedef std::function<void(ota_error_t)> THandlerFunction_Error;
  typedef std::function<void(unsigned int, unsigned int)> THandlerFunction_Progress;
  ArduinoOTAClass& setHostname(const char* h) { host_ = h; return *this; }
  ArduinoOTAClass& setPassword(const char* p) { pass_ = p; return *this; }
  ArduinoOTAClass& onStart(THandlerFunction f) { start_ = f; return *this; }
  ArduinoOTAClass& onEnd(THandlerFunction f) { end_ = f; return *this; }
  ArduinoOTAClass& onError(THandlerFunction_Error f) { err_ = f; return *this; }
  ArduinoOTAClass& onProgress(THandlerFunction_Progress f) { prog_ = f; return *this; }
  void begin() { on_ = true; printf("OTAHOST %s\n", host_.c_str()); }
  void handle();

 private:
  std::string host_, pass_;
  bool on_ = false;
  THandlerFunction start_, end_;
  THandlerFunction_Error err_;
  THandlerFunction_Progress prog_;
};
extern ArduinoOTAClass ArduinoOTA;

// ------------------------------------------------------------------
//  HTTPClient: URL http(s)://sim.local:8000/<path> dibaca dari folder SIM_SERVER/<path>
// ------------------------------------------------------------------
#define HTTP_CODE_OK 200
#define HTTP_CODE_NOT_FOUND 404
#define HTTPC_ERROR_CONNECTION_REFUSED (-1)
typedef enum { HTTPC_DISABLE_FOLLOW_REDIRECTS, HTTPC_STRICT_FOLLOW_REDIRECTS, HTTPC_FORCE_FOLLOW_REDIRECTS } followRedirects_t;
class HTTPClient {
 public:
  bool begin(WiFiClient& c, String url);
  int GET();
  int getSize() { return size_; }
  String getString();
  WiFiClient* getStreamPtr() { return cli_; }
  bool connected() { return cli_ && cli_->connected(); }
  void end() {}
  void setFollowRedirects(followRedirects_t) {}
  void setConnectTimeout(int32_t) {}
  void setTimeout(uint16_t) {}
  static String errorToString(int e) { return String(e == -1 ? "connection refused" : "error"); }

 private:
  WiFiClient* cli_ = nullptr;
  std::string url_;
  int size_ = -1;
};

// ------------------------------------------------------------------
//  Preferences (NVS)
// ------------------------------------------------------------------
class Preferences {
 public:
  bool begin(const char* ns, bool = false) { ns_ = ns; return true; }
  void end() {}
  size_t putBytes(const char* key, const void* v, size_t n);
  size_t getBytesLength(const char* key);
  size_t getBytes(const char* key, void* buf, size_t n);

 private:
  std::string ns_;
};

// ------------------------------------------------------------------
//  WebSocketsServer
// ------------------------------------------------------------------
typedef enum { WStype_ERROR, WStype_DISCONNECTED, WStype_CONNECTED, WStype_TEXT, WStype_BIN } WStype_t;
struct SimWsEvent {
  WStype_t type;
  std::string text;
};
extern std::deque<SimWsEvent> g_ws_queue;
class WebSocketsServer {
 public:
  typedef std::function<void(uint8_t num, WStype_t type, uint8_t* payload, size_t length)> WebSocketServerEvent;
  explicit WebSocketsServer(uint16_t) {}
  void begin() {}
  void onEvent(WebSocketServerEvent cb) { cb_ = cb; }
  void loop() {
    while (!g_ws_queue.empty() && cb_) {
      SimWsEvent e = g_ws_queue.front();
      g_ws_queue.pop_front();
      std::vector<uint8_t> p(e.text.begin(), e.text.end());
      p.push_back(0);
      cb_(0, e.type, p.data(), e.text.size());
    }
  }
  bool sendTXT(uint8_t num, const char* payload, size_t = 0) { printf("WS%u %s\n", num, payload); return true; }
  bool broadcastTXT(const char* payload, size_t = 0) { printf("WS* %s\n", payload); return true; }

 private:
  WebSocketServerEvent cb_;
};
