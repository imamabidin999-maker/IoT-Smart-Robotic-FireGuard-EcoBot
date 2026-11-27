/*
  EcoBot (robot penyapu) — firmware Arduino Uno
  ------------------------------------------------------------------
  Tugas Uno di robot ini:
    - baca 6 sensor ultrasonik HC-SR04 (Depan, Kiri-depan, Kanan-depan, Kiri, Kanan, Wadah)
    - gerakkan roda lewat L298N (manual dari dashboard, atau otomatis)
    - putar motor sapu (sikat) lewat modul relay, transistor TIP120, atau modul MOSFET di satu pin
    - angkat / turunkan sapu dengan mini servo
    - kirim telemetri JSON ke ESP (lewat Serial 57600) dan terima perintah teks

  Format pesan lengkap ada di docs/PROTOKOL.md, wiring di docs/WIRING.md.

  PENTING soal Serial: Uno cuma punya satu Serial hardware (pin 0/1) dan itu juga
  dipakai USB. Saat upload sketch, LEPAS kabel TX/RX ke ESP dulu, pasang lagi setelah selesai.

  Kenapa trigger ultrasonik dipasangkan? Uno hanya punya 20 pin, dan robot ini memakai semuanya:
  ESP 2, L298N 6, motor sapu 1, servo 1, baterai 1, ultrasonik 9. Enam HC-SR04 butuh 12 pin kalau
  sendiri-sendiri, jadi tiga pasang sensor berbagi satu pin TRIG. Pasangannya dipilih yang arahnya
  berjauhan (depan-wadah, kiri depan-kanan depan, kiri-kanan) supaya tidak saling mengganggu.
  Pengukuran tetap satu sensor per satu waktu (lihat usStep), jadi hasilnya tidak tercampur.

  Semua yang mungkin perlu Anda ubah ada di bagian KONFIGURASI paling atas. Nilai bawaannya
  sudah cocok dengan robot tim: 6 sensor ultrasonik, sapu lewat modul relay aktif-LOW,
  4 baterai seri lewat buck.
*/

#include <Servo.h>

// ==================================================================
//  KONFIGURASI
// ==================================================================
#define FW_VERSION      "2.2.0"
#define SERIAL_BAUD     57600

// ---- L298N (roda). Sisi kiri = channel A, sisi kanan = channel B ----
// Cabut jumper kecil di pin ENA & ENB modul L298N, lalu sambungkan ke D5 & D6.
#define PIN_ENA         5      // PWM
#define PIN_IN1         7
#define PIN_IN2         8
#define PIN_ENB         6      // PWM
#define PIN_IN3         9
#define PIN_IN4         10
#define INVERT_LEFT     0      // ganti 1 kalau roda kiri berputar terbalik
#define INVERT_RIGHT    0      // ganti 1 kalau roda kanan berputar terbalik

// ---- motor sapu (sikat berputar) ----
#define PIN_BRUSH       3      // ke IN modul relay / basis TIP120 (lewat 1 kΩ) / SIG modul MOSFET
#define BRUSH_USE_PWM   0      // 0 = modul relay (hanya nyala/mati). 1 = transistor atau MOSFET (kecepatan bisa diatur)
#define BRUSH_ACTIVE_HIGH 0    // hanya untuk relay: 0 = aktif-LOW (relay SONGLE 1 kanal). Relay aktif-HIGH -> 1
#define BRUSH_MIN_PCT   35     // di bawah ini motor sapu biasanya tidak kuat berputar
#define BRUSH_AUTO_PCT  70     // kecepatan sapu di mode otomatis (transistor/MOSFET): 70% dari 2 sel ±5,9 V, aman untuk motor 3-6 V
#define BRUSH_RAMP_MS   600UL  // dari 0 ke 100% dinaikkan pelan-pelan, supaya lonjakan arus tidak me-reset Uno

// ---- servo pengangkat sapu ----
#define PIN_LIFT        11
#define LIFT_DOWN_ANGLE 20     // sapu menyentuh lantai (sesuaikan dengan robot Anda)
#define LIFT_UP_ANGLE   80     // sapu terangkat

// ---- ultrasonik: 3 pin TRIG dipakai berpasangan, 6 pin ECHO terpisah ----
// indeks sensor: 0 Depan, 1 Kiri-depan, 2 Kanan-depan, 3 Kiri, 4 Kanan, 5 Wadah
#define US_COUNT        6
static const uint8_t US_TRIG[US_COUNT] = { 2, 4, 4, 12, 12, 2 };
static const uint8_t US_ECHO[US_COUNT] = { A0, A1, A2, A3, A4, 13 };
#define US_DEPAN        0
#define US_KIDEPAN      1
#define US_KADEPAN      2
#define US_KIRI         3
#define US_KANAN        4
#define US_WADAH        5

// ---- baterai ----
// Jumlah sel 18650 yang disusun SERI: 4 (14,8 V, wajib lewat buck untuk modul 5 V) atau 2 (7,4 V).
// Dengan 4 sel, PWM roda (dan sapu kalau memakai transistor/MOSFET) dibagi dua: kecepatan tetap
// seperti rancangan 2 sel dan motor TT tidak kelebihan tegangan. Samakan dengan BAT_CELLS di tes_motor.ino.
#define BAT_CELLS       4

