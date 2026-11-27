// ota_esp32.h — update firmware lewat WiFi untuk ESP32 (dipanggil dari esp_bridge.ino).
// ------------------------------------------------------------------
//  Push OTA  : Arduino IDE mengirim firmware lewat port jaringan (butuh OTA_PASSWORD).
//  Pull OTA  : ESP membaca manifest di SERVER_BASE. Kalau ada versi baru, dashboard menampilkan
//              "Update tersedia" dan firmware baru dipasang setelah tombol Pasang ditekan
//              (atau ketik u di Serial Monitor). Robot harus diam dulu.
//  Safe OTA  : firmware baru masuk masa percobaan. Ia baru dianggap VALID setelah lolos health
//              check (WiFi, memori, Uno menjawab, sensor terbaca, motor diam). Kalau gagal, crash
//              berulang, atau macet, ESP kembali ke firmware lama yang masih tersimpan di slot
//              sebelah, tanpa perlu server. Versi yang gagal dicatat supaya tidak dipasang lagi.
//
// File ini memakai fungsi bridge yang ditulis di esp_bridge.ino sebelum #include-nya:
//   forwardToUno(), sendToClient(), broadcastLine(), bridgeService(), robot (ota::RobotSnap), apMode
#pragma once

#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Update.h>
#include <Preferences.h>
#include <time.h>
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_timer.h"
#include "esp_attr.h"
#include "esp_system.h"
#include "ota_core.h"
#include "ota_crypto.h"
#include "root_ca.h"
#include "ota_pubkey.h"

#define OTA_MANIFEST_URL SERVER_BASE "/" GROUP_ID "/manifest-" FW_PRODUCT ".json"

#if ROLLBACK_BOOTLOADER
// Core Arduino biasanya langsung menandai firmware baru "sah" saat menyala. Dengan fungsi ini
// keputusan itu ditunda sampai health check selesai, jadi bootloader ESP-IDF ikut menjaga: kalau
// firmware baru crash sebelum dinyatakan sehat, boot berikutnya kembali ke versi lama.
extern "C" bool verifyRollbackLater() { return true; }
#endif

// ==================================================================
//  Status
// ==================================================================
static Preferences otaPrefs;
static ota::OtaState otaSt;
static bool otaTrial = false;           // firmware ini sedang masa percobaan
static bool otaTrialDone = false;
static uint32_t otaTrialStart = 0, otaHealthyFrom = 0, otaLastTrialNote = 0, otaLastInfoAsk = 0;
static bool otaBusy = false;            // sedang menerima / menulis firmware
static bool otaPushOn = false;
static bool otaNeedStable = false;      // rollback lokal gagal: coba pasang versi stable dari server
static uint32_t otaLastStableTry = 0;
static char otaBadVer[16] = "";

static ota::FwEntry otaAvail;           // update yang ditemukan dan menunggu persetujuan
static bool otaHaveAvail = false;
static uint32_t otaLastCheck = 0;
static bool otaCheckedOnce = false;
static bool otaInstallReq = false;
static bool otaCheckReq = false;
static uint32_t otaLastMotion = 0;      // perintah gerak terakhir dari dashboard
static uint32_t otaLastLockNote = 0;
static int otaPushPct = -1;

static char otaStatusSt[14] = "idle";
static char otaStatusVer[16] = "";
static char otaStatusMsg[200] = "";
static int otaStatusPct = -1;

static WiFiClient otaPlain;
static WiFiClientSecure otaSecure;
static bool otaClockStarted = false;

// ==================================================================
//  Watchdog loop()
// ==================================================================
// Kalau loop() berhenti berputar lebih lama dari LOOP_WDT_MS (program macet), ESP di-restart.
// Saat masa percobaan, restart itu ikut dihitung sebagai percobaan gagal.
static volatile uint32_t otaBeatMs = 0;
static volatile uint32_t otaWdtLimit = LOOP_WDT_MS;
static esp_timer_handle_t otaWdt = nullptr;
static RTC_NOINIT_ATTR uint32_t otaWdtMark;
static const uint32_t OTA_WDT_MAGIC = 0x57445431;  // "WDT1"

static inline void otaBeat() { otaBeatMs = millis(); }

// Panggilan jaringan (sambung + jabat tangan HTTPS) bisa diam belasan detik tanpa kembali ke
// loop(). Selama itu batas watchdog dilonggarkan supaya ESP tidak di-restart tanpa alasan.
struct OtaNetWait {
  OtaNetWait() { otaBeat(); otaWdtLimit = 60000UL; }
  ~OtaNetWait() { otaBeat(); otaWdtLimit = LOOP_WDT_MS; }
};

static void otaWdtCheck(void*) {
  if ((uint32_t)(millis() - otaBeatMs) > otaWdtLimit) {
    otaWdtMark = OTA_WDT_MAGIC;
    esp_restart();
  }
}

static void otaWdtStart() {
  otaBeat();
  esp_timer_create_args_t a = {};
  a.callback = &otaWdtCheck;
  a.name = "loopwdt";
  if (esp_timer_create(&a, &otaWdt) == ESP_OK) esp_timer_start_periodic(otaWdt, 1000000ULL);
}

