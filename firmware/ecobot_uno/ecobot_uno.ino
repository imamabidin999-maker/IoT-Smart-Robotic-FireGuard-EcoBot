/*
  EcoBot — firmware Arduino Uno
  ------------------------------------------------------------------
  Tugas Uno di robot ini:
    - baca 6 sensor ultrasonik HC-SR04 (Depan, Belakang, Kiri, Kanan, Capit, Bin)
    - gerakkan motor lewat L298N (manual dari dashboard, atau otomatis)
    - gerakkan capit dan lengan (2 servo), jalankan urutan ambil sampah -> buang ke bin
    - kirim telemetri JSON ke ESP (lewat Serial 57600) dan terima perintah teks

  Format pesan lengkap ada di docs/PROTOKOL.md.

  PENTING soal Serial: Uno cuma punya satu Serial hardware (pin 0/1) dan itu juga
  dipakai USB. Saat upload sketch, LEPAS kabel TX/RX ke ESP dulu, pasang lagi setelah selesai.

  Kenapa trigger ultrasonik dipasangkan? Uno hanya punya 20 pin. 6 sensor x 2 pin = 12,
  ditambah L298N (6), servo (2), dan baterai (1) tidak muat. Solusinya tiga pasang sensor
  berbagi satu pin TRIG. Sensor dalam satu pasang sengaja dipilih yang arahnya saling
  membelakangi (depan-belakang, kiri-kanan, capit-bin) supaya tidak saling mengganggu.
  Pengukuran tetap satu sensor per satu waktu (lihat usStep), jadi hasilnya tidak tercampur.

  Semua yang mungkin perlu Anda ubah ada di bagian KONFIGURASI paling atas.
*/

#include <Servo.h>

// ==================================================================
//  KONFIGURASI
// ==================================================================
#define FW_VERSION      "1.0.0"
#define SERIAL_BAUD     57600

// ---- L298N. Sisi kiri = channel A, sisi kanan = channel B ----
#define PIN_ENA         5      // PWM
#define PIN_IN1         7
#define PIN_IN2         8
#define PIN_ENB         6      // PWM
#define PIN_IN3         9
#define PIN_IN4         10
#define INVERT_LEFT     0      // ganti 1 kalau roda kiri berputar terbalik
#define INVERT_RIGHT    0      // ganti 1 kalau roda kanan berputar terbalik

// ---- servo ----
#define PIN_CLAW        3
#define PIN_ARM         11
#define CLAW_OPEN_ANGLE   90   // sesuaikan dengan capit Anda (jangan sampai servo mentok & berdengung)
#define CLAW_CLOSED_ANGLE 25
#define ARM_DOWN_ANGLE    10   // lengan turun (posisi mengambil)
#define ARM_UP_ANGLE      150  // lengan naik melewati bin (posisi membuang)

// ---- ultrasonik: 3 pin TRIG dipakai berpasangan, 6 pin ECHO terpisah ----
// indeks sensor: 0 Depan, 1 Belakang, 2 Kiri, 3 Kanan, 4 Capit, 5 Bin
#define US_COUNT        6
static const uint8_t US_TRIG[US_COUNT] = { 2, 2, 4, 4, 12, 12 };
static const uint8_t US_ECHO[US_COUNT] = { A0, A1, A2, A3, A4, 13 };
#define US_DEPAN        0
#define US_BELAKANG     1
#define US_KIRI         2
#define US_KANAN        3
#define US_CAPIT        4
#define US_BIN          5

// ---- baterai (opsional) ----
// Pasang pembagi tegangan (2 resistor sama, mis. 10k + 10k) dari + baterai ke A5,
// lalu ubah HAS_BATTERY_SENSE jadi 1. Kalau tidak dipasang, biarkan 0.
#define HAS_BATTERY_SENSE 0
#define PIN_BATTERY     A5
#define BAT_DIVIDER_X100 200

// ---- jarak (cm) ----
#define DETECT_CM       60     // objek dianggap "terdeteksi"
#define REACH_CM        15     // sangat dekat (sensor Depan/Kiri/Kanan/Belakang)
#define GRAB_CM         12     // objek sudah di dalam jangkauan capit (sensor Capit)
#define OBSTACLE_CM     20     // di bawah ini & ada benda di samping -> dianggap dinding, bukan sampah
#define SIDE_WALL_CM    30
#define GUARD_CM        6      // mode manual: tahan gerak maju/mundur kalau sedekat ini
#define MANUAL_COLLISION_GUARD 1
#define US_HYST_CM      3
#define PICK_CONFIRM_MS 400UL  // objek harus terlihat stabil selama ini (robot berhenti) sebelum capit bergerak

