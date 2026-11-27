// Harness: menjalankan esp_bridge.ino asli di PC dengan ESP32, Uno, server, dan dashboard palsu.
// Dikendalikan lewat stdin (satu perintah per baris); setelah tiap perintah dicetak "DONE".
//
//   INIT                 meniru initArduino() lalu memanggil setup()
//   T <ms>               majukan waktu (loop() dipanggil tiap 5 ms, Uno mengirim telemetri tiap 250 ms)
//   WSC / WSD            dashboard tersambung / putus
//   WS <teks>            dashboard mengirim perintah
//   SER <teks>           ketik di Serial Monitor ESP
//   UNO <isian> <nilai>  ubah kondisi Uno palsu: mode A|M, sp N, fl a b, gs a b, fe a b, ge a b,
//                        noerr (Uno lama tanpa fe/ge), off|on (berhenti/kirim telemetri), fw x.y.z,
//                        robot nama, nocfg, gw 0|1
//   PUSH <file> <pass>   tiru upload dari Arduino IDE (Push OTA)
//   HEAP <byte>          sisa memori palsu
//
// Lingkungan: SIM_STATE (folder flash+NVS), SIM_SERVER (folder server update), SIM_RUNNING (slot yang
// dipilih bootloader), SIM_STA (1 = WiFi ditemukan), SIM_TLS_NEEDLE (teks yang wajib ada di Root CA).
#include "Arduino.h"

#include <fstream>
#include <sstream>
#include <csignal>
#include <unistd.h>
#include "mbedtls/version.h"
#include "mbedtls/sha256.h"
#include "mbedtls/md5.h"

uint32_t g_ms = 0;
uint32_t g_free_heap = 180000;
bool g_sta_available = true;
HardwareSerial Serial(0);
HardwareSerial Serial2(2);
EspClass ESP;
WiFiClass WiFi;
MDNSResponder MDNS;
UpdateClass Update;
ArduinoOTAClass ArduinoOTA;
SimSlot g_slot[2];
esp_partition_t g_part[2] = {{0, 0x10000, 0x140000, "app0"}, {1, 0x150000, 0x140000, "app1"}};
int g_boot = 0;
int g_running = 0;
std::vector<SimTimer*> g_timers;
std::deque<SimWsEvent> g_ws_queue;
std::string g_push_file, g_push_pass;

static std::string g_state = ".", g_server = ".", g_tls_needle;

extern "C" bool verifyRollbackLater();     // bawaan core: false (sim_weak.cpp); sketch boleh menimpanya

// ------------------------------------------------------------------
//  File
// ------------------------------------------------------------------
static bool readFile(const std::string& p, std::string& out) {
  std::ifstream f(p, std::ios::binary);
  if (!f) return false;
  std::ostringstream ss;
  ss << f.rdbuf();
  out = ss.str();
  return true;
}
static void writeFile(const std::string& p, const std::string& d) {
  std::ofstream f(p, std::ios::binary | std::ios::trunc);
  f << d;
}

void sim_save_flash() {
  std::ostringstream ss;
  ss << "boot=" << g_boot << "\nst0=" << (int)g_slot[0].state << "\nst1=" << (int)g_slot[1].state << "\n";
  writeFile(g_state + "/otadata.txt", ss.str());
  for (int i = 0; i < 2; i++)
    writeFile(g_state + "/slot" + std::to_string(i) + ".bin", std::string(g_slot[i].img.begin(), g_slot[i].img.end()));
}

static void loadFlash() {
  std::string t;
  if (readFile(g_state + "/otadata.txt", t)) {
    int b = 0, s0 = -1, s1 = -1;
    sscanf(t.c_str(), "boot=%d\nst0=%d\nst1=%d", &b, &s0, &s1);
    g_boot = b;
    g_slot[0].state = (esp_ota_img_states_t)s0;
    g_slot[1].state = (esp_ota_img_states_t)s1;
  }
  for (int i = 0; i < 2; i++) {
    std::string d;
    if (readFile(g_state + "/slot" + std::to_string(i) + ".bin", d)) g_slot[i].img.assign(d.begin(), d.end());
  }
}

bool sim_image_ok(int slot) {
  const auto& im = g_slot[slot].img;
  return im.size() >= 24 && im[0] == 0xE9;
}

[[noreturn]] void sim_restart(const char* why) {
  sim_save_flash();
  printf("RESTART %s\n", why);
  fflush(stdout);
  _exit(77);
}