// ==================================================================
//  Penyimpanan (NVS, tetap ada walau listrik mati atau firmware diganti)
// ==================================================================
static void otaSave() {
  otaSt.magic = ota::OTA_STATE_MAGIC;
  otaPrefs.begin("ota", false);
  otaPrefs.putBytes("st", &otaSt, sizeof(otaSt));
  otaPrefs.end();
}

static void otaLoad() {
  otaSt = ota::OtaState();
  otaPrefs.begin("ota", false);
  size_t n = otaPrefs.getBytesLength("st");
  if (n == sizeof(otaSt)) otaPrefs.getBytes("st", &otaSt, sizeof(otaSt));
  otaPrefs.end();
  if (otaSt.magic != ota::OTA_STATE_MAGIC) {     // pertama kali, atau sisa sketch lain
    otaSt = ota::OtaState();
    ota::copyStr(otaSt.good, sizeof(otaSt.good), FW_VERSION);
    otaSave();
  }
}

static void otaPrintState() {
  LOG("[State] versi v%s | pending='%s' attempts=%u blacklisted='%s' lastGood='%s'\n",
      FW_VERSION, otaSt.pending, (unsigned)otaSt.attempts, otaSt.black, otaSt.good);
  if (otaSt.lastSt[0]) LOG("[State] terakhir: %s v%s - %s\n", otaSt.lastSt, otaSt.lastVer, otaSt.lastMsg);
}

static void otaRemember(const char* st, const char* ver, const char* msg) {
  ota::copyStr(otaSt.lastSt, sizeof(otaSt.lastSt), st);
  ota::copyStr(otaSt.lastVer, sizeof(otaSt.lastVer), ver);
  ota::copyStr(otaSt.lastMsg, sizeof(otaSt.lastMsg), msg);
}

// ==================================================================
//  Kabar ke dashboard
// ==================================================================
static void otaStatusJson(char* out, size_t n) {
  JsonDocument d;
  d["t"] = "ota";
  d["st"] = otaStatusSt;
  d["cur"] = FW_VERSION;
  if (otaStatusVer[0]) d["ver"] = otaStatusVer;
  if (otaStatusPct >= 0) d["pct"] = otaStatusPct;
  if (otaStatusMsg[0]) d["msg"] = otaStatusMsg;
  if (otaHaveAvail && otaAvail.notes[0]) d["notes"] = otaAvail.notes;
  serializeJson(d, out, n);
}

static void otaSendStatus(Source src, uint8_t num) {
  char out[420];
  otaStatusJson(out, sizeof(out));
  sendToClient(src, num, out);
}

static void otaSetStatus(const char* st, const char* ver, int pct, const char* msg) {
  ota::copyStr(otaStatusSt, sizeof(otaStatusSt), st);
  ota::copyStr(otaStatusVer, sizeof(otaStatusVer), ver ? ver : "");
  ota::copyStr(otaStatusMsg, sizeof(otaStatusMsg), msg ? msg : "");
  otaStatusPct = pct;
  char out[420];
  otaStatusJson(out, sizeof(out));
  broadcastLine(out);
}

static bool otaKeyOn() { return ota::keyConfigured(OTA_PUBKEY_PEM); }

static const char* otaRollbackKind() {
#if ROLLBACK_BOOTLOADER
  return "boot";
#else
  return "app";
#endif
}

static void otaFillInfo(JsonObject o) {
  o["push"] = otaPushOn ? 1 : 0;
  o["pull"] = strlen(SERVER_BASE) ? 1 : 0;
  o["sig"] = otaKeyOn() ? 1 : 0;
  o["rb"] = otaRollbackKind();
  o["st"] = otaStatusSt;
  if (otaSt.good[0]) o["good"] = otaSt.good;
  if (otaSt.black[0]) o["black"] = otaSt.black;
  if (otaSt.lastSt[0]) {
    o["last"] = otaSt.lastSt;
    o["lastVer"] = otaSt.lastVer;
    o["lastMsg"] = otaSt.lastMsg;
  }
  o["host"] = NET_HOSTNAME;
  o["group"] = GROUP_ID;
}

// ==================================================================
//  Partisi
// ==================================================================
// Sidik jari image di sebuah slot (16 hex pertama SHA-256 yang dihitung ESP-IDF). Dipakai untuk
// mengenali "apakah yang sedang berjalan ini image yang baru dipasang lewat OTA?".
static void otaPartHash(const esp_partition_t* p, char out[17]) {
  uint8_t h[32];
  out[0] = '\0';
  if (p && esp_partition_get_sha256(p, h) == ESP_OK) ota::hexEncode(h, 8, out);
}

static void otaMarkValidIfPending() {
  const esp_partition_t* run = esp_ota_get_running_partition();
  esp_ota_img_states_t s;
  if (run && esp_ota_get_state_partition(run, &s) == ESP_OK && s == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_valid_cancel_rollback();
  }
}