// Ultrasonik tidak bisa membedakan sampah dari dinding. Dua cara membantu:
//  0 (bawaan): benda di depan DAN ada benda di samping (kiri/kanan) -> dianggap dinding/sudut ruangan.
//  1         : pasang sensor Depan LEBIH TINGGI dari sampah (mis. di atas bin). Sampah yang pendek lolos dari
//              sensor Depan dan hanya terlihat sensor Capit (rendah), sedangkan dinding/rintangan tinggi
//              terlihat keduanya -> dianggap rintangan.
#define DEPAN_SENSOR_HIGH 0

// ---- penampung sampah ----
// Sensor Bin dipasang di tepi atas bin, menghadap ke bawah.
#define BIN_EMPTY_CM    20     // jarak sensor ke dasar bin saat kosong (ukur sendiri!)
#define BIN_FULL_CM     4      // jarak sensor ke permukaan sampah saat dianggap penuh
#define BIN_FULL_PCT    95     // di atas ini: pemungutan otomatis berhenti

// ---- motor ----
#define MIN_PWM         70
#define DEFAULT_SPEED   160
#define ROAM_PWM        110
#define APPROACH_PWM    90
#define ALIGN_PWM       120
#define AVOID_PWM       130

// ---- waktu ----
#define DEADMAN_MS      600UL
#define TEL_EVERY_MS    250UL
#define US_STEP_MS      30UL           // satu sensor diukur tiap 30 ms -> semua 6 sensor ~180 ms
#define US_TIMEOUT_US   15000UL        // ~2,5 m
#define SERVO_STEP_DEG  4              // servo digerakkan bertahap supaya arus tidak melonjak
#define SERVO_STEP_MS   15UL
#define ROAM_TURN_EVERY_MS 7000UL      // tiap sekian ms, belok sebentar agar area tersapu
#define ROAM_TURN_MS    600UL

// ==================================================================
//  State
// ==================================================================
enum Mode : uint8_t { MODE_MANUAL = 0, MODE_AUTO = 1 };
enum State : uint8_t { ST_MANUAL, ST_ROAM, ST_APPROACH, ST_ALIGN, ST_AVOID, ST_PICK, ST_FULL };

static Mode  mode = MODE_MANUAL;     // EcoBot menyala dalam mode manual (tidak langsung jalan sendiri)
static State state = ST_MANUAL;
static unsigned long stateSince = 0;
static uint8_t substep = 0;
static int8_t  alignDir = 0;

// pembacaan ultrasonik: riwayat 3 nilai per sensor -> median
static int   usHist[US_COUNT][3];
static uint8_t usHistPos[US_COUNT];
static int   usDist[US_COUNT];       // cm, -1 = tidak ada pantulan / di luar jangkauan
static uint8_t usLvl[US_COUNT];      // 0 kosong, 1 terdeteksi, 2 jangkauan/dekat
static uint8_t usNext = 0;

static int   binPct = 0;
static int   binAcc16 = 0;           // binPct x 16, supaya penghalus tidak "macet" karena pembulatan
static int   binDist = -1;
static uint16_t pickCount = 0;

static int   speedCap = DEFAULT_SPEED;
static int   manualX = 0, manualY = 0;
static unsigned long lastDrv = 0;
static int   lastSpeed = 0;

static Servo clawServo, armServo;
static int   clawCur = CLAW_CLOSED_ANGLE, armCur = ARM_DOWN_ANGLE;
static int   clawTarget = CLAW_CLOSED_ANGLE, armTarget = ARM_DOWN_ANGLE;
static bool  clawClosedCmd = true, armUpCmd = false;
static unsigned long lastServoStep = 0;

static unsigned long pickStart = 0;
static unsigned long pickSince = 0;    // sejak kapan syarat "siap ambil" terpenuhi terus-menerus (0 = belum)
static uint8_t pickIdx = 0;
static unsigned long lastRoamTurn = 0;

#if HAS_BATTERY_SENSE
static int   batMv = 0;
#endif
static unsigned long lastTel = 0;

static char  lineBuf[32];
static uint8_t lineLen = 0;
static bool  lineOverflow = false;

