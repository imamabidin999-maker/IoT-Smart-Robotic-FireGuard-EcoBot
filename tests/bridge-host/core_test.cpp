// Uji unit ota_core.h dan ota_crypto.h (tanpa ESP32 palsu). Dijalankan oleh core.test.mjs.
// Argumen opsional: <kunci-publik.pem> <pesan> <tanda-tangan-hex> untuk memeriksa tanda tangan
// buatan tools/ota/otasign.py dengan mbedTLS (library yang sama dengan di ESP32).
#include <cassert>
#include <cstdio>
#include <string>
#include <fstream>
#include <sstream>
#include "ota_core.h"
#include "ota_crypto.h"

static int fails = 0;
#define CHECK(c) do { if (!(c)) { printf("GAGAL baris %d: %s\n", __LINE__, #c); fails++; } } while (0)

int main(int argc, char** argv) {
  using namespace ota;

  // ---- versi ----
  SemVer a, b;
  CHECK(parseSemVer("1.10.0", a) && parseSemVer("1.9.0", b) && cmpSemVer(a, b) > 0);
  CHECK(cmpVersion("1.2.1", "1.2.0") == 1);
  CHECK(cmpVersion("1.2.0", "1.2.0") == 0);
  CHECK(cmpVersion("0.9.9", "1.0.0") == -1);
  CHECK(!parseSemVer("1.2", a));
  CHECK(!parseSemVer("1.2.3 ", a));
  CHECK(!parseSemVer("v1.2.3", a));
  CHECK(!parseSemVer("1.2.-3", a));
  CHECK(!parseSemVer("123456.0.0", a));
  CHECK(cmpVersion("1.2", "1.0.0") == -2);

  // ---- hex ----
  uint8_t buf[8];
  CHECK(hexDecode("00ff10", buf, sizeof(buf)) == 3 && buf[1] == 0xff);
  CHECK(hexDecode("0f1", buf, sizeof(buf)) == 0);
  CHECK(hexDecode("zz", buf, sizeof(buf)) == 0);
  CHECK(hexEqual("ABcd", "abCD") && !hexEqual("abcd", "abce") && !hexEqual("ab", "abcd"));
  char hx[17];
  uint8_t raw[3] = {0x01, 0xab, 0xff};
  hexEncode(raw, 3, hx);
  CHECK(std::string(hx) == "01abff");

  // ---- penanda FWID, termasuk yang terpotong di batas potongan data ----
  {
    const char* data = "xxFWIDFWID:fireguard-bridge:1.2.3;yyFWID:lain:9.9.9;";
    for (size_t cut = 0; cut <= strlen(data); cut++) {
      MarkerScanner m;
      m.reset();
      m.feed((const uint8_t*)data, cut);
      m.feed((const uint8_t*)data + cut, strlen(data) - cut);
      CHECK(m.found() && std::string(m.product()) == "fireguard-bridge" && std::string(m.version()) == "1.2.3");
    }
    MarkerScanner m;
    m.reset();
    const char* bad = "FWID:\0FWID:Besar:1.0.0;FWID:ok:1.2;FWID:ok:1.2.3.4;";
    m.feed((const uint8_t*)bad, 52);
    CHECK(!m.found());
  }

  // ---- manifest ----
  {
    const char* js = R"({"product":"fireguard-bridge","board":"esp32","latest":{"version":"1.3.0","url":"http://x/a.bin",
      "md5":"0123456789abcdef0123456789abcdef","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","size":1000,"min_uno":"1.4.0"}})";
    Manifest m;
    char err[160];
    CHECK(parseManifest(js, strlen(js), "fireguard-bridge", "esp32", m, err, sizeof(err)));
    CHECK(m.latest.ok && m.latest.size == 1000 && !m.stable.ok);
    CHECK(!parseManifest(js, strlen(js), "ecobot-bridge", "esp32", m, err, sizeof(err)) && strstr(err, "ecobot-bridge"));
    CHECK(!parseManifest(js, strlen(js), "fireguard-bridge", "esp8266", m, err, sizeof(err)));
    CHECK(!parseManifest("{rusak", 6, "fireguard-bridge", "esp32", m, err, sizeof(err)) && strstr(err, "JSON"));
    parseManifest(js, strlen(js), "fireguard-bridge", "esp32", m, err, sizeof(err));
    char msg[200];
    CHECK(judgeUpdate(m.latest, "1.2.0", "", "1.4.0", 0x140000, false, msg, sizeof(msg)) == UPD_AVAILABLE);
    CHECK(judgeUpdate(m.latest, "1.3.0", "", "1.4.0", 0x140000, false, msg, sizeof(msg)) == UPD_UP_TO_DATE);
    CHECK(judgeUpdate(m.latest, "1.2.0", "1.3.0", "1.4.0", 0x140000, false, msg, sizeof(msg)) == UPD_BLACKLISTED);
    CHECK(judgeUpdate(m.latest, "1.2.0", "", "1.3.9", 0x140000, false, msg, sizeof(msg)) == UPD_NEEDS_UNO);
    CHECK(judgeUpdate(m.latest, "1.2.0", "", "", 0x140000, false, msg, sizeof(msg)) == UPD_NEEDS_UNO);
    CHECK(judgeUpdate(m.latest, "1.2.0", "", "1.4.0", 500, false, msg, sizeof(msg)) == UPD_TOO_BIG);
    CHECK(judgeUpdate(m.latest, "1.2.0", "", "1.4.0", 0x140000, true, msg, sizeof(msg)) == UPD_UNSIGNED);
  }

  // ---- syarat update & health check dari telemetri ----
  {
    RobotSnap s;
    uint32_t t = 10000;
    CHECK(gateProblem(s, t, true, 0) != nullptr);          // belum ada data Uno
    CHECK(gateProblem(s, t, false, 0) == nullptr);         // boleh kalau Uno memang tidak wajib
    const char* tel = R"({"t":"tel","up":9,"m":"M","st":"manual","fl":[800,790],"fs":[0,0],"gs":[150,160],"gl":[0,0],"gw":0,"fe":[0,0],"ge":[0,0],"p":0,"sp":0,"cap":160,"bat":14200})";
    for (int i = 0; i < 3; i++) CHECK(parseUnoLine(tel, s, t));
    CHECK(gateProblem(s, t, true, 0) == nullptr);
    CHECK(gateProblem(s, t, true, 14800) != nullptr);      // baterai di bawah batas
    CHECK(gateProblem(s, t + 5000, true, 0) != nullptr);   // telemetri kedaluwarsa
    const char* info = R"({"t":"info","robot":"fireguard","fw":"1.4.0","flame":["Kiri","Kanan"],"gas":["MQ-2 #1","MQ-2 #2"],"th":{"fw":700,"fd":400,"gw":350,"gd":550},"spd":{"turn":150,"fwd":140},"cfg":1})";
    CHECK(parseUnoLine(info, s, t));
    HealthInput in;
    in.robot = "fireguard";
    char msg[200];
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 0);
    in.wantTh[0] = 650;
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 1 && strstr(msg, "ambang"));
    in.wantTh[0] = 0;
    in.robot = "ecobot";
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 1 && strstr(msg, "bukan 'ecobot'"));
    in.robot = "fireguard";
    const char* tel2 = R"({"t":"tel","m":"M","fl":[800,790],"gs":[150,0],"gw":0,"fe":[1,0],"ge":[0,0],"p":0,"sp":0})";
    parseUnoLine(tel2, s, t);
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 2 && strstr(msg, "Kiri tidak tersambung") && strstr(msg, "MQ-2 #2 terbaca 0"));
    CHECK(!parseUnoLine("{\"t\":\"pong\"}", s, t) && !parseUnoLine("bukan json", s, t));
  }

  // ---- EcoBot: 6 sensor ultrasonik, status ue, jarak menghindar ----
  {
    RobotSnap s;
    uint32_t t = 20000;
    const char* info = R"({"t":"info","robot":"ecobot","kind":"sweeper","fw":"2.2.0","us":["Depan","Kiri-depan","Kanan-depan","Kiri","Kanan","Wadah"],"th":{"det":50,"near":20,"side":10,"binE":20,"binF":4,"obst":22,"diag":18},"brush":{"pwm":0,"min":35,"auto":70},"spd":{"turn":130,"fwd":110},"cfg":1})";
    const char* tel = R"({"t":"tel","m":"M","st":"manual","d":[80,-1,100,60,70,15],"l":[0,0,0,0,0,0],"ue":[0,0,0,0,0,0],"bin":0,"br":0,"sp":0,"cap":160})";
    CHECK(parseUnoLine(info, s, t));
    for (int i = 0; i < 3; i++) CHECK(parseUnoLine(tel, s, t));
    CHECK(isEcoBot(s) && s.haveTh && s.th[0] == 22 && s.th[1] == 18 && s.spd[0] == 130 && s.spd[1] == 110);
    CHECK(s.haveUe && s.nUe == 6 && !strcmp(s.usLbl[1], "Kiri-depan") && !strcmp(s.usLbl[2], "Kanan-depan"));
    HealthInput in;
    in.robot = "ecobot";
    char msg[200];
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 0);      // -1 di sensor depan = ruangan kosong, bukan masalah
    in.wantTh[0] = 30;
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 1 && strstr(msg, "jarak menghindar"));
    in.wantTh[0] = 0;
    const char* tel2 = R"({"t":"tel","m":"M","d":[-1,80,100,60,70,15],"ue":[1,0,2,0,0,0],"br":0,"sp":0})";
    parseUnoLine(tel2, s, t);
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 2 && strstr(msg, "Depan tidak tersambung (kabel Echo lepas?)") &&
          strstr(msg, "Kanan-depan tidak menjawab"));
    const char* tel3 = R"({"t":"tel","m":"M","d":[80,80,100,60,70,-1],"ue":[0,0,0,0,0,2],"br":0,"sp":0})";
    parseUnoLine(tel3, s, t);
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 1 && strstr(msg, "Wadah tidak menjawab"));   // tidak dobel
    const char* telOld = R"({"t":"tel","m":"M","d":[80,80,100,60,70,-1],"br":0,"sp":0})";        // Uno 2.1.0 tanpa ue
    parseUnoLine(telOld, s, t);
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 1 && strstr(msg, "Wadah tidak membaca apa pun"));
    s.cfg = false;
    in.wantSpd[0] = 150;
    CHECK(healthProblems(s, t, in, msg, sizeof(msg)) == 2 && strstr(msg, "perlu ecobot_uno 2.2.0"));
    const char* tel4 = R"({"t":"tel","m":"M","d":[80,80,100,60,70,15],"br":70,"sp":0})";
    parseUnoLine(tel4, s, t);
    CHECK(gateProblem(s, t, true, 0) != nullptr && strstr(gateProblem(s, t, true, 0), "Sapu"));
  }

  // ---- keputusan saat boot ----
  {
    OtaState st;
    copyStr(st.pending, sizeof(st.pending), "1.3.0");
    copyStr(st.pendHash, sizeof(st.pendHash), "aaaa");
    copyStr(st.prevHash, sizeof(st.prevHash), "bbbb");
    CHECK(decideBoot(st, "1.3.0", "aaaa", 3) == BOOT_TRIAL && st.attempts == 1);
    CHECK(decideBoot(st, "1.3.0", "aaaa", 3) == BOOT_TRIAL && st.attempts == 2);
    CHECK(decideBoot(st, "1.3.0", "aaaa", 3) == BOOT_TRIAL && st.attempts == 3);
    CHECK(decideBoot(st, "1.3.0", "aaaa", 3) == BOOT_TOO_MANY);
    OtaState s2 = st;
    CHECK(decideBoot(s2, "1.2.1", "aaaa", 3) == BOOT_MISMATCH);
    OtaState s3 = st;
    CHECK(decideBoot(s3, "1.2.0", "bbbb", 3) == BOOT_ROLLED_BACK && std::string(s3.black) == "1.3.0" && !s3.pending[0]);
    OtaState s4 = st;
    CHECK(decideBoot(s4, "1.5.0", "cccc", 3) == BOOT_STALE && !s4.pending[0] && !s4.black[0]);
    OtaState s5;
    CHECK(decideBoot(s5, "1.0.0", "x", 3) == BOOT_NORMAL);
  }

  // ---- pesan yang ditandatangani harus sama persis dengan publish_fw.py ----
  {
    char m[200];
    signMessage(m, sizeof(m), "fireguard-bridge", "esp32", "1.2.0", 123456, "ab");
    CHECK(std::string(m) == "KOPAK-OTA1|fireguard-bridge|esp32|1.2.0|123456|ab");
  }

  // ---- tanda tangan dari otasign.py diperiksa mbedTLS ----
  if (argc == 4) {
    std::ifstream f(argv[1]);
    std::stringstream ss;
    ss << f.rdbuf();
    std::string pem = ss.str();
    CHECK(keyConfigured(pem.c_str()));
    CHECK(verifySignature(pem.c_str(), argv[2], argv[3]) == 0);
    std::string other = std::string(argv[2]) + "x";
    CHECK(verifySignature(pem.c_str(), other.c_str(), argv[3]) != 0);
    std::string sig = argv[3];
    sig[sig.size() - 1] = sig[sig.size() - 1] == '0' ? '1' : '0';
    CHECK(verifySignature(pem.c_str(), argv[2], sig.c_str()) != 0);
    CHECK(verifySignature(pem.c_str(), argv[2], "zz") != 0);
    CHECK(!keyConfigured(""));
  }

  printf(fails ? "GAGAL %d\n" : "OK\n", fails);
  return fails ? 1 : 0;
}