// Kembali ke firmware lama. Urutan: (1) cara resmi ESP-IDF, (2) pilih slot lama langsung,
// (3) kalau dua-duanya tidak bisa (slot lama kosong), unduh versi "stable" dari server.
static void otaRollback(const char* badVer, const char* reason) {
  LOG("[SafeOTA] ROLLBACK v%s: %s\n", badVer, reason);
  forwardToUno("STOP");
  ota::copyStr(otaSt.black, sizeof(otaSt.black), badVer);
  otaSt.pending[0] = '\0';
  otaSt.attempts = 0;
  char msg[120];
  snprintf(msg, sizeof(msg), "v%s dibatalkan: %s", badVer, reason);
  otaRemember("rolled_back", badVer, msg);
  otaSave();
  otaSetStatus("rolling_back", badVer, -1, msg);
  delay(200);

  esp_err_t e = esp_ota_mark_app_invalid_rollback_and_reboot();     // kalau berhasil, tidak kembali ke sini
  LOG("[SafeOTA] Rollback lewat otadata tidak bisa (%s). Coba slot lama langsung.\n", esp_err_to_name(e));
  const esp_partition_t* other = esp_ota_get_next_update_partition(NULL);
  if (other && esp_ota_set_boot_partition(other) == ESP_OK) {
    LOG("[SafeOTA] Boot berikutnya dari slot %s. Restart...\n", other->label);
    delay(200);
    ESP.restart();
  }
  LOG("[SafeOTA] Slot lama tidak berisi firmware yang sah. Rollback lewat server (versi stable).\n");
  ota::copyStr(otaBadVer, sizeof(otaBadVer), badVer);
  otaNeedStable = true;
  snprintf(msg, sizeof(msg), "v%s gagal dan slot lama kosong. Mencoba memasang versi stable dari server.", badVer);
  otaRemember("error", badVer, msg);
  otaSave();
}

// Dipanggil paling awal di setup(), sebelum kode yang mungkin crash.
static void otaEarlyBoot() {
  if (otaWdtMark == OTA_WDT_MAGIC) {
    otaWdtMark = 0;
    LOG("[WDT] Boot ini terjadi karena loop() macet lebih dari %lu ms, ESP di-restart watchdog.\n", (unsigned long)LOOP_WDT_MS);
  }
  otaLoad();
  if (otaSt.pending[0]) {
    char runHash[17];
    otaPartHash(esp_ota_get_running_partition(), runHash);
    char pend[16];
    ota::copyStr(pend, sizeof(pend), otaSt.pending);
    ota::BootAction a = ota::decideBoot(otaSt, FW_VERSION, runHash, MAX_TRIAL_BOOTS);
    otaSave();
    char why[110];
    switch (a) {
      case ota::BOOT_TRIAL:
        otaTrial = true;
        LOG("[SafeOTA] TRIAL BOOT v%s, percobaan %u/%u\n", FW_VERSION, (unsigned)otaSt.attempts, (unsigned)MAX_TRIAL_BOOTS);
        break;
      case ota::BOOT_TOO_MANY:
        snprintf(why, sizeof(why), "crash/reboot %u kali saat masa percobaan", (unsigned)(otaSt.attempts - 1));
        otaRollback(FW_VERSION, why);
        break;
      case ota::BOOT_MISMATCH:
        snprintf(why, sizeof(why), "isi biner melapor v%s, padahal yang dipasang v%s (lupa menaikkan FW_VERSION?)", FW_VERSION, pend);
        otaRollback(pend, why);
        break;
      case ota::BOOT_ROLLED_BACK:
        LOG("[SafeOTA] %s\n", otaSt.lastMsg);
        break;
      case ota::BOOT_STALE:
        LOG("[SafeOTA] Firmware dipasang lewat USB. Status percobaan v%s dibuang.\n", pend);
        break;
      default:
        break;
    }
  }
  if (!otaTrial) otaMarkValidIfPending();
  otaPrintState();
  otaWdtStart();

#if FAULT_MODE == 2
  if (otaTrial) {
    LOG("[FAULT] Injeksi: crash (tulis ke pointer null)\n");
    delay(100);
    volatile int* p = nullptr;
    *p = 42;
  }
#endif
}

// Firmware lolos health check
static void otaConfirm() {
  otaTrial = false;
  otaTrialDone = true;
  esp_ota_mark_app_valid_cancel_rollback();
  ota::copyStr(otaSt.good, sizeof(otaSt.good), FW_VERSION);
  otaSt.pending[0] = '\0';
  otaSt.attempts = 0;
  char msg[120];
  snprintf(msg, sizeof(msg), "v%s lolos health check dan dinyatakan VALID", FW_VERSION);
  otaRemember("valid", FW_VERSION, msg);
  otaSave();
  LOG("[Health] LULUS\n[SafeOTA] v%s dikonfirmasi VALID\n", FW_VERSION);
  otaSetStatus("valid", FW_VERSION, -1, msg);
}

// Catat bahwa slot sebelah sekarang berisi firmware baru yang harus lolos masa percobaan.
static void otaMarkPending(const char* ver, const char* src) {
  otaPartHash(esp_ota_get_boot_partition(), otaSt.pendHash);
  otaPartHash(esp_ota_get_running_partition(), otaSt.prevHash);
  ota::copyStr(otaSt.pending, sizeof(otaSt.pending), ver);
  ota::copyStr(otaSt.prevVer, sizeof(otaSt.prevVer), FW_VERSION);
  ota::copyStr(otaSt.src, sizeof(otaSt.src), src);
  otaSt.attempts = 0;
  char msg[120];
  snprintf(msg, sizeof(msg), "v%s terpasang lewat %s, menunggu health check", ver, src);
  otaRemember("installed", ver, msg);
  otaSave();
}