// Sensor tegangan (opsional). Pasang pembagi tegangan dari + baterai ke A5, lalu ubah
// HAS_BATTERY_SENSE jadi 1. Kalau tidak dipasang, biarkan 0.
//   2 sel: 10k + 10k                      -> BAT_DIVIDER_X100 200
//   4 sel: 30k (mis. 3 x 10k seri) + 10k  -> BAT_DIVIDER_X100 400
#define HAS_BATTERY_SENSE 0
#define PIN_BATTERY     A5
#define BAT_DIVIDER_X100 200   // (R1+R2)/R2 x 100. Dua resistor sama = 200

// ---- cek kabel sensor ----
// 1 = Uno memeriksa apakah tiap sensor ultrasonik benar-benar tersambung. Sensor yang lepas
// terbaca "tidak ada benda", sama seperti ruangan kosong, padahal robot jadi buta di arah itu.
//   - kabel Echo lepas: pin Echo (pull-up) terbaca HIGH terus, tidak pernah kembali LOW
//   - sensor tidak menjawab (VCC, GND, atau Trig lepas): tidak ada pulsa sama sekali setelah dipicu
// Sensor yang bermasalah dilaporkan ke dashboard (ue di telemetri). Di mode otomatis robot berhenti
// kalau salah satu sensor depan (Depan, Kiri-depan, Kanan-depan) bermasalah.
#define SENSOR_CHECK    1
#define US_STUCK_MS     1000UL    // Echo HIGH terus selama ini = kabel Echo lepas
#define US_DEAD_COUNT   4         // berapa kali berturut-turut tanpa pulsa = sensor tidak menjawab

// ---- jarak (cm) ----
#define DETECT_CM       50     // benda dianggap "terdeteksi" (tampilan dashboard)
#define NEAR_CM         20     // depan / serong depan: sudah dekat
#define SIDE_NEAR_CM    10     // kiri / kanan: sudah dekat
// OBST_CM, DIAG_CM, TURN_PWM, dan SWEEP_PWM adalah nilai awal. Saat berjalan, ESP bridge bisa
// menggantinya lewat perintah CFG (lihat docs/OTA.md), jadi bisa diubah lewat update firmware ESP.
#define OBST_CM         22     // mode otomatis: benda di depan sedekat ini -> menghindar
#define DIAG_CM         18     // sama, untuk sensor serong kiri/kanan depan
#define SIDE_KEEP_CM    8      // mode otomatis: menjauh sedikit kalau samping sedekat ini
#define GUARD_CM        6      // mode manual: tahan gerak maju kalau ada benda sedekat ini di depan
#define MANUAL_COLLISION_GUARD 1
#define US_HYST_CM      3

// ---- wadah sampah ----
// Sensor Wadah dipasang di atas wadah, menghadap ke bawah ke dasar wadah.
#define BIN_EMPTY_CM    20     // jarak sensor ke dasar wadah saat kosong (ukur sendiri!)
#define BIN_FULL_CM     4      // jarak sensor ke permukaan sampah saat dianggap penuh
#define BIN_FULL_PCT    95     // di atas ini: menyapu otomatis berhenti

// ---- motor roda ----
#define MIN_PWM         70
#define DEFAULT_SPEED   160
#define SWEEP_PWM       110    // maju pelan saat menyapu supaya sampah sempat tersapu
#define STEER_PWM       35     // selisih kecepatan kiri-kanan saat menjauhi dinding samping
#define AVOID_PWM       130
#define TURN_PWM        130
// angka PWM di atas memakai skala 2 sel; dengan BAT_CELLS 4 yang dikirim ke L298N otomatis dibagi dua

// ---- waktu ----
#define DEADMAN_MS      600UL
#define LINE_IDLE_MS    500UL          // baris tanpa Enter (Serial Monitor "No line ending") dijalankan setelah jeda ini
#define TEL_EVERY_MS    250UL
#define US_STEP_MS      30UL           // satu sensor diukur tiap 30 ms -> semua 6 sensor ~180 ms
#define US_TIMEOUT_US   15000UL        // ~2,5 m
#define SERVO_STEP_DEG  3              // servo digerakkan bertahap supaya arus tidak melonjak
#define SERVO_STEP_MS   15UL
#define AVOID_BACK_MS   450UL          // mundur sebentar (tidak ada sensor belakang, jadi jangan lama)
#define TURN_MIN_MS     450UL          // lama berputar menghindar: acak di antara min..max
#define TURN_MAX_MS     1000UL
#define SWEEP_TURN_EVERY_MS 12000UL    // tiap sekian ms tanpa rintangan, belok acak supaya area lebih rata tersapu

#if BAT_CELLS < 2 || BAT_CELLS > 4
  #error "BAT_CELLS harus 2, 3, atau 4"
#endif
// sel penuh 4,2 V; setelah pembagi, A5 tidak boleh lebih dari 5 V
#if HAS_BATTERY_SENSE && (BAT_CELLS * 420L * 100L / BAT_DIVIDER_X100 > 500L)
  #error "Pembagi tegangan baterai terlalu kecil untuk BAT_CELLS ini: A5 bisa lebih dari 5 V. Lihat komentar BAT_DIVIDER_X100"
#endif

// ==================================================================
//  State
// ==================================================================
enum Mode : uint8_t { MODE_MANUAL = 0, MODE_AUTO = 1 };
enum State : uint8_t { ST_MANUAL, ST_SWEEP, ST_AVOID, ST_TURN, ST_FULL, ST_SENSOR };

static Mode  mode = MODE_MANUAL;     // EcoBot menyala dalam mode manual (tidak langsung jalan sendiri)
static State state = ST_MANUAL;
static unsigned long stateSince = 0;
static uint8_t substep = 0;
static int8_t  turnDir = 1;          // +1 kanan, -1 kiri
static unsigned long turnMs = 600;
static unsigned long lastTurn = 0;