// ==================================================================
//  Motor
// ==================================================================
static void driveSide(int v, uint8_t inA, uint8_t inB, uint8_t en) {
  if (v > 0)      { digitalWrite(inA, HIGH); digitalWrite(inB, LOW);  analogWrite(en, v > 255 ? 255 : v); }
  else if (v < 0) { digitalWrite(inA, LOW);  digitalWrite(inB, HIGH); analogWrite(en, -v > 255 ? 255 : -v); }
  else            { digitalWrite(inA, LOW);  digitalWrite(inB, LOW);  analogWrite(en, 0); }
}

static void motorSet(int left, int right) {
  lastSpeed = max(abs(left), abs(right));
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
//  Servo (bergerak bertahap)
// ==================================================================
static void servosUpdate(unsigned long now) {
  if (now - lastServoStep < SERVO_STEP_MS) return;
  lastServoStep = now;
  if (clawCur < clawTarget)      clawCur = min(clawCur + SERVO_STEP_DEG, clawTarget);
  else if (clawCur > clawTarget) clawCur = max(clawCur - SERVO_STEP_DEG, clawTarget);
  if (armCur < armTarget)        armCur = min(armCur + SERVO_STEP_DEG, armTarget);
  else if (armCur > armTarget)   armCur = max(armCur - SERVO_STEP_DEG, armTarget);
  clawServo.write(clawCur);
  armServo.write(armCur);
}

static void clawTo(bool closed) { clawClosedCmd = closed; clawTarget = closed ? CLAW_CLOSED_ANGLE : CLAW_OPEN_ANGLE; }
static void armTo(bool up)      { armUpCmd = up;          armTarget  = up ? ARM_UP_ANGLE : ARM_DOWN_ANGLE; }

// ==================================================================
//  Ultrasonik
// ==================================================================
static int usMeasure(uint8_t i) {
  uint8_t trig = US_TRIG[i];
  digitalWrite(trig, LOW);
  delayMicroseconds(3);
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);
  unsigned long dur = pulseIn(US_ECHO[i], HIGH, US_TIMEOUT_US);
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
  int reach = (i == US_CAPIT) ? GRAB_CM : REACH_CM;
  int h = US_HYST_CM;
  if (d <= reach || (prev == 2 && d <= reach + h)) return 2;
  if (d <= DETECT_CM || (prev >= 1 && d <= DETECT_CM + h)) return 1;
  return 0;
}

// Bin hanya diukur saat lengan di bawah dan tidak sedang mengambil (lengan di atas bin akan menghalangi sensor)
static bool binReadable() {
  return state != ST_PICK && armCur <= ARM_DOWN_ANGLE + 15;
}

static void usStep() {
  uint8_t i = usNext;
  usNext = (usNext + 1) % US_COUNT;

  int d = usMeasure(i);
  usHist[i][usHistPos[i]] = d;
  usHistPos[i] = (usHistPos[i] + 1) % 3;
  int med = median3(usHist[i][0], usHist[i][1], usHist[i][2]);

  if (i == US_BIN) {
    binDist = med;
    if (med >= 0 && binReadable()) {
      long span = BIN_EMPTY_CM - BIN_FULL_CM;
      long pct = ((long)(BIN_EMPTY_CM - med) * 100L) / span;
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      binAcc16 += ((int)pct * 16 - binAcc16) / 4;    // penghalus (rata-rata bergerak)
      binPct = (binAcc16 + 8) / 16;
    }
    usDist[i] = med;
    usLvl[i] = 0;
    return;
  }
  usDist[i] = med;
  usLvl[i] = usLevelOf(i, usLvl[i], med);
}

static bool validWithin(uint8_t i, int cm) { return usDist[i] >= 0 && usDist[i] <= cm; }

// ==================================================================
//  Urutan ambil sampah (tidak memblokir loop)
// ==================================================================
//  t=0      lengan turun, capit buka
//  t=900    capit menjepit
//  t=1600   lengan naik (ke atas bin)
//  t=2900   capit buka (sampah jatuh ke bin)
//  t=3600   lengan turun, capit tutup (posisi istirahat)
//  t=4400   selesai
static void startPick(unsigned long now) {
  state = ST_PICK; stateSince = now;
  pickStart = now; pickIdx = 0;
  motorStop();
}