// ==================================================================
//  Push OTA
// ==================================================================
static bool otaScanPartition(const esp_partition_t* p, ota::MarkerScanner& mk) {
  uint8_t buf[512];
  mk.reset();
  for (uint32_t off = 0; p && off < p->size && !mk.found(); off += sizeof(buf)) {
    if (esp_partition_read(p, off, buf, sizeof(buf)) != ESP_OK) return false;
    mk.feed(buf, sizeof(buf));
    if ((off & 0xFFFF) == 0) otaBeat();
  }
  return mk.found();
}

static void otaAfterPush() {
  const esp_partition_t* boot = esp_ota_get_boot_partition();
  const esp_partition_t* run = esp_ota_get_running_partition();
  ota::MarkerScanner mk;
  char msg[120];
  if (!otaScanPartition(boot, mk)) {
    // sketch lain (mis. contoh dari modul): tidak punya health check, jadi tidak ada masa percobaan
    otaSt.pending[0] = '\0';
    otaRemember("installed", "?", "firmware tanpa penanda FWID diupload lewat Push OTA (bukan firmware bridge)");
    otaSave();
    LOG("\n[OTA] Firmware yang diupload bukan firmware bridge. Tidak ada masa percobaan.\n");
    return;
  }
  if (strcmp(mk.product(), FW_PRODUCT) != 0) {
    // salah pilih sketch (mis. firmware kamera atau robot lain): batalkan, tetap pakai yang lama
    if (run) esp_ota_set_boot_partition(run);
    snprintf(msg, sizeof(msg), "upload '%s' v%s dibatalkan: robot ini butuh '%s'", mk.product(), mk.version(), FW_PRODUCT);
    otaRemember("error", mk.version(), msg);
    otaSave();
    LOG("\n[OTA] %s\n", msg);
    otaSetStatus("error", mk.version(), -1, msg);
    return;
  }
  otaMarkPending(mk.version(), "push");
  LOG("\n[OTA] v%s diterima lewat Push OTA. Restart ke masa percobaan...\n", mk.version());
  otaSetStatus("rebooting", mk.version(), 100, "Firmware baru diterima. Robot restart lalu memeriksa dirinya sendiri.");
}

static void otaSetupPush() {
  if (strlen(OTA_PASSWORD) == 0) {
    LOG("[OTA] Push OTA mati: isi OTA_PASSWORD di secrets.h untuk upload lewat WiFi.\n");
    return;
  }
  ArduinoOTA.setHostname(NET_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() {
    otaBusy = true;
    otaPushPct = -1;
    forwardToUno("STOP");                                   // safe state: semua motor dan pompa mati
    LOG("[OTA] Mulai menerima firmware lewat WiFi. Robot dihentikan.\n");
    otaSetStatus("push", "", 0, "Menerima firmware dari Arduino IDE. Robot dihentikan.");
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    otaBeat();
    int pct = total ? (int)((progress * 100ULL) / total) : 0;
    if (pct >= otaPushPct + 10) {
      otaPushPct = pct;
      LOG("[OTA] Progres: %d%%\n", pct);
      otaSetStatus("push", "", pct, "Menerima firmware dari Arduino IDE...");
    }
  });
  ArduinoOTA.onEnd([]() { otaAfterPush(); });
  ArduinoOTA.onError([](ota_error_t error) {
    otaBusy = false;
    const char* why = "tidak dikenal";
    switch (error) {
      case OTA_AUTH_ERROR:    why = "password OTA salah"; break;
      case OTA_BEGIN_ERROR:   why = "ruang flash tidak cukup / Partition Scheme tanpa OTA"; break;
      case OTA_CONNECT_ERROR: why = "gagal tersambung balik ke laptop (cek firewall)"; break;
      case OTA_RECEIVE_ERROR: why = "data terputus di tengah transfer"; break;
      case OTA_END_ERROR:     why = "verifikasi akhir gagal"; break;
      default: break;
    }
    char msg[120];
    snprintf(msg, sizeof(msg), "Push OTA gagal (Error[%u]): %s. Firmware lama tetap dipakai.", (unsigned)error, why);
    LOG("[OTA] %s\n", msg);
    otaSetStatus("error", "", -1, msg);
  });
  ArduinoOTA.begin();                                       // ikut menyalakan mDNS dengan nama NET_HOSTNAME
  otaPushOn = true;
  LOG("[OTA] Push OTA siap. Di Arduino IDE pilih port jaringan \"%s\" (%s).\n", NET_HOSTNAME,
      (apMode ? WiFi.softAPIP() : WiFi.localIP()).toString().c_str());
}

// ==================================================================
//  Pull OTA: manifest dan unduhan
// ==================================================================
static bool otaHttps(const char* url) { return strncmp(url, "https://", 8) == 0; }