// pembacaan ultrasonik: riwayat 3 nilai per sensor -> median
static int   usHist[US_COUNT][3];
static uint8_t usHistPos[US_COUNT];
static int   usDist[US_COUNT];       // cm, -1 = tidak ada pantulan / di luar jangkauan
static uint8_t usLvl[US_COUNT];      // 0 kosong, 1 terdeteksi, 2 dekat
static uint8_t usNext = 0;

#if SENSOR_CHECK
// 0 = baik, 1 = kabel Echo lepas (HIGH terus), 2 = sensor tidak menjawab (tidak ada pulsa)
static uint8_t usErr[US_COUNT];
static uint8_t usDeadCnt[US_COUNT];
static unsigned long usLowAt[US_COUNT];   // terakhir kali pin Echo terbaca LOW
#endif

static int   binPct = 0;
static int   binAcc16 = 0;           // binPct x 16, supaya penghalus tidak "macet" karena pembulatan

// Jarak menghindar dan PWM mode otomatis yang bisa diubah saat berjalan lewat perintah CFG.
static int   obstCm = OBST_CM, diagCm = DIAG_CM;
static int   turnPwm = TURN_PWM, sweepPwm = SWEEP_PWM;

static int   speedCap = DEFAULT_SPEED;
static int   manualX = 0, manualY = 0;
static unsigned long lastDrv = 0;
static int   lastSpeed = 0;
static int   outL = 0, outR = 0;     // PWM terakhir per sisi (-255..255), untuk pesan di Serial Monitor
static bool  drvHintDue = false;     // DRV baru saja menggerakkan robot dari diam

// sapu
static int   brushTarget = 0;        // 0..100 %
static int   brushOut = 0;           // 0..100 %, naik bertahap menuju brushTarget
static unsigned long lastBrushStep = 0;
static unsigned long brushOnMs = 0;  // total lama sapu berputar
static unsigned long lastBrushAcc = 0;

// pengangkat sapu
static Servo liftServo;
static bool  liftUpCmd = true;       // posisi istirahat: sapu terangkat
static int   liftCur = LIFT_UP_ANGLE;
static int   liftTarget = LIFT_UP_ANGLE;
static unsigned long lastServoStep = 0;

#if HAS_BATTERY_SENSE
static int   batMv = 0;
#endif
static unsigned long lastTel = 0;

static char  lineBuf[32];
static uint8_t lineLen = 0;
static bool  lineOverflow = false;
static unsigned long lastRxMs = 0;

// ==================================================================
//  Pesan untuk orang yang menguji lewat Serial Monitor
// ==================================================================
// Baris yang diawali '#' hanya untuk dibaca manusia. ESP bridge cuma meneruskan baris JSON
// (diawali '{'), jadi pesan ini tidak pernah sampai ke dashboard.
#define STR_(x) #x
#define XSTR(x) STR_(x)
enum Hint : uint8_t { H_NONE, H_AUTO, H_UNKNOWN, H_GUARD, H_FMT_MODE, H_FMT_DRV, H_FMT_SPD, H_FMT_BRUSH, H_FMT_LIFT, H_FMT_CFG };
static uint8_t lastHint = H_NONE;
static unsigned long lastHintMs = 0;

// pesan yang sama paling sering sekali per 2 detik, supaya Serial Monitor tidak banjir
// (mis. saat dashboard terus mengirim perintah yang ditolak, atau ada derau di jalur Serial)
static bool hintOk(uint8_t id, unsigned long now) {
  if (id == lastHint && now - lastHintMs < 2000UL) return false;
  lastHint = id; lastHintMs = now;
  return true;
}

static void hintAutoMode(unsigned long now) {
  if (hintOk(H_AUTO, now)) Serial.print(F("# Diabaikan: robot sedang mode OTOMATIS. Ketik MODE M dulu.\n"));
}

static void hintFormat(uint8_t id, const __FlashStringHelper* usage, unsigned long now) {
  if (!hintOk(id, now)) return;
  Serial.print(F("# Format: ")); Serial.print(usage); Serial.print('\n');
}

// tidak dibatasi: pesan ini hanya muncul saat robot mulai bergerak dari diam
static void hintDrive() {
  if (!outL && !outR) { Serial.print(F("# Roda tidak berputar: batas kecepatan SPD 0. Ketik misalnya SPD 200.\n")); return; }
  Serial.print(F("# Roda diperintah berputar: kiri ")); Serial.print(outL);
  Serial.print(F(", kanan "));                         Serial.print(outR);
  Serial.print(F(" (PWM, maks 255). Berhenti sendiri "));
  Serial.print(DEADMAN_MS);
  Serial.print(F(" ms setelah perintah terakhir.\n"));
}

static void hintGuard(unsigned long now) {
  if (!hintOk(H_GUARD, now)) return;
  Serial.print(F("# Maju ditahan: ada benda <= " XSTR(GUARD_CM) " cm di depan (cm: Depan "));
  Serial.print(usDist[US_DEPAN]);   Serial.print(F(", Kiri-depan "));
  Serial.print(usDist[US_KIDEPAN]); Serial.print(F(", Kanan-depan "));
  Serial.print(usDist[US_KADEPAN]); Serial.print(F("). Belok atau mundur dulu.\n"));
}

