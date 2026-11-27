// ota_core.h — bagian logika OTA yang tidak menyentuh hardware.
// ------------------------------------------------------------------
// Semua keputusan penting ada di sini: membaca manifest, membandingkan versi, mengecek apakah
// robot sedang diam (boleh update), health check setelah update, dan memutuskan apa yang
// terjadi saat boot (masa percobaan / rollback). Karena tidak memanggil fungsi ESP32 sama
// sekali, file ini juga dikompilasi dan diuji di PC (tests/bridge-host).
//
// Butuh library ArduinoJson versi 7 (Library Manager: "ArduinoJson" oleh Benoit Blanchon).
#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <ArduinoJson.h>

namespace ota {

// ==================================================================
//  Teks
// ==================================================================
inline void copyStr(char* dst, size_t n, const char* src) {
  if (!n) return;
  if (!src) src = "";
  size_t i = 0;
  for (; i + 1 < n && src[i]; i++) dst[i] = src[i];
  dst[i] = '\0';
}

// tambahkan potongan pesan, dipisah "; "
inline void appendMsg(char* dst, size_t n, const char* part) {
  size_t len = strlen(dst);
  if (len && len + 2 < n) { dst[len++] = ';'; dst[len++] = ' '; dst[len] = '\0'; }
  copyStr(dst + len, n - len, part);
}

// ==================================================================
//  Versi MAJOR.MINOR.PATCH
// ==================================================================
struct SemVer { int major = 0, minor = 0, patch = 0; };

// Ketat: hanya angka dan dua titik, tanpa spasi atau huruf. "1.10.0" > "1.9.0" (dibandingkan per angka,
// bukan sebagai teks).
inline bool parseSemVer(const char* s, SemVer& v) {
  if (!s) return false;
  int part[3] = {0, 0, 0};
  for (int i = 0; i < 3; i++) {
    int digits = 0;
    long n = 0;
    while (*s >= '0' && *s <= '9') {
      n = n * 10 + (*s - '0');
      s++;
      if (++digits > 5) return false;
    }
    if (!digits) return false;
    part[i] = (int)n;
    if (i < 2) {
      if (*s != '.') return false;
      s++;
    }
  }
  if (*s) return false;
  v.major = part[0]; v.minor = part[1]; v.patch = part[2];
  return true;
}

inline int cmpSemVer(const SemVer& a, const SemVer& b) {
  if (a.major != b.major) return a.major < b.major ? -1 : 1;
  if (a.minor != b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch != b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

// -1/0/1, atau -2 kalau salah satu bukan versi yang sah
inline int cmpVersion(const char* a, const char* b) {
  SemVer va, vb;
  if (!parseSemVer(a, va) || !parseSemVer(b, vb)) return -2;
  return cmpSemVer(va, vb);
}

// ==================================================================
//  Hex
// ==================================================================
inline int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

inline bool isHexLen(const char* s, size_t len) {
  if (!s || strlen(s) != len) return false;
  for (size_t i = 0; i < len; i++) if (hexVal(s[i]) < 0) return false;
  return true;
}

// kembalikan jumlah byte, 0 kalau teks bukan hex genap atau terlalu panjang
inline size_t hexDecode(const char* hex, uint8_t* out, size_t max) {
  size_t len = hex ? strlen(hex) : 0;
  if (!len || (len & 1) || len / 2 > max) return 0;
  for (size_t i = 0; i < len; i += 2) {
    int hi = hexVal(hex[i]), lo = hexVal(hex[i + 1]);
    if (hi < 0 || lo < 0) return 0;
    out[i / 2] = (uint8_t)((hi << 4) | lo);
  }
  return len / 2;
}

inline void hexEncode(const uint8_t* in, size_t n, char* out) {
  static const char d[] = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) { out[2 * i] = d[in[i] >> 4]; out[2 * i + 1] = d[in[i] & 15]; }
  out[2 * n] = '\0';
}

inline bool hexEqual(const char* a, const char* b) {
  if (!a || !b) return false;
  size_t n = strlen(a);
  if (n != strlen(b)) return false;
  for (size_t i = 0; i < n; i++) {
    int x = hexVal(a[i]), y = hexVal(b[i]);
    if (x < 0 || x != y) return false;
  }
  return true;
}

// ==================================================================
//  Penanda versi di dalam file .bin
// ==================================================================
// Setiap firmware proyek ini menyimpan teks "FWID:<produk>:<versi>;" (mis.
// "FWID:fireguard-bridge:1.2.0;"). Saat mengunduh, ESP mencari teks itu di dalam data yang
// datang, lalu menolak file yang ternyata firmware lain atau versinya tidak sama dengan
// manifest (jebakan "lupa menaikkan FW_VERSION"). publish_fw.py memakai aturan yang sama.
class MarkerScanner {
 public:
  void reset() { st_ = 0; pos_ = 0; found_ = false; prod_[0] = ver_[0] = '\0'; }
  bool found() const { return found_; }
  const char* product() const { return prod_; }
  const char* version() const { return ver_; }

  void feed(const uint8_t* data, size_t n) {
    for (size_t i = 0; i < n && !found_; i++) step((char)data[i]);
  }

 private:
  static bool prodChar(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'; }
  static bool verChar(char c) { return (c >= '0' && c <= '9') || c == '.'; }

  void step(char c) {
    // pola awalan disusun dari huruf satu per satu supaya teks "FWID:" tidak tertulis utuh di sini
    static const char pre[5] = {'F', 'W', 'I', 'D', ':'};
    if (st_ == 0) {
      if (c == pre[pos_]) {
        if (++pos_ == 5) { st_ = 1; pos_ = 0; }
      } else {
        pos_ = (c == pre[0]) ? 1 : 0;
      }
      return;
    }
    if (st_ == 1) {                                  // nama produk
      if (prodChar(c) && pos_ < sizeof(prod_) - 1) { prod_[pos_++] = c; return; }
      if (c == ':' && pos_ > 0) { prod_[pos_] = '\0'; pos_ = 0; st_ = 2; return; }
      restart(c);
      return;
    }
    // st_ == 2: versi
    if (verChar(c) && pos_ < sizeof(ver_) - 1) { ver_[pos_++] = c; return; }
    if (c == ';' && pos_ > 0) {
      ver_[pos_] = '\0';
      SemVer v;
      if (parseSemVer(ver_, v)) { found_ = true; return; }
    }
    restart(c);
  }

  void restart(char c) {
    st_ = 0;
    pos_ = (c == 'F') ? 1 : 0;
    prod_[0] = ver_[0] = '\0';
  }

  uint8_t st_ = 0;
  uint8_t pos_ = 0;
  bool found_ = false;
  char prod_[33] = {0};
  char ver_[16] = {0};
};

// ==================================================================
//  Tanda tangan digital
// ==================================================================
// Yang ditandatangani publish_fw.py (ECDSA P-256 + SHA-256) adalah teks ini, bukan hanya filenya.
// Jadi versi, produk, board, ukuran, dan sidik jari SHA-256 terkunci bersama: orang yang tidak
// punya kunci rahasia tidak bisa memberi label versi baru pada file lama.
inline int signMessage(char* out, size_t n, const char* product, const char* board, const char* version,
                       uint32_t size, const char* sha256hex) {
  return snprintf(out, n, "KOPAK-OTA1|%s|%s|%s|%lu|%s", product, board, version, (unsigned long)size, sha256hex);
}

// ==================================================================
//  Manifest
// ==================================================================
struct FwEntry {
  bool ok = false;
  char version[16] = {0};
  char url[240] = {0};
  char md5[33] = {0};
  char sha256[65] = {0};
  char sig[161] = {0};        // hex DER ECDSA (kosong = tidak ditandatangani)
  uint32_t size = 0;
  char minUno[16] = {0};      // versi firmware Uno minimal (kosong = bebas)
  char notes[121] = {0};      // catatan singkat untuk ditampilkan di dashboard
};

struct Manifest {
  FwEntry latest;
  FwEntry stable;
};

inline bool readEntry(JsonObjectConst o, FwEntry& e, char* err, size_t errN, const char* name) {
  e = FwEntry();
  if (o.isNull()) { snprintf(err, errN, "entri '%s' tidak ada", name); return false; }
  copyStr(e.version, sizeof(e.version), o["version"] | "");
  copyStr(e.url, sizeof(e.url), o["url"] | "");
  copyStr(e.md5, sizeof(e.md5), o["md5"] | "");
  copyStr(e.sha256, sizeof(e.sha256), o["sha256"] | "");
  copyStr(e.sig, sizeof(e.sig), o["sig"] | "");
  copyStr(e.minUno, sizeof(e.minUno), o["min_uno"] | "");
  copyStr(e.notes, sizeof(e.notes), o["notes"] | "");
  long size = o["size"] | 0L;
  SemVer v;
  const char* url = o["url"] | "";
  if (!parseSemVer(e.version, v)) { snprintf(err, errN, "versi '%s' bukan MAJOR.MINOR.PATCH", name); return false; }
  if (strlen(url) >= sizeof(e.url) || (strncmp(url, "http://", 7) != 0 && strncmp(url, "https://", 8) != 0)) {
    snprintf(err, errN, "url '%s' tidak sah (harus http:// atau https://, maks %u karakter)", name, (unsigned)(sizeof(e.url) - 1));
    return false;
  }
  if (!isHexLen(e.md5, 32)) { snprintf(err, errN, "md5 '%s' harus 32 karakter hex", name); return false; }
  if (!isHexLen(e.sha256, 64)) { snprintf(err, errN, "sha256 '%s' harus 64 karakter hex", name); return false; }
  const char* sig = o["sig"] | "";
  if (sig[0] && (strlen(sig) >= sizeof(e.sig) || !isHexLen(sig, strlen(sig)) || (strlen(sig) & 1))) {
    snprintf(err, errN, "sig '%s' bukan hex yang sah", name);
    return false;
  }
  if (size <= 0 || size > 16L * 1024L * 1024L) { snprintf(err, errN, "size '%s' tidak sah", name); return false; }
  if (e.minUno[0] && !parseSemVer(e.minUno, v)) { snprintf(err, errN, "min_uno '%s' bukan versi yang sah", name); return false; }
  e.size = (uint32_t)size;
  e.ok = true;
  return true;
}

// Cek board dan produk dulu: manifest untuk perangkat lain ditolak sebelum apa pun diunduh.
// Entri "stable" boleh tidak ada (hanya dipakai untuk rollback lewat server).
inline bool parseManifest(const char* json, size_t len, const char* product, const char* board,
                          Manifest& m, char* err, size_t errN) {
  m = Manifest();
  err[0] = '\0';
  JsonDocument doc;
  DeserializationError de = deserializeJson(doc, json, len);
  if (de) { snprintf(err, errN, "manifest bukan JSON yang sah (%s)", de.c_str()); return false; }
  if (!doc.is<JsonObjectConst>()) { snprintf(err, errN, "manifest harus berupa objek JSON"); return false; }
  const char* b = doc["board"] | "";
  if (strcmp(b, board) != 0) { snprintf(err, errN, "manifest untuk board '%s', perangkat ini '%s'", b, board); return false; }
  const char* p = doc["product"] | "";
  if (strcmp(p, product) != 0) { snprintf(err, errN, "manifest untuk '%s', perangkat ini '%s'", p, product); return false; }
  if (!readEntry(doc["latest"].as<JsonObjectConst>(), m.latest, err, errN, "latest")) return false;
  if (!doc["stable"].isNull()) {
    char e2[96];
    if (!readEntry(doc["stable"].as<JsonObjectConst>(), m.stable, e2, sizeof(e2), "stable")) m.stable = FwEntry();
  }
  return true;
}

enum UpdateVerdict : uint8_t {
  UPD_AVAILABLE,      // ada versi baru yang boleh dipasang
  UPD_UP_TO_DATE,     // versi server tidak lebih baru (termasuk sama)
  UPD_BLACKLISTED,    // versi ini pernah gagal di perangkat ini
  UPD_NEEDS_UNO,      // firmware Uno terlalu lama untuk versi ini
  UPD_TOO_BIG,        // tidak muat di slot OTA
  UPD_UNSIGNED,       // perangkat mewajibkan tanda tangan tapi manifest tidak punya
};

// Aturan: versi hanya boleh naik, versi yang pernah gagal tidak dipasang lagi, harus muat, dan
// firmware Uno harus cukup baru kalau manifest meminta (min_uno).
inline UpdateVerdict judgeUpdate(const FwEntry& latest, const char* current, const char* blacklisted,
                                 const char* unoFw, uint32_t slotSize, bool needSig, char* msg, size_t n) {
  if (cmpVersion(latest.version, current) <= 0) {
    snprintf(msg, n, "Sudah versi terbaru (perangkat v%s, server v%s).", current, latest.version);
    return UPD_UP_TO_DATE;
  }
  if (blacklisted && blacklisted[0] && strcmp(blacklisted, latest.version) == 0) {
    snprintf(msg, n, "v%s pernah gagal di robot ini, jadi tidak dipasang lagi. Terbitkan versi perbaikan dengan nomor lebih tinggi.", latest.version);
    return UPD_BLACKLISTED;
  }
  if (slotSize && latest.size > slotSize) {
    snprintf(msg, n, "v%s berukuran %lu byte, tidak muat di slot OTA (%lu byte). Cek Partition Scheme.", latest.version,
             (unsigned long)latest.size, (unsigned long)slotSize);
    return UPD_TOO_BIG;
  }
  if (needSig && !latest.sig[0]) {
    snprintf(msg, n, "v%s tidak ditandatangani, padahal robot ini mewajibkan tanda tangan.", latest.version);
    return UPD_UNSIGNED;
  }
  if (latest.minUno[0]) {
    if (!unoFw || !unoFw[0]) {
      snprintf(msg, n, "v%s butuh firmware Uno minimal v%s, tapi versi Uno belum diketahui (Uno belum mengirim info).", latest.version, latest.minUno);
      return UPD_NEEDS_UNO;
    }
    if (cmpVersion(unoFw, latest.minUno) < 0) {
      snprintf(msg, n, "v%s butuh firmware Uno minimal v%s, Uno masih v%s. Update Uno lewat USB dulu.", latest.version, latest.minUno, unoFw);
      return UPD_NEEDS_UNO;
    }
  }
  snprintf(msg, n, "Ada versi baru v%s (sekarang v%s).", latest.version, current);
  return UPD_AVAILABLE;
}

// ==================================================================
//  Kondisi robot (dibaca dari telemetri Uno)
// ==================================================================
struct RobotSnap {
  // dari pesan "tel"
  bool tel = false;
  uint32_t telAt = 0;
  uint32_t telCount = 0;
  char mode = '?';            // 'M' manual, 'A' otomatis
  int sp = -1;                // kecepatan motor terakhir (0 = diam)
  int pump = 0;               // FireGuard: pompa menyala?
  int brush = 0;              // EcoBot: sapu berputar?
  long bat = -1;              // mV, -1 = robot tidak punya sensor baterai
  uint8_t nFlame = 0, nGas = 0;
  int flame[4] = {0};
  int gas[4] = {0};
  bool haveErr = false;       // Uno mengirim tanda kabel sensor lepas (fe/ge)
  uint8_t fe[4] = {0};
  uint8_t ge[4] = {0};
  bool gasWarm = false;       // MQ-2 masih pemanasan
  uint8_t nDist = 0;          // EcoBot: jumlah sensor ultrasonik
  int dist[8] = {0};

  // dari pesan "info"
  bool info = false;
  uint32_t infoAt = 0;
  char robot[16] = {0};
  char fw[16] = {0};
  bool cfg = false;           // Uno menerima perintah CFG
  bool haveTh = false;
  int th[4] = {0};            // api waspada, api bahaya, gas waspada, gas bahaya
  bool haveSpd = false;
  int spd[2] = {0};           // PWM otomatis: putar, maju
  char flameLbl[4][10] = {{0}};
  char gasLbl[4][10] = {{0}};
};

template <typename T>
inline uint8_t readIntArray(JsonArrayConst a, T* out, uint8_t max) {
  uint8_t n = 0;
  for (JsonVariantConst v : a) {
    if (n >= max) break;
    out[n++] = (T)(v | 0);
  }
  return n;
}

inline void readLabels(JsonArrayConst a, char out[][10], uint8_t max) {
  uint8_t n = 0;
  for (JsonVariantConst v : a) {
    if (n >= max) break;
    copyStr(out[n++], 10, v | "");
  }
}

// Baca satu baris JSON dari Uno. Kembalikan true kalau barisnya tel/info.
inline bool parseUnoLine(const char* line, RobotSnap& s, uint32_t now) {
  if (!line || line[0] != '{') return false;
  const bool isTel = strstr(line, "\"t\":\"tel\"") != nullptr;
  const bool isInfo = !isTel && strstr(line, "\"t\":\"info\"") != nullptr;
  if (!isTel && !isInfo) return false;
  JsonDocument doc;
  if (deserializeJson(doc, line)) return false;

  if (isTel) {
    s.tel = true;
    s.telAt = now;
    s.telCount++;
    const char* m = doc["m"] | "?";
    s.mode = m[0];
    s.sp = doc["sp"] | -1;
    s.pump = doc["p"] | 0;
    s.brush = doc["br"] | 0;
    s.bat = doc["bat"].isNull() ? -1L : (long)(doc["bat"] | 0L);
    s.nFlame = readIntArray(doc["fl"].as<JsonArrayConst>(), s.flame, 4);
    s.nGas = readIntArray(doc["gs"].as<JsonArrayConst>(), s.gas, 4);
    s.haveErr = !doc["fe"].isNull() || !doc["ge"].isNull();
    memset(s.fe, 0, sizeof(s.fe));
    memset(s.ge, 0, sizeof(s.ge));
    readIntArray(doc["fe"].as<JsonArrayConst>(), s.fe, 4);
    readIntArray(doc["ge"].as<JsonArrayConst>(), s.ge, 4);
    s.gasWarm = (doc["gw"] | 0) != 0;
    s.nDist = readIntArray(doc["d"].as<JsonArrayConst>(), s.dist, 8);
    return true;
  }

  s.info = true;
  s.infoAt = now;
  copyStr(s.robot, sizeof(s.robot), doc["robot"] | "");
  copyStr(s.fw, sizeof(s.fw), doc["fw"] | "");
  s.cfg = (doc["cfg"] | 0) != 0;
  JsonObjectConst th = doc["th"].as<JsonObjectConst>();
  s.haveTh = !th.isNull() && !th["fw"].isNull();
  if (s.haveTh) {
    s.th[0] = th["fw"] | 0; s.th[1] = th["fd"] | 0;
    s.th[2] = th["gw"] | 0; s.th[3] = th["gd"] | 0;
  }
  JsonObjectConst spd = doc["spd"].as<JsonObjectConst>();
  s.haveSpd = !spd.isNull();
  if (s.haveSpd) { s.spd[0] = spd["turn"] | 0; s.spd[1] = spd["fwd"] | 0; }
  readLabels(doc["flame"].as<JsonArrayConst>(), s.flameLbl, 4);
  readLabels(doc["gas"].as<JsonArrayConst>(), s.gasLbl, 4);
  return true;
}

inline bool unoAlive(const RobotSnap& s, uint32_t now, uint32_t maxAgeMs = 3000) {
  return s.tel && (uint32_t)(now - s.telAt) <= maxAgeMs;
}

// Syarat sebelum update dipasang: robot benar-benar diam. nullptr = boleh.
inline const char* gateProblem(const RobotSnap& s, uint32_t now, bool needUno, long minBatMv) {
  if (!unoAlive(s, now)) {
    if (!needUno) return nullptr;            // ESP diuji tanpa Uno di meja
    return "Uno tidak mengirim data. Cek kabel TX/RX dan daya Uno, lalu coba lagi.";
  }
  if (s.mode != 'M') return "Robot sedang mode Otomatis. Pindahkan ke Manual dulu.";
  if (s.sp != 0) return "Roda masih berputar. Hentikan robot dulu.";
  if (s.pump) return "Pompa masih menyala. Matikan dulu.";
  if (s.brush) return "Sapu masih berputar. Matikan dulu.";
  if (minBatMv > 0 && s.bat >= 0 && s.bat < minBatMv) return "Baterai terlalu lemah untuk update. Isi baterai dulu.";
  return nullptr;
}

// ==================================================================
//  Health check firmware baru
// ==================================================================
struct HealthInput {
  bool netOk = true;            // WiFi tersambung / AP aktif
  uint32_t freeHeap = 0;
  uint32_t minHeap = 0;
  bool needUno = true;          // wajib ada data dari Uno
  const char* robot = "";       // ROBOT_NAME: Uno harus berisi firmware robot yang sama
  int wantTh[4] = {0};          // ambang yang harus sudah diterapkan di Uno (0 = tidak dicek)
  int wantSpd[2] = {0};
  bool fault = false;           // FAULT_MODE 1: health check sengaja digagalkan
};

inline const char* sensorName(const char lbl[10], const char* fallback, int idx, char* buf, size_t n) {
  if (lbl[0]) snprintf(buf, n, "%s", lbl);
  else snprintf(buf, n, "%s%d", fallback, idx + 1);
  return buf;
}

// Kembalikan jumlah masalah (0 = sehat). Pesan untuk manusia ditulis ke msg.
inline int healthProblems(const RobotSnap& s, uint32_t now, const HealthInput& in, char* msg, size_t n) {
  int bad = 0;
  char part[96];
  msg[0] = '\0';
  if (!in.netOk) { appendMsg(msg, n, "WiFi tidak tersambung"); bad++; }
  if (in.minHeap && in.freeHeap < in.minHeap) {
    snprintf(part, sizeof(part), "memori tinggal %lu byte (minimal %lu)", (unsigned long)in.freeHeap, (unsigned long)in.minHeap);
    appendMsg(msg, n, part); bad++;
  }
  if (in.fault) { appendMsg(msg, n, "FAULT_MODE 1: health check sengaja digagalkan"); bad++; }

  if (in.needUno) {
    if (!unoAlive(s, now) || s.telCount < 3) { appendMsg(msg, n, "Uno belum mengirim telemetri"); return bad + 1; }
    if (!s.info) { appendMsg(msg, n, "Uno belum mengirim info"); return bad + 1; }
    if (in.robot && in.robot[0] && strcmp(s.robot, in.robot) != 0) {
      snprintf(part, sizeof(part), "Uno berisi firmware '%s', bukan '%s'", s.robot, in.robot);
      appendMsg(msg, n, part); bad++;
    }
    if (s.sp != 0) { appendMsg(msg, n, "motor bergerak saat boot"); bad++; }

    char nm[16];
    for (uint8_t i = 0; i < s.nFlame; i++) {
      if (s.haveErr && s.fe[i]) {
        snprintf(part, sizeof(part), "sensor api %s tidak tersambung (kabel AO lepas?)", sensorName(s.flameLbl[i], "#", i, nm, sizeof(nm)));
        appendMsg(msg, n, part); bad++;
      } else if (s.flame[i] <= 8) {
        snprintf(part, sizeof(part), "sensor api %s terbaca %d (tanpa daya?)", sensorName(s.flameLbl[i], "#", i, nm, sizeof(nm)), s.flame[i]);
        appendMsg(msg, n, part); bad++;
      }
    }
    for (uint8_t i = 0; i < s.nGas; i++) {
      if (s.haveErr && s.ge[i]) {
        snprintf(part, sizeof(part), "%s tidak tersambung (kabel AO lepas?)", sensorName(s.gasLbl[i], "MQ-2 #", i, nm, sizeof(nm)));
        appendMsg(msg, n, part); bad++;
      } else if (!s.gasWarm && s.gas[i] <= 8) {
        snprintf(part, sizeof(part), "%s terbaca %d (tanpa daya?)", sensorName(s.gasLbl[i], "MQ-2 #", i, nm, sizeof(nm)), s.gas[i]);
        appendMsg(msg, n, part); bad++;
      }
    }
    // EcoBot: sensor ke-6 menghadap ke dalam wadah sampah, jadi selalu ada permukaan yang terlihat.
    // Kalau sensor itu tidak membaca apa pun (-1), hampir pasti kabelnya lepas.
    if (s.nDist >= 6 && s.dist[5] < 0) { appendMsg(msg, n, "sensor ultrasonik Wadah tidak membaca apa pun (kabel lepas?)"); bad++; }

    bool wantTh = in.wantTh[0] || in.wantTh[1] || in.wantTh[2] || in.wantTh[3];
    bool wantSpd = in.wantSpd[0] || in.wantSpd[1];
    if ((wantTh || wantSpd) && !s.cfg) { appendMsg(msg, n, "Uno belum mendukung CFG (perlu fireguard_uno 1.4.0)"); bad++; }
    else {
      for (int i = 0; i < 4; i++) {
        if (in.wantTh[i] && (!s.haveTh || s.th[i] != in.wantTh[i])) { appendMsg(msg, n, "ambang sensor baru belum diterapkan di Uno"); bad++; break; }
      }
      for (int i = 0; i < 2; i++) {
        if (in.wantSpd[i] && (!s.haveSpd || s.spd[i] != in.wantSpd[i])) { appendMsg(msg, n, "PWM otomatis baru belum diterapkan di Uno"); bad++; break; }
      }
    }
  }
  return bad;
}

// ==================================================================
//  Status OTA yang disimpan di flash (NVS)
// ==================================================================
struct OtaState {
  uint8_t magic = 0;
  char pending[16] = {0};     // versi yang sedang masa percobaan
  uint8_t attempts = 0;       // sudah berapa kali boot dalam masa percobaan
  char black[16] = {0};       // versi yang pernah gagal: jangan dipasang lagi
  char good[16] = {0};        // versi terakhir yang lolos health check
  char pendHash[17] = {0};    // sidik jari image baru (16 hex pertama SHA-256 dari ESP-IDF)
  char prevHash[17] = {0};    // sidik jari image lama yang ditinggalkan
  char prevVer[16] = {0};     // versi lama
  char src[6] = {0};          // "pull" atau "push"
  char lastSt[12] = {0};      // hasil terakhir: valid / rolled_back / error
  char lastVer[16] = {0};
  char lastMsg[120] = {0};
};
static const uint8_t OTA_STATE_MAGIC = 0xA7;

enum BootAction : uint8_t {
  BOOT_NORMAL,        // tidak ada update yang menunggu
  BOOT_TRIAL,         // firmware baru, masa percobaan
  BOOT_TOO_MANY,      // firmware baru sudah crash/reboot lebih dari batas: rollback
  BOOT_MISMATCH,      // isi biner melapor versi lain dari yang dipasang: rollback
  BOOT_ROLLED_BACK,   // sudah kembali ke firmware lama (oleh bootloader / rollback sebelumnya)
  BOOT_STALE,         // firmware lain dipasang lewat USB: status lama dibuang
};

// runHash: sidik jari image yang sedang berjalan. Fungsi ini mengubah st (attempts, pending, black).
inline BootAction decideBoot(OtaState& st, const char* fw, const char* runHash, uint8_t maxTrials) {
  if (!st.pending[0]) return BOOT_NORMAL;
  if (st.pendHash[0] && strcmp(runHash, st.pendHash) == 0) {
    if (strcmp(fw, st.pending) != 0) return BOOT_MISMATCH;
    if (st.attempts < 255) st.attempts++;
    return st.attempts > maxTrials ? BOOT_TOO_MANY : BOOT_TRIAL;
  }
  if (st.prevHash[0] && strcmp(runHash, st.prevHash) == 0) {
    copyStr(st.black, sizeof(st.black), st.pending);
    copyStr(st.lastSt, sizeof(st.lastSt), "rolled_back");
    copyStr(st.lastVer, sizeof(st.lastVer), st.pending);
    snprintf(st.lastMsg, sizeof(st.lastMsg), "v%s tidak berhasil menyala, robot kembali ke v%s", st.pending, fw);
    st.pending[0] = '\0';
    st.attempts = 0;
    return BOOT_ROLLED_BACK;
  }
  st.pending[0] = '\0';
  st.attempts = 0;
  return BOOT_STALE;
}

}  // namespace ota