static bool otaPullAvailable(char* err, size_t n) {
  if (!strlen(SERVER_BASE)) { snprintf(err, n, "Pull OTA mati: SERVER_BASE belum diisi di secrets.h."); return false; }
  if (apMode || WiFi.status() != WL_CONNECTED) {
    snprintf(err, n, "Robot sedang membuat WiFi sendiri (mode AP), jadi tidak bisa menjangkau server. Sambungkan robot ke WiFi yang punya akses ke server.");
    return false;
  }
  return true;
}

// HTTPS butuh jam yang benar (masa berlaku sertifikat)
static bool otaClockReady(char* err, size_t n) {
  if (!otaClockStarted) {
    configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
    otaClockStarted = true;
  }
  uint32_t t0 = millis();
  while (time(nullptr) < 1700000000 && millis() - t0 < 10000) {
    otaBeat();
    bridgeService();
    delay(50);
  }
  if (time(nullptr) < 1700000000) {
    snprintf(err, n, "Jam belum tersinkron (NTP gagal). WiFi ini mungkin tanpa internet, jadi HTTPS ditolak.");
    return false;
  }
  return true;
}

static WiFiClient& otaClientFor(const char* url) {
  if (otaHttps(url)) {
    otaSecure.setCACert(UJI_ROOT_CA_SALAH ? ROOT_CA_SALAH_PEM : ROOT_CA_PEM);
    otaSecure.setHandshakeTimeout(12);
    return otaSecure;
  }
  return otaPlain;
}

static bool otaFetchManifest(ota::Manifest& m, char* err, size_t n) {
  if (!otaPullAvailable(err, n)) return false;
  const char* url = OTA_MANIFEST_URL;
  if (otaHttps(url) && !otaClockReady(err, n)) return false;
  LOG("[Manifest] GET %s\n", url);
  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setConnectTimeout(8000);
  http.setTimeout(10000);
  OtaNetWait wait;
  if (!http.begin(otaClientFor(url), url)) { snprintf(err, n, "Alamat manifest tidak sah: %s", url); return false; }
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    if (code == HTTP_CODE_NOT_FOUND)
      snprintf(err, n, "Manifest tidak ada di server (HTTP 404). Cek GROUP_ID dan jalankan publish_fw.py.");
    else if (code < 0 && otaHttps(url))
      snprintf(err, n, "Tidak bisa tersambung aman ke server (%s). Server mati, atau Root CA tidak cocok.", http.errorToString(code).c_str());
    else
      snprintf(err, n, "Manifest gagal diambil, HTTP %d (%s).", code, http.errorToString(code).c_str());
    http.end();
    return false;
  }
  int len = http.getSize();
  if (len > 4096) { snprintf(err, n, "Manifest terlalu besar (%d byte).", len); http.end(); return false; }
  String body = http.getString();
  http.end();
  return ota::parseManifest(body.c_str(), body.length(), FW_PRODUCT, BOARD_NAME, m, err, n);
}