static void printHelp() {
  Serial.print(F("# Perintah: GET, INFO, MODE A (otomatis), MODE M (manual), STOP,\n"
                 "#   DRV x y (x belok, y maju, -100..100), SPD 0..255 (batas kecepatan),\n"
                 "#   BRUSH 0..100 (sapu), LIFT 0 (turunkan) / LIFT 1 (angkat),\n"
                 "#   CFG D depan serong (jarak menghindar, cm), CFG A putar maju (PWM otomatis). Huruf kecil juga boleh.\n"));
}

// ==================================================================
//  Motor roda
// ==================================================================
// v: PWM rancangan 2 sel (-255..255). Yang benar-benar dikirim ke L298N disesuaikan dengan BAT_CELLS.
static void driveSide(int v, uint8_t inA, uint8_t inB, uint8_t en) {
  long a = v < 0 ? -(long)v : v;
  if (a > 255) a = 255;
  a = a * 2 / BAT_CELLS;
  if (a > 255) a = 255;
  if (v > 0)      { digitalWrite(inA, HIGH); digitalWrite(inB, LOW);  analogWrite(en, (int)a); }
  else if (v < 0) { digitalWrite(inA, LOW);  digitalWrite(inB, HIGH); analogWrite(en, (int)a); }
  else            { digitalWrite(inA, LOW);  digitalWrite(inB, LOW);  analogWrite(en, 0); }
}

static void motorSet(int left, int right) {
  lastSpeed = max(abs(left), abs(right));
  outL = left; outR = right;
  if (INVERT_LEFT)  left  = -left;
  if (INVERT_RIGHT) right = -right;
  driveSide(left,  PIN_IN1, PIN_IN2, PIN_ENA);
  driveSide(right, PIN_IN3, PIN_IN4, PIN_ENB);
}

static void motorStop() { motorSet(0, 0); }

static int scalePwm(int v, int cap) {
  if (v == 0) return 0;
  int a = abs(v);
  int pwm;
  if (cap <= MIN_PWM) pwm = cap;
  else pwm = MIN_PWM + (int)(((long)(cap - MIN_PWM) * a) / 100L);
  if (pwm > 255) pwm = 255;
  return v > 0 ? pwm : -pwm;
}

static void driveVector(int x, int y, int cap) {
  int l = y + x;
  int r = y - x;
  int m = max(abs(l), abs(r));
  if (m > 100) { l = (int)((long)l * 100 / m); r = (int)((long)r * 100 / m); }
  motorSet(scalePwm(l, cap), scalePwm(r, cap));
}

// ==================================================================
//  Motor sapu
// ==================================================================
static void brushSet(int pct) {
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  if (pct > 0 && pct < BRUSH_MIN_PCT) pct = BRUSH_MIN_PCT;
  brushTarget = pct;
}

static void brushWrite(int pct) {
#if BRUSH_USE_PWM
  // persen memakai skala 2 sel, sama seperti roda
  analogWrite(PIN_BRUSH, (int)((long)pct * 255L * 2L / 100L / BAT_CELLS));
#else
  bool on = pct > 0;
  digitalWrite(PIN_BRUSH, (on == (BRUSH_ACTIVE_HIGH != 0)) ? HIGH : LOW);
#endif
}

static void brushUpdate(unsigned long now) {
  // hitung lama sapu berputar (untuk statistik di dashboard)
  if (brushOut > 0) brushOnMs += now - lastBrushAcc;
  lastBrushAcc = now;

  if (now - lastBrushStep < 20) return;
  lastBrushStep = now;
#if BRUSH_USE_PWM
  if (brushOut < brushTarget) {
    int step = (int)(100UL * 20UL / BRUSH_RAMP_MS);
    if (step < 1) step = 1;
    // mulai langsung dari kecepatan minimum supaya motor tidak berdengung di bawah ambang
    int next = brushOut == 0 ? BRUSH_MIN_PCT : brushOut + step;
    brushOut = next > brushTarget ? brushTarget : next;
  } else {
    brushOut = brushTarget;          // turun / mati: langsung
  }
#else
  brushOut = brushTarget;
#endif
  brushWrite(brushOut);
}

// ==================================================================
//  Servo pengangkat sapu (bergerak bertahap)
// ==================================================================
static void liftTo(bool up) { liftUpCmd = up; liftTarget = up ? LIFT_UP_ANGLE : LIFT_DOWN_ANGLE; }

static void servoUpdate(unsigned long now) {
  if (now - lastServoStep < SERVO_STEP_MS) return;
  lastServoStep = now;
  if (liftCur < liftTarget)      liftCur = min(liftCur + SERVO_STEP_DEG, liftTarget);
  else if (liftCur > liftTarget) liftCur = max(liftCur - SERVO_STEP_DEG, liftTarget);
  liftServo.write(liftCur);
}

// ==================================================================
//  Ultrasonik
// ==================================================================
// hasil pemeriksaan pengukuran terakhir: 1 = sensor menjawab, 0 = tidak ada pulsa, -1 = tidak bisa dinilai
static int8_t usAlive = -1;