static void pickStep(unsigned long now) {
  unsigned long t = now - pickStart;
  motorStop();
  switch (pickIdx) {
    case 0: armTo(false); clawTo(false); pickIdx = 1; break;
    case 1: if (t >= 900)  { clawTo(true);  pickIdx = 2; } break;
    case 2: if (t >= 1600) { armTo(true);   pickIdx = 3; } break;
    case 3: if (t >= 2900) { clawTo(false); pickIdx = 4; } break;
    case 4: if (t >= 3600) { armTo(false); clawTo(true); pickIdx = 5; } break;
    case 5:
      if (t >= 4400) {
        pickCount++;
        pickIdx = 0;
        state = (mode == MODE_AUTO) ? ST_ROAM : ST_MANUAL;
        stateSince = now;
        lastRoamTurn = now;
      }
      break;
  }
}

// ==================================================================
//  Mode otomatis
// ==================================================================
static void enterState(State s, unsigned long now) { state = s; stateSince = now; substep = 0; }

static void autoStep(unsigned long now) {
  if (state == ST_PICK) { pickStep(now); return; }

  if (binPct >= BIN_FULL_PCT) {
    if (state != ST_FULL) enterState(ST_FULL, now);
    motorStop();
    return;
  }
  if (state == ST_FULL) enterState(ST_ROAM, now);

  bool sideNear = validWithin(US_KIRI, SIDE_WALL_CM) || validWithin(US_KANAN, SIDE_WALL_CM);
  bool frontClose = validWithin(US_DEPAN, OBSTACLE_CM);
#if DEPAN_SENSOR_HIGH
  (void)sideNear;
  bool wallLike = frontClose;
  bool trashInReach = usLvl[US_CAPIT] == 2;
  bool trashSeen = usLvl[US_CAPIT] >= 1;
#else
  bool wallLike = sideNear && frontClose;
  bool trashInReach = usLvl[US_CAPIT] == 2 || usLvl[US_DEPAN] == 2;
  bool trashSeen = usLvl[US_DEPAN] >= 1 || usLvl[US_CAPIT] >= 1;
#endif

  // 1. objek sudah di jangkauan capit -> berhenti, pastikan bacaan stabil, lalu ambil
  if (trashInReach && !wallLike) {
    if (!pickSince) pickSince = now;
    motorStop();
    if (now - pickSince >= PICK_CONFIRM_MS) { pickSince = 0; startPick(now); }
    return;
  }
  pickSince = 0;

  // 2. dinding / benda besar di depan -> menghindar
  if (wallLike && state != ST_AVOID) { enterState(ST_AVOID, now); }

  switch (state) {
    case ST_ROAM:
      if (trashSeen) { enterState(ST_APPROACH, now); break; }
      if (usLvl[US_KIRI] >= 1)  { alignDir = -1; enterState(ST_ALIGN, now); break; }
      if (usLvl[US_KANAN] >= 1) { alignDir = 1;  enterState(ST_ALIGN, now); break; }
      if (now - lastRoamTurn > ROAM_TURN_EVERY_MS) {
        // belok sebentar ke kanan supaya area tersapu
        if (now - lastRoamTurn > ROAM_TURN_EVERY_MS + ROAM_TURN_MS) lastRoamTurn = now;
        motorSet(ALIGN_PWM, -ALIGN_PWM);
      } else {
        motorSet(ROAM_PWM, ROAM_PWM);
      }
      break;

    case ST_APPROACH:
      if (!trashSeen) {
        if (now - stateSince > 800) enterState(ST_ROAM, now);
        else motorSet(APPROACH_PWM, APPROACH_PWM);
      } else {
        stateSince = now;                      // masih melihat objek: reset timer "hilang"
        motorSet(APPROACH_PWM, APPROACH_PWM);
      }
      break;

    case ST_ALIGN: {
      bool sideGone = (alignDir < 0) ? usLvl[US_KIRI] == 0 : usLvl[US_KANAN] == 0;
      if (trashSeen) enterState(ST_APPROACH, now);
      else if (sideGone || now - stateSince > 2500) enterState(ST_ROAM, now);
      else motorSet(alignDir * ALIGN_PWM, -alignDir * ALIGN_PWM);    // putar di tempat menghadap objek
      break;
    }

    case ST_AVOID: {
      unsigned long t = now - stateSince;
      bool rearClear = !(validWithin(US_BELAKANG, GUARD_CM + 4));
      if (t < 500) {
        if (rearClear) motorSet(-AVOID_PWM, -AVOID_PWM); else motorStop();          // mundur sebentar
      } else if (t < 1150) {
        int8_t away = (usDist[US_KIRI] >= 0 && (usDist[US_KANAN] < 0 || usDist[US_KIRI] < usDist[US_KANAN])) ? 1 : -1;
        motorSet(away * AVOID_PWM, -away * AVOID_PWM);                              // putar menjauhi sisi yang lebih dekat
      } else {
        enterState(ST_ROAM, now);
        lastRoamTurn = now;
      }
      break;
    }

    default:
      enterState(ST_ROAM, now);
  }
}

