/*
  ESP32-CAM — streaming kamera untuk dashboard FireGuard / EcoBot
  ------------------------------------------------------------------
  Sketch yang sama dipakai di dua robot. Bedanya cuma CAM_HOSTNAME di bawah.
  Khusus modul ESP32-CAM AI-Thinker (yang paling umum).

  Endpoint (semua GET, semua mengirim header CORS supaya bisa dipanggil dari dashboard):
    http://<alamat>:81/stream   MJPEG langsung (dipakai dashboard)
    http://<alamat>/status      JSON: fps, jumlah frame, resolusi, sinyal WiFi, memori
    http://<alamat>/capture     satu foto JPEG
    http://<alamat>/led?on=1    lampu flash (GPIO 4) on/off
    http://<alamat>/res?size=qvga|vga|svga   ganti resolusi

  Catatan:
    - Hanya satu penonton stream dalam satu waktu (keterbatasan ESP32). Tutup tab lain dulu.
    - ESP32-CAM sangat rewel soal daya. Beri 5 V yang stabil (minimal 500 mA, lebih baik 1 A)
      dan kapasitor 470 uF dekat pin 5V. Kalau sering restart sendiri ("Brownout detector"),
      hampir pasti penyebabnya daya, bukan kode.
    - Board: "AI Thinker ESP32-CAM". Untuk upload: sambungkan GPIO0 ke GND, tekan reset, upload,
      lalu lepas GPIO0 dan reset lagi.
*/

#include "esp_camera.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include "esp_http_server.h"

// ==================================================================
//  KONFIGURASI
// ==================================================================
#define CAM_HOSTNAME "fireguard-cam"     // "fireguard-cam" atau "ecobot-cam" -> http://fireguard-cam.local

// Daftar WiFi yang dicoba bergantian. Isi WiFi utama, dan (opsional) WiFi milik ESP bridge
// robot (mode AP: "<nama robot>-robot"), supaya kamera tetap tersambung walau WiFi utama hilang.
struct Net { const char* ssid; const char* pass; };
static const Net NETWORKS[] = {
  { "NAMA_WIFI",        "PASSWORD_WIFI" },
  { "fireguard-robot",  "kopak1234"     },
};
#define WIFI_TRY_MS 15000UL

#define CAM_VFLIP    0      // 1 kalau gambar terbalik (kamera dipasang terbalik)
#define CAM_HMIRROR  0      // 1 kalau gambar seperti cermin

// ---- pin AI-Thinker ESP32-CAM ----
#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22
#define LED_GPIO_NUM     4

// ==================================================================

static httpd_handle_t ctrlHttpd = NULL;
static httpd_handle_t streamHttpd = NULL;

static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=kopakframe";
static const char* STREAM_BOUNDARY = "\r\n--kopakframe\r\n";
static const char* STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static volatile unsigned long frameCount = 0;
static float fps = 0;
static unsigned long fpsT0 = 0, fpsFrames0 = 0;
static const char* curSize = "vga";
static int ledState = 0;
static bool hasPsram = false;

static void corsHeaders(httpd_req_t* req) {
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
}

static bool queryValue(httpd_req_t* req, const char* key, char* out, size_t outLen) {
  size_t qlen = httpd_req_get_url_query_len(req);
  if (qlen == 0 || qlen > 63) return false;
  char q[64];
  if (httpd_req_get_url_query_str(req, q, sizeof(q)) != ESP_OK) return false;
  return httpd_query_key_value(q, key, out, outLen) == ESP_OK;
}

// ---------------- /stream ----------------
static esp_err_t streamHandler(httpd_req_t* req) {
  esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  corsHeaders(req);

  char part[64];
  while (true) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) { res = ESP_FAIL; break; }

    res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
    if (res == ESP_OK) {
      size_t hlen = snprintf(part, sizeof(part), STREAM_PART, (unsigned)fb->len);
      res = httpd_resp_send_chunk(req, part, hlen);
    }
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb);

    if (res != ESP_OK) break;          // klien menutup koneksi
    frameCount++;
  }
  return res;
}

// ---------------- /capture ----------------
static esp_err_t captureHandler(httpd_req_t* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  corsHeaders(req);
  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

// ---------------- /status ----------------
static esp_err_t statusHandler(httpd_req_t* req) {
  char json[256];
  snprintf(json, sizeof(json),
           "{\"fps\":%.1f,\"frames\":%lu,\"size\":\"%s\",\"rssi\":%d,\"heap\":%u,\"psram\":%s,\"led\":%d,\"up\":%lu}",
           fps, (unsigned long)frameCount, curSize, (int)WiFi.RSSI(), (unsigned)ESP.getFreeHeap(),
           hasPsram ? "true" : "false", ledState, millis() / 1000UL);
  httpd_resp_set_type(req, "application/json");
  corsHeaders(req);
  return httpd_resp_send(req, json, strlen(json));
}

// ---------------- /led?on=1 ----------------
static esp_err_t ledHandler(httpd_req_t* req) {
  char v[8];
  if (queryValue(req, "on", v, sizeof(v))) {
    ledState = (v[0] == '1') ? 1 : 0;
    digitalWrite(LED_GPIO_NUM, ledState ? HIGH : LOW);
  }
  corsHeaders(req);
  return httpd_resp_send(req, ledState ? "on" : "off", HTTPD_RESP_USE_STRLEN);
}

// ---------------- /res?size=qvga|vga|svga ----------------
static esp_err_t resHandler(httpd_req_t* req) {
  char v[8];
  corsHeaders(req);
  if (!queryValue(req, "size", v, sizeof(v))) return httpd_resp_send(req, "size?", HTTPD_RESP_USE_STRLEN);
  sensor_t* s = esp_camera_sensor_get();
  if (!s) return httpd_resp_send(req, "no sensor", HTTPD_RESP_USE_STRLEN);
  if (!strcmp(v, "qvga"))      { s->set_framesize(s, FRAMESIZE_QVGA); curSize = "qvga"; }
  else if (!strcmp(v, "vga"))  { s->set_framesize(s, FRAMESIZE_VGA);  curSize = "vga"; }
  else if (!strcmp(v, "svga")) { s->set_framesize(s, FRAMESIZE_SVGA); curSize = "svga"; }
  else return httpd_resp_send(req, "size?", HTTPD_RESP_USE_STRLEN);
  return httpd_resp_send(req, curSize, HTTPD_RESP_USE_STRLEN);
}

// ---------------- / ----------------
static esp_err_t rootHandler(httpd_req_t* req) {
  static const char page[] =
    "<!doctype html><meta charset=utf-8><title>" CAM_HOSTNAME "</title>"
    "<body style=\"font-family:sans-serif;background:#14171a;color:#eee;padding:24px\">"
    "<h2>" CAM_HOSTNAME "</h2>"
    "<p>Kamera aktif. Pakai dashboard untuk melihat tampilan langsung.</p>"
    "<ul><li><a style=color:#6cf href=/status>/status</a></li>"
    "<li><a style=color:#6cf href=/capture>/capture</a></li>"
    "<li>stream: port 81, path /stream</li></ul></body>";
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, page, HTTPD_RESP_USE_STRLEN);
}