static int usMeasure(uint8_t i) {
  uint8_t trig = US_TRIG[i], echo = US_ECHO[i];
  bool ready = digitalRead(echo) == LOW;   // tidak sedang mengirim pulsa (pin yang kabelnya lepas: HIGH)
  digitalWrite(trig, LOW);
  delayMicroseconds(3);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);
  unsigned long dur = pulseIn(echo, HIGH, US_TIMEOUT_US);
  // Sensor yang hidup selalu membalas dengan pulsa, juga saat tidak ada benda: pulsanya panjang dan
  // masih HIGH saat pulseIn berhenti menunggu. Tidak ada pulsa sama sekali padahal tadi siap =
  // sensor tidak menjawab. Kalau tadi belum siap (pulsa sebelumnya, atau sensor pasangan Trig yang
  // sama baru dipicu), hasilnya tidak dinilai.
  if (!ready) usAlive = -1;
  else usAlive = (dur > 0 || digitalRead(echo) == HIGH) ? 1 : 0;
  if (dur == 0) return -1;
  long cm = (long)(dur / 58UL);
  if (cm < 2 || cm > 400) return -1;
  return (int)cm;
}

static int median3(int a, int b, int c) {
  // nilai -1 (tidak valid) dianggap sangat jauh supaya mayoritas "tidak valid" tetap jadi tidak valid
  if (a < 0) a = 9999;
  if (b < 0) b = 9999;
  if (c < 0) c = 9999;
  int m;
  if ((a <= b && b <= c) || (c <= b && b <= a)) m = b;
  else if ((b <= a && a <= c) || (c <= a && a <= b)) m = a;
  else m = c;
  return m >= 9999 ? -1 : m;
}

static uint8_t usLevelOf(uint8_t i, uint8_t prev, int d) {
  if (d < 0) return 0;
  int near = (i == US_KIRI || i == US_KANAN) ? SIDE_NEAR_CM : NEAR_CM;
  int h = US_HYST_CM;
  if (d <= near || (prev == 2 && d <= near + h)) return 2;
  if (d <= DETECT_CM || (prev >= 1 && d <= DETECT_CM + h)) return 1;
  return 0;
}

#if SENSOR_CHECK
static const __FlashStringHelper* usName(uint8_t i) {
  switch (i) {
    case US_DEPAN:   return F("Depan");
    case US_KIDEPAN: return F("Kiri-depan");
    case US_KADEPAN: return F("Kanan-depan");
    case US_KIRI:    return F("Kiri");
    case US_KANAN:   return F("Kanan");
    default:         return F("Wadah");
  }
}

static void usCheck(uint8_t i, unsigned long now) {
  // Pin Echo sensor yang tersambung selalu kembali LOW di antara pengukuran
  for (uint8_t k = 0; k < US_COUNT; k++) if (digitalRead(US_ECHO[k]) == LOW) usLowAt[k] = now;
  uint8_t e = 0;
  if (now - usLowAt[i] >= US_STUCK_MS) {
    e = 1;
  } else {
    if (usAlive == 1) usDeadCnt[i] = 0;
    else if (usAlive == 0 && usDeadCnt[i] < US_DEAD_COUNT) usDeadCnt[i]++;
    if (usDeadCnt[i] >= US_DEAD_COUNT) e = 2;
  }
  if (e == usErr[i]) return;
  usErr[i] = e;
  Serial.print(F("# Sensor ")); Serial.print(usName(i));
  if (e == 1)      Serial.print(F(": pin Echo HIGH terus. Kabel Echo lepas?\n"));
  else if (e == 2) Serial.print(F(" tidak menjawab. Cek kabel VCC, GND, dan Trig.\n"));
  else             Serial.print(F(" tersambung lagi.\n"));
}

// sensor depan yang bermasalah membuat robot buta ke arah jalannya
static bool frontSensorErr() {
  return usErr[US_DEPAN] || usErr[US_KIDEPAN] || usErr[US_KADEPAN];
}
#else
static bool frontSensorErr() { return false; }
#endif

static void usStep(unsigned long now) {
  uint8_t i = usNext;
  usNext = (usNext + 1) % US_COUNT;

  int d = usMeasure(i);
#if SENSOR_CHECK
  usCheck(i, now);
#else
  (void)now;
#endif
  usHist[i][usHistPos[i]] = d;
  usHistPos[i] = (usHistPos[i] + 1) % 3;
  int med = median3(usHist[i][0], usHist[i][1], usHist[i][2]);
  usDist[i] = med;

  if (i == US_WADAH) {
    if (med >= 0) {
      long span = BIN_EMPTY_CM - BIN_FULL_CM;
      long pct = ((long)(BIN_EMPTY_CM - med) * 100L) / span;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      binAcc16 += ((int)pct * 16 - binAcc16) / 4;    // penghalus (rata-rata bergerak)
      binPct = (binAcc16 + 8) / 16;
    }
    usLvl[i] = 0;
    return;
  }
  usLvl[i] = usLevelOf(i, usLvl[i], med);
}

static bool validWithin(uint8_t i, int cm) { return usDist[i] >= 0 && usDist[i] <= cm; }
// jarak untuk membandingkan ruang kosong: tidak ada pantulan = sangat lega
static int space(uint8_t i) { return usDist[i] < 0 ? 999 : usDist[i]; }

// ==================================================================
//  Mode otomatis: menyapu sambil menghindari rintangan
// ==================================================================
static void enterState(State s, unsigned long now) { state = s; stateSince = now; substep = 0; }

static void startTurn(int8_t dir, unsigned long now, State s) {
  turnDir = dir;
  turnMs = (unsigned long)random((long)TURN_MIN_MS, (long)TURN_MAX_MS + 1);
  enterState(s, now);
}

// arah belok yang lebih lega: +1 kanan, -1 kiri
static int8_t freerSide() {
  int left = min(space(US_KIDEPAN), space(US_KIRI));
  int right = min(space(US_KADEPAN), space(US_KANAN));
  if (abs(left - right) < 5) return random(0, 2) ? 1 : -1;
  return right > left ? 1 : -1;
}