static void sha256(const uint8_t* d, size_t n, uint8_t out[32]) {
  mbedtls_sha256_context c;
  mbedtls_sha256_init(&c);
#if MBEDTLS_VERSION_MAJOR >= 3
  mbedtls_sha256_starts(&c, 0); mbedtls_sha256_update(&c, d, n); mbedtls_sha256_finish(&c, out);
#else
  mbedtls_sha256_starts_ret(&c, 0); mbedtls_sha256_update_ret(&c, d, n); mbedtls_sha256_finish_ret(&c, out);
#endif
  mbedtls_sha256_free(&c);
}

esp_err_t esp_partition_get_sha256(const esp_partition_t* p, uint8_t* out) {
  const auto& im = g_slot[p->index].img;
  if (!sim_image_ok(p->index)) return ESP_ERR_OTA_VALIDATE_FAILED;
  sha256(im.data(), im.size(), out);
  return ESP_OK;
}

// ------------------------------------------------------------------
//  Uno palsu
// ------------------------------------------------------------------
struct FakeUno {
  bool on = true;
  char mode = 'M';
  int sp = 0, pump = 0, gw = 0;
  std::vector<int> fl{800, 790}, gs{150, 160}, fe{0, 0}, ge{0, 0};
  bool sendErr = true, cfg = true;
  std::string robot = "fireguard", fw = "1.4.0";
  int th[4] = {700, 400, 350, 550};
  int spd[2] = {150, 140};
  uint32_t nextTel = 0;
};
static FakeUno uno;

static std::string arr(const std::vector<int>& v) {
  std::string s = "[";
  for (size_t i = 0; i < v.size(); i++) s += (i ? "," : "") + std::to_string(v[i]);
  return s + "]";
}

static void unoSay(const std::string& line) {
  for (char c : line) Serial2.in.push_back(c);
  Serial2.in.push_back('\n');
}

static void unoTel() {
  if (!uno.on) return;
  std::ostringstream s;
  s << "{\"t\":\"tel\",\"up\":" << g_ms / 1000 << ",\"m\":\"" << uno.mode << "\",\"st\":\"" << (uno.mode == 'M' ? "manual" : "idle")
    << "\",\"fl\":" << arr(uno.fl) << ",\"fs\":[0,0],\"gs\":" << arr(uno.gs) << ",\"gl\":[0,0],\"gw\":" << uno.gw;
  if (uno.sendErr) s << ",\"fe\":" << arr(uno.fe) << ",\"ge\":" << arr(uno.ge);
  s << ",\"p\":" << uno.pump << ",\"na\":90,\"sp\":" << uno.sp << ",\"cap\":160}";
  unoSay(s.str());
}

static void unoInfo() {
  if (!uno.on) return;
  std::ostringstream s;
  s << "{\"t\":\"info\",\"robot\":\"" << uno.robot << "\",\"fw\":\"" << uno.fw
    << "\",\"flame\":[\"Kiri\",\"Kanan\"],\"flamePins\":[\"A0\",\"A1\"],\"gas\":[\"MQ-2 #1\",\"MQ-2 #2\"],\"gasPins\":[\"A3\",\"A4\"]"
    << ",\"th\":{\"fw\":" << uno.th[0] << ",\"fd\":" << uno.th[1] << ",\"gw\":" << uno.th[2] << ",\"gd\":" << uno.th[3] << "}"
    << ",\"noz\":{\"min\":40,\"max\":140,\"home\":90}";
  if (uno.cfg) s << ",\"spd\":{\"turn\":" << uno.spd[0] << ",\"fwd\":" << uno.spd[1] << "},\"cfg\":1";
  s << ",\"pump\":1}";
  unoSay(s.str());
}

static void unoHandle(const std::string& cmd) {
  char a[16] = {0};
  int x = 0, y = 0;
  if (cmd == "STOP" || cmd == "MODE M") { uno.mode = 'M'; uno.sp = 0; uno.pump = 0; unoTel(); }
  else if (cmd == "MODE A") { uno.mode = 'A'; unoTel(); }
  else if (sscanf(cmd.c_str(), "DRV %d %d", &x, &y) == 2) { if (uno.mode == 'M') uno.sp = (x || y) ? 120 : 0; }
  else if (cmd == "INFO") { unoInfo(); unoTel(); }
  else if (uno.cfg && sscanf(cmd.c_str(), "CFG %15s %d %d", a, &x, &y) == 3) {
    if (!strcmp(a, "F") && y >= 1 && y < x && x <= 1023) { uno.th[0] = x; uno.th[1] = y; unoInfo(); }
    else if (!strcmp(a, "G") && x >= 1 && x < y && y <= 1023) { uno.th[2] = x; uno.th[3] = y; unoInfo(); }
    else if (!strcmp(a, "A") && x >= 0 && x <= 255 && y >= 0 && y <= 255) { uno.spd[0] = x; uno.spd[1] = y; unoInfo(); }
  }
}