static void addUri(httpd_handle_t h, const char* uri, esp_err_t (*fn)(httpd_req_t*)) {
  httpd_uri_t u;
  memset(&u, 0, sizeof(u));
  u.uri = uri;
  u.method = HTTP_GET;
  u.handler = fn;
  u.user_ctx = NULL;
  httpd_register_uri_handler(h, &u);
}

static void startServers() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.max_uri_handlers = 8;
  if (httpd_start(&ctrlHttpd, &config) == ESP_OK) {
    addUri(ctrlHttpd, "/", rootHandler);
    addUri(ctrlHttpd, "/status", statusHandler);
    addUri(ctrlHttpd, "/capture", captureHandler);
    addUri(ctrlHttpd, "/led", ledHandler);
    addUri(ctrlHttpd, "/res", resHandler);
  }
  // stream dijalankan di server terpisah (port 81) supaya tidak menghalangi endpoint lain
  config.server_port = 81;
  config.ctrl_port += 1;
  if (httpd_start(&streamHttpd, &config) == ESP_OK) {
    addUri(streamHttpd, "/stream", streamHandler);
  }
}

// ---------------- kamera ----------------
static bool initCamera() {
  camera_config_t c;
  memset(&c, 0, sizeof(c));
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;

  hasPsram = psramFound();
  if (hasPsram) {
    c.frame_size = FRAMESIZE_VGA;
    c.jpeg_quality = 12;
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
    c.grab_mode = CAMERA_GRAB_LATEST;      // selalu ambil frame terbaru, jangan menumpuk antrean
  } else {
    c.frame_size = FRAMESIZE_QVGA;
    c.jpeg_quality = 15;
    c.fb_count = 1;
    c.fb_location = CAMERA_FB_IN_DRAM;
    curSize = "qvga";
  }

  if (esp_camera_init(&c) != ESP_OK) return false;

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    s->set_vflip(s, CAM_VFLIP);
    s->set_hmirror(s, CAM_HMIRROR);
  }
  return true;
}

// ---------------- WiFi ----------------
static bool connectWifi() {
  const size_t count = sizeof(NETWORKS) / sizeof(NETWORKS[0]);
  for (size_t i = 0; i < count; i++) {
    Serial.printf("WiFi: mencoba \"%s\"", NETWORKS[i].ssid);
    WiFi.disconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(CAM_HOSTNAME);
    WiFi.begin(NETWORKS[i].ssid, NETWORKS[i].pass);
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TRY_MS) {
      delay(250);
      Serial.print('.');
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      WiFi.setSleep(false);                // lebih stabil untuk streaming
      Serial.printf("Tersambung ke \"%s\", IP: %s\n", NETWORKS[i].ssid, WiFi.localIP().toString().c_str());
      return true;
    }
  }
  return false;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_GPIO_NUM, OUTPUT);
  digitalWrite(LED_GPIO_NUM, LOW);

  if (!initCamera()) {
    Serial.println("Kamera gagal dinyalakan. Cek kabel/modul kamera dan daya. Restart dalam 5 detik.");
    delay(5000);
    ESP.restart();
  }

  while (!connectWifi()) {
    Serial.println("Belum ada WiFi yang bisa dipakai, coba lagi…");
  }

  if (MDNS.begin(CAM_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.printf("mDNS: http://%s.local\n", CAM_HOSTNAME);
  }

  startServers();
  fpsT0 = millis();
  Serial.printf("Siap. Stream: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
}

void loop() {
  // hitung FPS tiap detik dari jumlah frame yang terkirim
  unsigned long now = millis();
  if (now - fpsT0 >= 1000) {
    unsigned long f = frameCount;
    fps = (float)(f - fpsFrames0) * 1000.0f / (float)(now - fpsT0);
    fpsFrames0 = f;
    fpsT0 = now;
  }

  // WiFi putus: coba sambung ulang (streaming berhenti selama itu)
  static unsigned long lostAt = 0;
  if (WiFi.status() != WL_CONNECTED) {
    if (!lostAt) lostAt = now;
    if (now - lostAt > 20000UL) { connectWifi(); lostAt = 0; }
  } else {
    lostAt = 0;
  }
  delay(50);
}