static void autoStep(unsigned long now) {
  if (frontSensorErr()) {
    // sensor depan lepas: robot tidak bisa melihat rintangan, jadi berhenti sampai tersambung lagi
    if (state != ST_SENSOR) enterState(ST_SENSOR, now);
    motorStop(); brushSet(0); liftTo(true);
    return;
  }
  if (state == ST_SENSOR) { enterState(ST_SWEEP, now); lastTurn = now; }

  if (binPct >= BIN_FULL_PCT) {
    if (state != ST_FULL) enterState(ST_FULL, now);
    motorStop(); brushSet(0); liftTo(true);
    return;
  }
  if (state == ST_FULL) { enterState(ST_SWEEP, now); lastTurn = now; }

  bool blocked = validWithin(US_DEPAN, obstCm) || validWithin(US_KIDEPAN, diagCm) || validWithin(US_KADEPAN, diagCm);

  switch (state) {
    case ST_SWEEP: {
      liftTo(false);
      if (abs(liftCur - LIFT_DOWN_ANGLE) <= 10) brushSet(BRUSH_AUTO_PCT);  // sapu baru berputar setelah benar-benar turun
      if (blocked) { motorStop(); startTurn(freerSide(), now, ST_AVOID); break; }
      if (now - lastTurn > SWEEP_TURN_EVERY_MS) { startTurn(random(0, 2) ? 1 : -1, now, ST_TURN); break; }
      int l = sweepPwm, r = sweepPwm;
      if (validWithin(US_KIRI, SIDE_KEEP_CM))       r -= STEER_PWM;        // terlalu dekat dinding kiri: belok kanan sedikit
      else if (validWithin(US_KANAN, SIDE_KEEP_CM)) l -= STEER_PWM;
      motorSet(l, r);
      break;
    }

    case ST_AVOID: {
      // mundur sebentar dengan sapu terangkat (supaya sampah tidak tertarik keluar), lalu putar ke sisi yang lega
      unsigned long t = now - stateSince;
      brushSet(0);
      liftTo(true);
      if (t < AVOID_BACK_MS) motorSet(-AVOID_PWM, -AVOID_PWM);
      else if (t < AVOID_BACK_MS + turnMs) motorSet(turnDir * turnPwm, -turnDir * turnPwm);
      else { enterState(ST_SWEEP, now); lastTurn = now; }
      break;
    }

    case ST_TURN: {
      // belok acak tanpa rintangan: sapu tetap menyapu
      if (blocked) { motorStop(); startTurn(freerSide(), now, ST_AVOID); break; }
      if (now - stateSince < turnMs) motorSet(turnDir * turnPwm, -turnDir * turnPwm);
      else { enterState(ST_SWEEP, now); lastTurn = now; }
      break;
    }

    default:
      enterState(ST_SWEEP, now);
      lastTurn = now;
  }
}

// ==================================================================
//  Mode manual
// ==================================================================
static void manualStep(unsigned long now) {
  if ((manualX != 0 || manualY != 0) && now - lastDrv > DEADMAN_MS) { manualX = 0; manualY = 0; }   // dead-man
  int y = manualY;
  bool blocked = false;
#if MANUAL_COLLISION_GUARD
  if (y > 0 && (validWithin(US_DEPAN, GUARD_CM) || validWithin(US_KIDEPAN, GUARD_CM) || validWithin(US_KADEPAN, GUARD_CM))) {
    y = 0; blocked = true;
  }
#endif
  driveVector(manualX, y, speedCap);
  if (blocked) hintGuard(now);
  else if (drvHintDue) hintDrive();
  drvHintDue = false;
}

static void setMode(Mode m, unsigned long now) {
  mode = m;
  manualX = manualY = 0;
  drvHintDue = false;
  motorStop();
  brushSet(0);
  liftTo(true);                        // posisi istirahat: sapu berhenti dan terangkat
  lastTurn = now;
  enterState(m == MODE_AUTO ? ST_SWEEP : ST_MANUAL, now);
}

// ==================================================================
//  Telemetri
// ==================================================================
static const char* stateName() {
  switch (state) {
    case ST_SWEEP: return "sweep";
    case ST_AVOID: return "avoid";
    case ST_TURN:  return "turn";
    case ST_FULL:  return "full";
    case ST_SENSOR: return "sensor";
    default:       return "manual";
  }
}

static void sendInfo() {
  Serial.print(F("{\"t\":\"info\",\"robot\":\"ecobot\",\"kind\":\"sweeper\",\"fw\":\"" FW_VERSION
                 "\",\"us\":[\"Depan\",\"Kiri-depan\",\"Kanan-depan\",\"Kiri\",\"Kanan\",\"Wadah\"]"
                 ",\"pins\":[\"A0\",\"A1\",\"A2\",\"A3\",\"A4\",\"D13\"],\"th\":{\"det\":"));
  Serial.print(DETECT_CM);       Serial.print(F(",\"near\":"));
  Serial.print(NEAR_CM);         Serial.print(F(",\"side\":"));
  Serial.print(SIDE_NEAR_CM);    Serial.print(F(",\"binE\":"));
  Serial.print(BIN_EMPTY_CM);    Serial.print(F(",\"binF\":"));
  Serial.print(BIN_FULL_CM);     Serial.print(F(",\"obst\":"));
  Serial.print(obstCm);          Serial.print(F(",\"diag\":"));
  Serial.print(diagCm);          Serial.print(F("},\"lift\":{\"up\":"));
  Serial.print(LIFT_UP_ANGLE);   Serial.print(F(",\"down\":"));
  Serial.print(LIFT_DOWN_ANGLE); Serial.print(F("},\"brush\":{\"pwm\":"));
  Serial.print(BRUSH_USE_PWM);   Serial.print(F(",\"min\":"));
  Serial.print(BRUSH_MIN_PCT);   Serial.print(F(",\"auto\":"));
  Serial.print(BRUSH_AUTO_PCT);  Serial.print(F("},\"spd\":{\"turn\":"));
  Serial.print(turnPwm);         Serial.print(F(",\"fwd\":"));
  Serial.print(sweepPwm);        Serial.print(F("},\"cfg\":1}\n"));
}