void HardwareSerial::out_(const char* s) {
  for (; *s; s++) {
    if (*s == '\n') {
      if (id_ == 0) ::printf("LOG %s\n", pending.c_str());
      else { ::printf("UNO %s\n", pending.c_str()); std::string c = pending; pending.clear(); unoHandle(c); continue; }
      pending.clear();
    } else if (*s != '\r') {
      pending += *s;
    }
  }
}

// ------------------------------------------------------------------
//  Waktu & timer
// ------------------------------------------------------------------
void sim_advance(uint32_t ms) {
  for (uint32_t i = 0; i < ms; i++) {
    g_ms++;
    if (g_ms >= uno.nextTel) { uno.nextTel = g_ms + 250; unoTel(); }
    for (SimTimer* t : g_timers) {
      while (t->on && t->periodMs && g_ms >= t->next) { t->next += t->periodMs; t->cb(t->arg); }
    }
  }
}

// ------------------------------------------------------------------
//  Update / ArduinoOTA / HTTP / NVS
// ------------------------------------------------------------------
bool UpdateClass::begin(size_t size, int, int, uint8_t, const char*) {
  if (size == 0 || size > g_part[1 - g_running].size) { err_ = "Not Enough Space"; return false; }
  size_ = size;
  buf_.clear();
  running_ = true;
  err_ = "No Error";
  return true;
}

size_t UpdateClass::write(uint8_t* data, size_t len) {
  if (!running_) return 0;
  if (buf_.size() + len > size_) { err_ = "Flash Write Failed"; running_ = false; return 0; }
  buf_.insert(buf_.end(), data, data + len);
  return len;
}

bool UpdateClass::end(bool) {
  if (!running_) return false;
  running_ = false;
  if (buf_.size() != size_) { err_ = "Not Finished"; return false; }
  if (!md5_.empty()) {
    uint8_t d[16];
#if MBEDTLS_VERSION_MAJOR >= 3
    mbedtls_md5(buf_.data(), buf_.size(), d);
#else
    mbedtls_md5_ret(buf_.data(), buf_.size(), d);
#endif
    char hex[33];
    for (int i = 0; i < 16; i++) snprintf(hex + 2 * i, 3, "%02x", d[i]);
    std::string want = md5_;
    for (auto& c : want) c = (char)tolower(c);
    if (want != hex) { err_ = "MD5 Check Failed"; return false; }
  }
  if (buf_.empty() || buf_[0] != 0xE9) { err_ = "Magic byte is wrong, not 0xE9"; return false; }
  int next = 1 - g_running;
  g_slot[next].img = buf_;
  g_slot[next].state = ESP_OTA_IMG_NEW;
  g_boot = next;
  sim_save_flash();
  return true;
}

void ArduinoOTAClass::handle() {
  if (!on_ || g_push_file.empty()) return;
  std::string data, pass = g_push_pass;
  bool ok = readFile(g_push_file, data);
  g_push_file.clear();
  if (pass != pass_) { if (err_) err_(OTA_AUTH_ERROR); return; }
  if (!ok || !Update.begin(data.size())) { if (err_) err_(OTA_BEGIN_ERROR); return; }
  if (start_) start_();
  if (prog_) prog_(0, (unsigned)data.size());
  for (size_t off = 0; off < data.size(); off += 1460) {
    size_t n = std::min<size_t>(1460, data.size() - off);
    Update.write((uint8_t*)data.data() + off, n);
    if (prog_) prog_((unsigned)(off + n), (unsigned)data.size());
  }
  if (!Update.end()) { if (err_) err_(OTA_END_ERROR); return; }
  if (end_) end_();
  sim_restart("ArduinoOTA selesai");
}

bool HTTPClient::begin(WiFiClient& c, String url) {
  cli_ = &c;
  url_ = url.c_str();
  return url_.rfind("http://", 0) == 0 || url_.rfind("https://", 0) == 0;
}

int HTTPClient::GET() {
  bool https = url_.rfind("https://", 0) == 0;
  if (https) {
    WiFiClientSecure* s = dynamic_cast<WiFiClientSecure*>(cli_);
    if (!s || !s->ca_ || (!g_tls_needle.empty() && !strstr(s->ca_, g_tls_needle.c_str()))) {
      printf("HTTP TLS-GAGAL %s\n", url_.c_str());
      return -1;
    }
  }
  size_t p = url_.find("://");
  size_t slash = url_.find('/', p + 3);
  std::string path = slash == std::string::npos ? "/" : url_.substr(slash);
  std::string data;
  printf("HTTP GET %s\n", url_.c_str());
  if (!readFile(g_server + path, data)) { cli_->data = ""; cli_->pos = 0; size_ = 0; return 404; }
  cli_->data = data;
  cli_->pos = 0;
  size_ = (int)data.size();
  return 200;
}