// ==================================================================
//  Mode manual
// ==================================================================
static void manualStep(unsigned long now) {
  if (state == ST_PICK) { pickStep(now); return; }
  if ((manualX != 0 || manualY != 0) && now - lastDrv > DEADMAN_MS) { manualX = 0; manualY = 0; }   // dead-man
  int y = manualY;
#if MANUAL_COLLISION_GUARD
  if (y > 0 && validWithin(US_DEPAN, GUARD_CM)) y = 0;
  if (y < 0 && validWithin(US_BELAKANG, GUARD_CM)) y = 0;
#endif
  driveVector(manualX, y, speedCap);
}

static void setMode(Mode m, unsigned long now) {
  if (state == ST_PICK) { armTo(false); clawTo(true); }     // urutan dibatalkan: kembali ke posisi istirahat
  mode = m;
  manualX = manualY = 0;
  motorStop();
  pickIdx = 0;
  pickSince = 0;
  lastRoamTurn = now;
  enterState(m == MODE_AUTO ? ST_ROAM : ST_MANUAL, now);
}

// ==================================================================
//  Telemetri
// ==================================================================
static const char* stateName() {
  switch (state) {
    case ST_ROAM:     return "roam";
    case ST_APPROACH: return "approach";
    case ST_ALIGN:    return "align";
    case ST_AVOID:    return "avoid";
    case ST_PICK:     return "pick";
    case ST_FULL:     return "full";
    default:          return "manual";
  }
}

static void sendInfo() {
  Serial.print(F("{\"t\":\"info\",\"robot\":\"ecobot\",\"fw\":\"" FW_VERSION
                 "\",\"us\":[\"Depan\",\"Belakang\",\"Kiri\",\"Kanan\",\"Capit\",\"Bin\"]"
                 ",\"pins\":[\"A0\",\"A1\",\"A2\",\"A3\",\"A4\",\"D13\"],\"th\":{\"det\":"));
  Serial.print(DETECT_CM);   Serial.print(F(",\"reach\":"));
  Serial.print(REACH_CM);    Serial.print(F(",\"grab\":"));
  Serial.print(GRAB_CM);     Serial.print(F(",\"binE\":"));
  Serial.print(BIN_EMPTY_CM);Serial.print(F(",\"binF\":"));
  Serial.print(BIN_FULL_CM); Serial.print(F("},\"ang\":{\"clawOpen\":"));
  Serial.print(CLAW_OPEN_ANGLE);   Serial.print(F(",\"clawClosed\":"));
  Serial.print(CLAW_CLOSED_ANGLE); Serial.print(F(",\"armDown\":"));
  Serial.print(ARM_DOWN_ANGLE);    Serial.print(F(",\"armUp\":"));
  Serial.print(ARM_UP_ANGLE);      Serial.print(F("}}\n"));
}

static void sendTelemetry(unsigned long now) {
  Serial.print(F("{\"t\":\"tel\",\"up\":")); Serial.print(now / 1000UL);
  Serial.print(F(",\"m\":\""));              Serial.print(mode == MODE_AUTO ? 'A' : 'M');
  Serial.print(F("\",\"st\":\""));           Serial.print(stateName());
  Serial.print(F("\",\"d\":["));
  for (uint8_t i = 0; i < US_COUNT; i++) { if (i) Serial.print(','); Serial.print(usDist[i]); }
  Serial.print(F("],\"l\":["));
  for (uint8_t i = 0; i < US_COUNT; i++) { if (i) Serial.print(','); Serial.print((int)usLvl[i]); }
  Serial.print(F("],\"bin\":"));             Serial.print(binPct);
  Serial.print(F(",\"cl\":"));               Serial.print(clawClosedCmd ? 1 : 0);
  Serial.print(F(",\"ar\":"));               Serial.print(armUpCmd ? 1 : 0);
  Serial.print(F(",\"ca\":"));               Serial.print(clawCur);
  Serial.print(F(",\"aa\":"));               Serial.print(armCur);
  Serial.print(F(",\"n\":"));                Serial.print(pickCount);
  Serial.print(F(",\"sp\":"));               Serial.print(lastSpeed);
  Serial.print(F(",\"cap\":"));              Serial.print(speedCap);
#if HAS_BATTERY_SENSE
  Serial.print(F(",\"bat\":"));              Serial.print(batMv);
#endif
  Serial.print(F("}\n"));
}