static void sendTelemetry(unsigned long now) {
  Serial.print(F("{\"t\":\"tel\",\"up\":")); Serial.print(now / 1000UL);
  Serial.print(F(",\"m\":\""));              Serial.print(mode == MODE_AUTO ? 'A' : 'M');
  Serial.print(F("\",\"st\":\""));           Serial.print(stateName());
  Serial.print(F("\",\"d\":["));
  for (uint8_t i = 0; i < US_COUNT; i++) { if (i) Serial.print(','); Serial.print(usDist[i]); }
  Serial.print(F("],\"l\":["));
  for (uint8_t i = 0; i < US_COUNT; i++) { if (i) Serial.print(','); Serial.print((int)usLvl[i]); }
  Serial.print(']');
#if SENSOR_CHECK
  Serial.print(F(",\"ue\":["));
  for (uint8_t i = 0; i < US_COUNT; i++) { if (i) Serial.print(','); Serial.print((int)usErr[i]); }
  Serial.print(']');
#endif
  Serial.print(F(",\"bin\":"));             Serial.print(binPct);
  Serial.print(F(",\"br\":"));               Serial.print(brushOut);
  Serial.print(F(",\"bt\":"));               Serial.print(brushTarget);
  Serial.print(F(",\"lf\":"));               Serial.print(liftUpCmd ? 1 : 0);
  Serial.print(F(",\"la\":"));               Serial.print(liftCur);
  Serial.print(F(",\"sw\":"));               Serial.print(brushOnMs / 1000UL);
  Serial.print(F(",\"sp\":"));               Serial.print(lastSpeed);
  Serial.print(F(",\"cap\":"));              Serial.print(speedCap);
#if HAS_BATTERY_SENSE
  Serial.print(F(",\"bat\":"));              Serial.print(batMv);
#endif
  Serial.print(F("}\n"));
}

// ==================================================================
//  Perintah dari dashboard (lewat ESP) atau Serial Monitor
// ==================================================================
static int clampi(long v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : (int)v); }

static void handleLine(char* line, unsigned long now) {
  char* cmd = strtok(line, " ");
  if (!cmd) return;
  char* a1 = strtok(NULL, " ");
  char* a2 = strtok(NULL, " ");
  char* a3 = strtok(NULL, " ");
  bool manual = (mode == MODE_MANUAL);

  if (!strcmp(cmd, "GET"))  { sendTelemetry(now); return; }
  if (!strcmp(cmd, "INFO")) { sendInfo(); sendTelemetry(now); return; }
  if (!strcmp(cmd, "HELP") || !strcmp(cmd, "?")) { printHelp(); return; }
  if (!strcmp(cmd, "PING")) return;                    // sudah dijawab ESP

  if (!strcmp(cmd, "MODE")) {
    if (a1 && a1[0] == 'A')      setMode(MODE_AUTO, now);
    else if (a1 && a1[0] == 'M') setMode(MODE_MANUAL, now);
    else { hintFormat(H_FMT_MODE, F("MODE A (otomatis) atau MODE M (manual)"), now); return; }
    sendTelemetry(now);
    return;
  }
  if (!strcmp(cmd, "DRV")) {
    if (!a1 || !a2) { hintFormat(H_FMT_DRV, F("DRV x y, x belok -100..100, y maju -100..100. Contoh: DRV 0 60"), now); return; }
    int x = clampi(atol(a1), -100, 100);
    int y = clampi(atol(a2), -100, 100);
    if (!manual) { if (x || y) hintAutoMode(now); return; }
    if ((x || y) && !manualX && !manualY) drvHintDue = true;   // mulai bergerak dari diam
    manualX = x; manualY = y;
    lastDrv = now;
    return;
  }
  if (!strcmp(cmd, "SPD")) {
    if (!a1) { hintFormat(H_FMT_SPD, F("SPD 0..255 (batas kecepatan). Contoh: SPD 200"), now); return; }
    speedCap = clampi(atol(a1), 0, 255);
    return;
  }
  if (!strcmp(cmd, "STOP")) {
    setMode(MODE_MANUAL, now);
    sendTelemetry(now);
    return;
  }
  if (!strcmp(cmd, "BRUSH")) {         // BRUSH <0..100>, 0 = mati
    if (!a1) { hintFormat(H_FMT_BRUSH, F("BRUSH 0..100, 0 = mati. Contoh: BRUSH 70"), now); return; }
    int pct = clampi(atol(a1), 0, 100);
    if (!manual) { if (pct) hintAutoMode(now); return; }
    brushSet(pct);
    sendTelemetry(now);
    return;
  }
  if (!strcmp(cmd, "LIFT")) {          // LIFT 1 = angkat, LIFT 0 = turunkan
    if (!a1) { hintFormat(H_FMT_LIFT, F("LIFT 0 (turunkan sapu) atau LIFT 1 (angkat)"), now); return; }
    if (!manual) { hintAutoMode(now); return; }
    liftTo(a1[0] == '1');
    sendTelemetry(now);
    return;
  }
  if (!strcmp(cmd, "CFG")) {
    // CFG D <depan> <serong> : jarak menghindar mode otomatis (cm)
    // CFG A <putar> <maju>   : PWM mode otomatis (berputar menghindar, maju menyapu)
    if (!a1 || !a2 || !a3) { hintFormat(H_FMT_CFG, F("CFG D 22 18 (jarak menghindar, cm), CFG A 130 110 (PWM otomatis)"), now); return; }
    long v1 = atol(a2), v2 = atol(a3);
    bool ok = true;
    if (a1[0] == 'D' && !a1[1]) {
      ok = v1 >= 5 && v1 <= 100 && v2 >= 5 && v2 <= 100;
      if (ok) { obstCm = (int)v1; diagCm = (int)v2; }
    } else if (a1[0] == 'A' && !a1[1]) {
      ok = v1 >= 0 && v1 <= 255 && v2 >= 0 && v2 <= 255;
      if (ok) { turnPwm = (int)v1; sweepPwm = (int)v2; }
    } else {
      hintFormat(H_FMT_CFG, F("CFG D 22 18 (jarak menghindar, cm), CFG A 130 110 (PWM otomatis)"), now);
      return;
    }
    if (!ok) {
      if (hintOk(H_FMT_CFG, now))
        Serial.print(F("# CFG ditolak: jarak 5..100 cm, PWM 0..255.\n"));
      return;
    }
    sendInfo();                          // ESP dan dashboard melihat nilai baru
    return;
  }
  if (hintOk(H_UNKNOWN, now)) {
    Serial.print(F("# Perintah tidak dikenal: ")); Serial.print(cmd);
    Serial.print(F(". Ketik HELP untuk daftar perintah.\n"));
  }
}