String HTTPClient::getString() {
  std::string rest = cli_->data.substr(cli_->pos);
  cli_->pos = cli_->data.size();
  return String(rest);
}

static std::string nvsPath(const std::string& ns, const char* key) { return g_state + "/nvs_" + ns + "_" + key + ".bin"; }
size_t Preferences::putBytes(const char* key, const void* v, size_t n) {
  writeFile(nvsPath(ns_, key), std::string((const char*)v, n));
  return n;
}
size_t Preferences::getBytesLength(const char* key) {
  std::string d;
  return readFile(nvsPath(ns_, key), d) ? d.size() : 0;
}
size_t Preferences::getBytes(const char* key, void* buf, size_t n) {
  std::string d;
  if (!readFile(nvsPath(ns_, key), d)) return 0;
  size_t k = std::min(n, d.size());
  memcpy(buf, d.data(), k);
  return k;
}

// ------------------------------------------------------------------
//  Sketch asli
// ------------------------------------------------------------------
#include SKETCH_PATH

static std::vector<int> ints(std::istringstream& is) {
  std::vector<int> v;
  int x;
  while (is >> x) v.push_back(x);
  return v;
}

int main() {
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (getenv("SIM_STATE")) g_state = getenv("SIM_STATE");
  if (getenv("SIM_SERVER")) g_server = getenv("SIM_SERVER");
  if (getenv("SIM_TLS_NEEDLE")) g_tls_needle = getenv("SIM_TLS_NEEDLE");
  if (getenv("SIM_STA")) g_sta_available = atoi(getenv("SIM_STA")) != 0;
  loadFlash();
  g_running = getenv("SIM_RUNNING") ? atoi(getenv("SIM_RUNNING")) : g_boot;

  char buf[1024];
  while (fgets(buf, sizeof(buf), stdin)) {
    size_t n = strlen(buf);
    while (n && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) buf[--n] = '\0';
    std::string line(buf);
    std::string cmd = line.substr(0, line.find(' '));
    std::string arg = line.find(' ') == std::string::npos ? "" : line.substr(line.find(' ') + 1);

    if (cmd == "INIT") {
      // initArduino(): tanpa verifyRollbackLater, firmware baru langsung ditandai sah
      if (!verifyRollbackLater() && g_slot[g_running].state == ESP_OTA_IMG_PENDING_VERIFY) {
        g_slot[g_running].state = ESP_OTA_IMG_VALID;
        sim_save_flash();
      }
      setup();
    } else if (cmd == "T") {
      long ms = atol(arg.c_str());
      for (long t = 0; t < ms; t += 5) { loop(); sim_advance(5); }
    } else if (cmd == "WSC") {
      g_ws_queue.push_back({WStype_CONNECTED, ""});
    } else if (cmd == "WSD") {
      g_ws_queue.push_back({WStype_DISCONNECTED, ""});
    } else if (cmd == "WS") {
      g_ws_queue.push_back({WStype_TEXT, arg});
    } else if (cmd == "SER") {
      for (char c : arg) Serial.in.push_back(c);
    } else if (cmd == "PUSH") {
      std::istringstream is(arg);
      is >> g_push_file >> g_push_pass;
    } else if (cmd == "HEAP") {
      g_free_heap = (uint32_t)atol(arg.c_str());
    } else if (cmd == "UNO") {
      std::istringstream is(arg);
      std::string k;
      is >> k;
      if (k == "mode") { std::string m; is >> m; uno.mode = m[0]; }
      else if (k == "sp") is >> uno.sp;
      else if (k == "pump") is >> uno.pump;
      else if (k == "fl") uno.fl = ints(is);
      else if (k == "gs") uno.gs = ints(is);
      else if (k == "fe") uno.fe = ints(is);
      else if (k == "ge") uno.ge = ints(is);
      else if (k == "gw") is >> uno.gw;
      else if (k == "noerr") uno.sendErr = false;
      else if (k == "off") uno.on = false;
      else if (k == "on") uno.on = true;
      else if (k == "fw") is >> uno.fw;
      else if (k == "robot") is >> uno.robot;
      else if (k == "nocfg") uno.cfg = false;
    }
    fflush(stdout);
    printf("DONE\n");
  }
  return 0;
}