// ==================================================================
//  Perintah dari dashboard (lewat ESP)
// ==================================================================
static int clampi(long v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : (int)v); }

static void handleLine(char* line, unsigned long now) {
  char* cmd = strtok(line, " ");
  if (!cmd) return;
  char* a1 = strtok(NULL, " ");
  char* a2 = strtok(NULL, " ");

  if (!strcmp(cmd, "GET"))  { sendTelemetry(now); return; }
  if (!strcmp(cmd, "INFO")) { sendInfo(); sendTelemetry(now); return; }

  if (!strcmp(cmd, "MODE") && a1) {
    if (a1[0] == 'A')      setMode(MODE_AUTO, now);
    else if (a1[0] == 'M') setMode(MODE_MANUAL, now);
    sendTelemetry(now);
    return;
  }
  if (!strcmp(cmd, "DRV") && a1 && a2) {
    if (mode == MODE_MANUAL) {
      manualX = clampi(atol(a1), -100, 100);
      manualY = clampi(atol(a2), -100, 100);
      lastDrv = now;
    }
    return;
  }
  if (!strcmp(cmd, "SPD") && a1) { speedCap = clampi(atol(a1), 0, 255); return; }
  if (!strcmp(cmd, "STOP")) {
    setMode(MODE_MANUAL, now);
    clawTarget = clawCur;           // berhenti di posisi sekarang
    armTarget = armCur;
    sendTelemetry(now);
    return;
  }
  if (!strcmp(cmd, "CLAW") && a1) { if (mode == MODE_MANUAL && state != ST_PICK) clawTo(a1[0] == '1'); return; }
  if (!strcmp(cmd, "ARM")  && a1) { if (mode == MODE_MANUAL && state != ST_PICK) armTo(a1[0] == '1');  return; }
  if (!strcmp(cmd, "PICK")) {
    if (state != ST_PICK && binPct < BIN_FULL_PCT) startPick(now);
    sendTelemetry(now);
    return;
  }
}

static void readSerial(unsigned long now) {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen > 0 && !lineOverflow) { lineBuf[lineLen] = '\0'; handleLine(lineBuf, now); }
      lineLen = 0; lineOverflow = false;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineOverflow = true;
    }
  }
}

// ==================================================================
//  setup & loop
// ==================================================================
void setup() {
  pinMode(PIN_ENA, OUTPUT); pinMode(PIN_IN1, OUTPUT); pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_ENB, OUTPUT); pinMode(PIN_IN3, OUTPUT); pinMode(PIN_IN4, OUTPUT);
  motorStop();

  for (uint8_t i = 0; i < US_COUNT; i++) {
    pinMode(US_TRIG[i], OUTPUT);
    digitalWrite(US_TRIG[i], LOW);
    pinMode(US_ECHO[i], INPUT);
    usDist[i] = -1;
    for (uint8_t k = 0; k < 3; k++) usHist[i][k] = -1;
  }

  clawServo.attach(PIN_CLAW);
  armServo.attach(PIN_ARM);
  clawServo.write(clawCur);
  armServo.write(armCur);

  Serial.begin(SERIAL_BAUD);

  unsigned long now = millis();
  setMode(MODE_MANUAL, now);
  // beberapa putaran awal supaya riwayat median terisi sebelum dipakai
  for (uint8_t i = 0; i < US_COUNT * 3; i++) usStep();
  sendInfo();
}

void loop() {
  unsigned long now = millis();
  static unsigned long lastUs = 0;

  readSerial(now);

  if (now - lastUs >= US_STEP_MS) { lastUs = now; usStep(); }

#if HAS_BATTERY_SENSE
  {
    unsigned long mv = (unsigned long)analogRead(PIN_BATTERY) * 5000UL / 1023UL * BAT_DIVIDER_X100 / 100UL;
    batMv = batMv == 0 ? (int)mv : (batMv * 15 + (int)mv) / 16;
  }
#endif

  if (mode == MODE_AUTO) autoStep(now);
  else                   manualStep(now);

  servosUpdate(now);

  if (now - lastTel >= TEL_EVERY_MS) { lastTel = now; sendTelemetry(now); }
}