// Unduh, periksa, tulis ke slot sebelah. Firmware lama tidak tersentuh sampai semuanya lolos.
static bool otaDownloadInstall(const ota::FwEntry& fw, const char* src, char* err, size_t n) {
  otaBusy = true;
  forwardToUno("STOP");                                     // safe state sebelum menulis flash
  LOG("[OTA] Mengunduh v%s (%lu byte) dari %s\n", fw.version, (unsigned long)fw.size, fw.url);
  otaSetStatus("downloading", fw.version, 0, "Mengunduh firmware. Robot dihentikan selama update.");
  if (otaHttps(fw.url) && !otaClockReady(err, n)) return false;

  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setConnectTimeout(8000);
  http.setTimeout(15000);
  OtaNetWait wait;                                          // unduhan 1 MB juga bisa makan waktu
  if (!http.begin(otaClientFor(fw.url), fw.url)) { snprintf(err, n, "Alamat firmware tidak sah."); return false; }
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    snprintf(err, n, "Unduh gagal, HTTP %d (%s).", code, http.errorToString(code).c_str());
    http.end();
    return false;
  }
  int len = http.getSize();
  if (len > 0 && (uint32_t)len != fw.size) {
    snprintf(err, n, "Ukuran file di server %d byte, manifest bilang %lu. Terbitkan ulang dengan publish_fw.py.", len, (unsigned long)fw.size);
    http.end();
    return false;
  }
  if (!Update.begin(fw.size)) {
    snprintf(err, n, "Tidak bisa mulai menulis (%s). Pilih Partition Scheme \"Default 4MB with spiffs\", bukan Huge APP.", Update.errorString());
    http.end();
    return false;
  }
  Update.setMD5(fw.md5);

  ota::Sha256 sha;
  sha.begin();
  ota::MarkerScanner mk;
  mk.reset();
  WiFiClient* stream = http.getStreamPtr();
  static uint8_t buf[1024];
  uint32_t got = 0, lastData = millis(), lastNote = 0;
  int lastPct = 0;
  bool writeFail = false;
  while (got < fw.size) {
    otaBeat();
    int avail = stream ? stream->available() : 0;
    if (avail <= 0) {
      if (!http.connected()) break;
      if (millis() - lastData > 15000) break;
      bridgeService();
      delay(2);
      continue;
    }
    size_t want = (size_t)avail;
    if (want > sizeof(buf)) want = sizeof(buf);
    if (want > fw.size - got) want = fw.size - got;
    int r = stream->read(buf, want);
    if (r <= 0) continue;
    lastData = millis();
    sha.update(buf, (size_t)r);
    mk.feed(buf, (size_t)r);
    if (Update.write(buf, (size_t)r) != (size_t)r) { writeFail = true; break; }
    got += (uint32_t)r;
    int pct = (int)((got * 100ULL) / fw.size);
    if (pct >= lastPct + 5 || millis() - lastNote > 1500) {
      lastPct = pct;
      lastNote = millis();
      otaSetStatus("downloading", fw.version, pct, "Mengunduh firmware. Robot dihentikan selama update.");
    }
    bridgeService();
  }
  http.end();
  if (writeFail) {
    snprintf(err, n, "Gagal menulis flash (%s). Firmware lama tetap dipakai.", Update.errorString());
    Update.abort();
    return false;
  }
  if (got != fw.size) {
    snprintf(err, n, "Unduhan terputus di %lu dari %lu byte. Firmware lama tetap dipakai.", (unsigned long)got, (unsigned long)fw.size);
    Update.abort();
    return false;
  }

  otaSetStatus("verifying", fw.version, 100, "Memeriksa sidik jari, penanda versi, dan tanda tangan...");
  uint8_t digest[32];
  sha.finish(digest);
  char hex[65];
  ota::hexEncode(digest, 32, hex);
  if (!ota::hexEqual(hex, fw.sha256)) {
    snprintf(err, n, "Sidik jari SHA-256 tidak cocok dengan manifest. File rusak atau sudah diganti. Tidak dipasang.");
    Update.abort();
    return false;
  }
  if (!mk.found()) {
    snprintf(err, n, "File ini tidak punya penanda FWID, jadi bukan firmware bridge proyek ini. Tidak dipasang.");
    Update.abort();
    return false;
  }
  if (strcmp(mk.product(), FW_PRODUCT) != 0) {
    snprintf(err, n, "File ini firmware '%s', bukan '%s'. Tidak dipasang.", mk.product(), FW_PRODUCT);
    Update.abort();
    return false;
  }
  if (strcmp(mk.version(), fw.version) != 0) {
    snprintf(err, n, "Isi file melapor v%s, padahal manifest v%s (lupa menaikkan FW_VERSION?). Tidak dipasang.", mk.version(), fw.version);
    Update.abort();
    return false;
  }
  if (otaKeyOn()) {
    if (!fw.sig[0]) {
      snprintf(err, n, "Firmware tidak ditandatangani, padahal robot ini mewajibkan tanda tangan. Tidak dipasang.");
      Update.abort();
      return false;
    }
    char msg[200];
    ota::signMessage(msg, sizeof(msg), FW_PRODUCT, BOARD_NAME, fw.version, fw.size, hex);
    otaBeat();
    int vr = ota::verifySignature(OTA_PUBKEY_PEM, msg, fw.sig);
    otaBeat();
    if (vr != 0) {
      snprintf(err, n, "Tanda tangan tidak sah (kode %d). File ini bukan dari pemegang kunci rahasia. Tidak dipasang.", vr);
      Update.abort();
      return false;
    }
    LOG("[OTA] Tanda tangan sah.\n");
  } else if (fw.sig[0]) {
    LOG("[OTA] Manifest punya tanda tangan, tapi kunci publik belum diisi (ota_pubkey.h). Tanda tangan tidak diperiksa.\n");
  }
  if (!Update.end()) {
    snprintf(err, n, "Verifikasi akhir gagal (%s). Firmware lama tetap dipakai.", Update.errorString());
    return false;
  }
  otaMarkPending(fw.version, src);
  LOG("[OTA] v%s tertulis di slot baru, semua pemeriksaan lolos.\n", fw.version);
  return true;
}

static void otaRebootNow(const char* ver) {
  char msg[120];
  snprintf(msg, sizeof(msg), "Firmware v%s terpasang. Robot restart lalu memeriksa dirinya sendiri.", ver);
  LOG("[OTA] Reboot ke firmware baru (masa percobaan)...\n");
  otaSetStatus("rebooting", ver, 100, msg);
  uint32_t t0 = millis();
  while (millis() - t0 < 600) { bridgeService(); delay(10); }
  ESP.restart();
}