static void finishLine(unsigned long now) {
  if (lineLen > 0 && !lineOverflow) { lineBuf[lineLen] = '\0'; handleLine(lineBuf, now); }
  lineLen = 0; lineOverflow = false;
}

static void readSerial(unsigned long now) {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    lastRxMs = now;
    if (c == '\n' || c == '\r') {
      finishLine(now);
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c;   // huruf kecil juga diterima
    } else {
      lineOverflow = true;
    }
  }
  // Serial Monitor dengan pilihan "No line ending" tidak mengirim Enter: jalankan setelah jeda
  if ((lineLen > 0 || lineOverflow) && now - lastRxMs >= LINE_IDLE_MS) finishLine(now);
}

// ==================================================================
//  setup & loop
// ==================================================================
void setup() {
  pinMode(PIN_ENA, OUTPUT); pinMode(PIN_IN1, OUTPUT); pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_ENB, OUTPUT); pinMode(PIN_IN3, OUTPUT); pinMode(PIN_IN4, OUTPUT);
  brushWrite(0);                       // sapu harus mati dulu sebelum apa pun (ditulis sebelum pin jadi OUTPUT,
  pinMode(PIN_BRUSH, OUTPUT);          // supaya relay aktif-LOW tidak sempat menyala sesaat)
  motorStop();

  for (uint8_t i = 0; i < US_COUNT; i++) {
    pinMode(US_TRIG[i], OUTPUT);
    digitalWrite(US_TRIG[i], LOW);
    pinMode(US_ECHO[i], INPUT_PULLUP);   // sensor yang belum dipasang terbaca "tidak ada pantulan", bukan angka acak
    usDist[i] = -1;
#if SENSOR_CHECK
    usLowAt[i] = millis();
#endif
    for (uint8_t k = 0; k < 3; k++) usHist[i][k] = -1;
  }

  liftServo.attach(PIN_LIFT);
  liftServo.write(liftCur);

  Serial.begin(SERIAL_BAUD);
  randomSeed((unsigned long)analogRead(PIN_BATTERY) * 31UL + micros());

  unsigned long now = millis();
  setMode(MODE_MANUAL, now);
  // beberapa putaran awal supaya riwayat median terisi sebelum dipakai
  for (uint8_t i = 0; i < US_COUNT * 3; i++) usStep(millis());
  lastBrushAcc = millis();
  sendInfo();
  Serial.print(F("# EcoBot " FW_VERSION " siap, mode MANUAL.\n"
                 "# Uji dari Serial Monitor: DRV 0 60 (maju), DRV 60 0 (putar kanan), LIFT 0, BRUSH 70, STOP.\n"
                 "# HELP = daftar perintah.\n"));
}

void loop() {
  unsigned long now = millis();
  static unsigned long lastUs = 0;

  readSerial(now);

  if (now - lastUs >= US_STEP_MS) { lastUs = now; usStep(now); }

#if HAS_BATTERY_SENSE
  {
    unsigned long mv = (unsigned long)analogRead(PIN_BATTERY) * 5000UL / 1023UL * BAT_DIVIDER_X100 / 100UL;
    batMv = batMv == 0 ? (int)mv : (batMv * 15 + (int)mv) / 16;
  }
#endif

  if (mode == MODE_AUTO) autoStep(now);
  else                   manualStep(now);

  brushUpdate(now);
  servoUpdate(now);

  if (now - lastTel >= TEL_EVERY_MS) { lastTel = now; sendTelemetry(now); }
}