// Cek manifest. Hasilnya dikirim ke dashboard; tidak memasang apa pun.
static void otaCheck() {
  otaLastCheck = millis();
  otaCheckedOnce = true;
  char err[200];
  if (!otaPullAvailable(err, sizeof(err))) { otaHaveAvail = false; otaSetStatus("off", "", -1, err); return; }
  otaSetStatus("checking", "", -1, "Mengecek server update...");
  ota::Manifest m;
  if (!otaFetchManifest(m, err, sizeof(err))) {
    otaHaveAvail = false;
    LOG("[Manifest] %s\n", err);
    otaSetStatus("error", "", -1, err);
    return;
  }
  const esp_partition_t* next = esp_ota_get_next_update_partition(NULL);
  char msg[200];
  ota::UpdateVerdict v = ota::judgeUpdate(m.latest, FW_VERSION, otaSt.black, robot.info ? robot.fw : "",
                                          next ? next->size : 0, otaKeyOn(), msg, sizeof(msg));
  LOG("[Versi] Berjalan v%s | Server v%s. %s\n", FW_VERSION, m.latest.version, msg);
  if (v == ota::UPD_AVAILABLE) {
    otaAvail = m.latest;
    otaHaveAvail = true;
    otaSetStatus("available", m.latest.version, -1, msg);
    if (OTA_PASANG_OTOMATIS) otaInstallReq = true;
  } else {
    otaHaveAvail = false;
    otaSetStatus(v == ota::UPD_UP_TO_DATE ? "uptodate" : "blocked", m.latest.version, -1, msg);
  }
}

static void otaInstall() {
  if (otaBusy) return;
  if (otaTrial) { otaSetStatus("trial", FW_VERSION, -1, "Tunggu: firmware ini sendiri masih masa percobaan."); return; }
  otaCheck();                                               // ambil manifest terbaru dulu
  if (!otaHaveAvail) return;
  const char* gate = ota::gateProblem(robot, millis(), OTA_BUTUH_UNO, OTA_MIN_BAT_MV);
  if (gate) {
    char msg[200];
    snprintf(msg, sizeof(msg), "Update v%s belum dipasang: %s", otaAvail.version, gate);
    LOG("[OTA] %s\n", msg);
    otaSetStatus("blocked", otaAvail.version, -1, msg);
    return;
  }
  char err[200];
  if (otaDownloadInstall(otaAvail, "pull", err, sizeof(err))) otaRebootNow(otaAvail.version);
  otaBusy = false;
  LOG("[OTA] %s\n", err);
  otaSetStatus("error", otaAvail.version, -1, err);
}

// Rollback lewat server: dipakai hanya kalau slot lama tidak bisa dipakai.
static void otaTryStable() {
  otaLastStableTry = millis();
  char err[200];
  ota::Manifest m;
  if (!otaFetchManifest(m, err, sizeof(err))) { LOG("[SafeOTA] Rollback lewat server gagal: %s\n", err); otaSetStatus("error", otaBadVer, -1, err); return; }
  if (!m.stable.ok || strcmp(m.stable.version, otaBadVer) == 0) {
    otaSetStatus("error", otaBadVer, -1, "Rollback gagal: manifest tidak punya versi stable yang berbeda. Terbitkan stable dengan publish_fw.py.");
    return;
  }
  if (otaKeyOn() && !m.stable.sig[0]) { otaSetStatus("error", otaBadVer, -1, "Rollback gagal: versi stable tidak ditandatangani."); return; }
  if (otaDownloadInstall(m.stable, "pull", err, sizeof(err))) {
    otaNeedStable = false;
    otaRebootNow(m.stable.version);
  }
  otaBusy = false;
  otaSetStatus("error", m.stable.version, -1, err);
}

// ==================================================================
//  Masa percobaan (health check)
// ==================================================================
static void otaFillHealth(ota::HealthInput& in) {
  in.netOk = apMode || WiFi.status() == WL_CONNECTED;
  in.freeHeap = ESP.getFreeHeap();
  in.minHeap = MIN_FREE_HEAP;
  in.needUno = OTA_BUTUH_UNO;
  in.robot = ROBOT_NAME;
  in.fault = (FAULT_MODE == 1);
  paramWanted(in.wantTh, in.wantSpd);
}

static void otaTrialStep(uint32_t now) {
  if (!otaTrialStart) {
    otaTrialStart = now;
    forwardToUno("INFO");
    otaLastInfoAsk = now;
    LOG("[Health] Menjalankan health check (maks %lu detik)...\n", (unsigned long)(HEALTH_TIMEOUT_MS / 1000UL));
  }
#if FAULT_MODE == 3
  LOG("[FAULT] Injeksi: program macet (loop berhenti). Tunggu watchdog...\n");
  while (true) delay(100);
#endif
  if (!robot.info && now - otaLastInfoAsk > 3000) { forwardToUno("INFO"); otaLastInfoAsk = now; }
  ota::HealthInput in;
  otaFillHealth(in);
  char msg[200];
  int bad = ota::healthProblems(robot, now, in, msg, sizeof(msg));
  if (!bad) {
    if (!otaHealthyFrom) otaHealthyFrom = now;
    if (now - otaHealthyFrom >= HEALTH_STABIL_MS) { otaConfirm(); return; }
  } else {
    otaHealthyFrom = 0;
  }
  if (now - otaTrialStart > HEALTH_TIMEOUT_MS) {
    otaTrialDone = true;
    LOG("[Health] TIDAK LULUS: %s\n", msg);
    char why[120];
    snprintf(why, sizeof(why), "health check gagal (%s)", msg);
    otaRollback(FW_VERSION, why);
    otaTrial = false;
    return;
  }
  if (now - otaLastTrialNote > 2000) {
    otaLastTrialNote = now;
    char note[200];
    if (bad) snprintf(note, sizeof(note), "Masa percobaan v%s: menunggu %s", FW_VERSION, msg);
    else snprintf(note, sizeof(note), "Masa percobaan v%s: semua pemeriksaan lolos, memastikan stabil...", FW_VERSION);
    otaSetStatus("trial", FW_VERSION, -1, note);
  }
}

// ==================================================================
//  Dipanggil dari esp_bridge.ino
// ==================================================================
static void otaSetup() {
  otaSetupPush();
  if (strlen(SERVER_BASE)) {
    LOG("[OTA] Pull OTA: %s\n", OTA_MANIFEST_URL);
    if (otaHttps(SERVER_BASE) && !apMode) {
      configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
      otaClockStarted = true;
    }
  } else {
    LOG("[OTA] Pull OTA mati: SERVER_BASE belum diisi.\n");
  }
  LOG("[OTA] Tanda tangan firmware: %s. Rollback: %s.\n", otaKeyOn() ? "WAJIB" : "belum diaktifkan (ota_pubkey.h kosong)",
      ROLLBACK_BOOTLOADER ? "bootloader ESP-IDF + program" : "program (slot lama di flash)");
  LOG("Ketik 'u' cek + pasang update, 'c' cek saja, 's' lihat status.\n");
  if (otaTrial) otaSetStatus("trial", FW_VERSION, -1, "Firmware baru, sedang masa percobaan.");
  else if (otaSt.lastSt[0]) {
    ota::copyStr(otaStatusSt, sizeof(otaStatusSt), otaSt.lastSt);
    ota::copyStr(otaStatusVer, sizeof(otaStatusVer), otaSt.lastVer);
    ota::copyStr(otaStatusMsg, sizeof(otaStatusMsg), otaSt.lastMsg);
  }
}

static bool otaLocksMotion() { return otaBusy || otaTrial; }

static void otaNoteMotion() { otaLastMotion = millis(); }

static void otaLockedReply(Source src, uint8_t num) {
  if (otaLastLockNote && millis() - otaLastLockNote < 2000) return;
  otaLastLockNote = millis();
  char out[200];
  JsonDocument d;
  d["t"] = "ota";
  d["st"] = otaStatusSt;
  d["cur"] = FW_VERSION;
  d["msg"] = otaBusy ? "Perintah gerak ditolak: firmware sedang diperbarui."
                     : "Perintah gerak ditolak: firmware baru sedang diperiksa (paling lama 30 detik).";
  serializeJson(d, out, sizeof(out));
  sendToClient(src, num, out);
}

// "OTA CHECK" / "OTA INSTALL" / "OTA STATUS" dari dashboard
static void otaCommand(const char* args, Source src, uint8_t num) {
  while (*args == ' ') args++;
  if (!strcmp(args, "STATUS") || !args[0]) { otaSendStatus(src, num); return; }
  if (!strcmp(args, "CHECK")) { otaCheckReq = true; return; }
  if (!strcmp(args, "INSTALL")) {
    if (src != SRC_WS) {
      // lewat MQTT (internet) tidak boleh: harus ada orang di dekat robot saat update
      char out[200];
      JsonDocument d;
      d["t"] = "ota"; d["st"] = "blocked"; d["cur"] = FW_VERSION;
      d["msg"] = "Pasang update hanya bisa dari dashboard yang tersambung langsung ke robot, bukan lewat MQTT.";
      serializeJson(d, out, sizeof(out));
      sendToClient(src, num, out);
      return;
    }
    otaInstallReq = true;
    return;
  }
  otaSendStatus(src, num);
}

static void otaSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == 'u' || c == 'U') { otaInstallReq = true; }
    else if (c == 'c' || c == 'C') { otaCheckReq = true; }
    else if (c == 's' || c == 'S') { otaPrintState(); LOG("[State] status sekarang: %s %s %s\n", otaStatusSt, otaStatusVer, otaStatusMsg); }
  }
}

static void otaLoop() {
  otaBeat();
  if (otaPushOn) ArduinoOTA.handle();
  otaSerial();
  uint32_t now = millis();
  if (otaTrial && !otaTrialDone) { otaTrialStep(now); return; }
  if (otaBusy) return;
  if (otaNeedStable) {
    if (now - otaLastStableTry > 60000UL || !otaLastStableTry) {
      char err[160];
      if (otaPullAvailable(err, sizeof(err))) otaTryStable();
      else otaLastStableTry = now;
    }
    return;
  }
  if (otaInstallReq) { otaInstallReq = false; otaCheckReq = false; otaInstall(); return; }
  if (otaCheckReq) { otaCheckReq = false; otaCheck(); return; }
  // cek otomatis: hanya kalau Pull OTA aktif, robot diam, dan dashboard tidak sedang mengemudi
  if (strlen(SERVER_BASE) && !apMode && WiFi.status() == WL_CONNECTED) {
    uint32_t wait = otaCheckedOnce ? CHECK_INTERVAL_MS : 10000UL;
    const bool driving = otaLastMotion && now - otaLastMotion <= 15000UL;
    if (now - otaLastCheck >= wait && !driving &&
        !ota::gateProblem(robot, now, OTA_BUTUH_UNO, OTA_MIN_BAT_MV)) {
      otaCheck();
    }
  }
}
