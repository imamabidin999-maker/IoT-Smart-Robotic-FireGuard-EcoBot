/*
  FireGuard — firmware Arduino Uno
  ------------------------------------------------------------------
  Tugas Uno di robot ini:
    - baca sensor api (IR flame) dan gas (MQ-2)
    - gerakkan motor lewat L298N (manual dari dashboard, atau otomatis)
    - nyalakan pompa air dan arahkan servo nozzle
    - kirim telemetri JSON ke ESP (lewat Serial 57600) dan terima perintah teks

  Format pesan lengkap ada di docs/PROTOKOL.md.

  PENTING soal Serial: Uno cuma punya satu Serial hardware (pin 0/1) dan itu juga
  dipakai USB. Saat upload sketch, LEPAS kabel TX/RX ke ESP dulu, pasang lagi setelah selesai.

  Semua yang mungkin perlu Anda ubah ada di bagian KONFIGURASI paling atas.
*/

#include <Servo.h>

// ==================================================================
//  KONFIGURASI
// ==================================================================
#define FW_VERSION      "1.0.0"
#define SERIAL_BAUD     57600

// ---- jumlah sensor yang terpasang ----
#define FLAME_COUNT     2      // 2 (Kiri, Kanan) atau 3 (Kiri, Depan, Kanan)
#define GAS_COUNT       1      // 1 atau 2

// ---- pin ----
// Sensor api (output analog AO), urutan: Kiri, Depan/Kanan, Kanan
static const uint8_t FLAME_PINS[3] = { A0, A1, A2 };
// Sensor gas MQ-2 (output analog AO)
static const uint8_t GAS_PINS[2]   = { A3, A4 };

// L298N. Sisi kiri = channel A (OUT1/OUT2), sisi kanan = channel B (OUT3/OUT4).
// Dua motor di tiap sisi dipasang paralel ke channel yang sama.
#define PIN_ENA         5      // PWM
#define PIN_IN1         7
#define PIN_IN2         8
#define PIN_ENB         6      // PWM
#define PIN_IN3         9
#define PIN_IN4         10
#define INVERT_LEFT     0      // ganti 1 kalau roda kiri berputar terbalik
#define INVERT_RIGHT    0      // ganti 1 kalau roda kanan berputar terbalik

#define PIN_NOZZLE      11     // servo nozzle
#define PIN_PUMP        4      // ke modul relay / MOSFET pompa (BUKAN langsung ke pompa)
#define PUMP_ACTIVE_HIGH 1     // modul relay biasanya aktif LOW -> ganti jadi 0

// ---- baterai (opsional) ----
// Pasang pembagi tegangan (2 resistor sama, mis. 10k + 10k) dari + baterai ke A5,
// lalu ubah HAS_BATTERY_SENSE jadi 1. Kalau tidak dipasang, biarkan 0.
#define HAS_BATTERY_SENSE 0
#define PIN_BATTERY     A5
#define BAT_DIVIDER_X100 200   // (R1+R2)/R2 x 100. Dua resistor sama = 200

// ---- ambang sensor (nilai ADC 0..1023) ----
// Sensor api: NILAI KECIL = api kuat/dekat. Atur potensio di modul sensor dulu.
#define FLAME_WARN      700
#define FLAME_DANGER    400
// Sensor gas: NILAI BESAR = gas/asap tinggi. Kalibrasi di udara bersih dulu.
#define GAS_WARN        350
#define GAS_DANGER      550
#define HYSTERESIS      40
#define GAS_WARMUP_MS   20000UL   // MQ-2 butuh pemanasan

// ---- nozzle & pompa ----
#define NOZ_MIN         40
#define NOZ_MAX         140
#define NOZ_HOME        90
#define NOZ_SWEEP       25        // ayunan kiri-kanan saat menyemprot (derajat)
#define PUMP_MAX_ON_MS  15000UL   // pompa tidak dinyalakan terus-menerus lebih lama dari ini
#define PUMP_REST_MS    3000UL    // jeda pendingin setelah mencapai batas

// ---- motor ----
#define MIN_PWM         70        // di bawah ini motor biasanya cuma berdengung
#define DEFAULT_SPEED   160       // batas kecepatan manual awal (0..255)
#define AUTO_TURN_PWM   150
#define AUTO_FWD_PWM    140

// ---- waktu ----
#define DEADMAN_MS      600UL     // perintah DRV/PUMP harus diperbarui lebih sering dari ini
#define TEL_EVERY_MS    250UL
#define SENSOR_EVERY_MS 40UL

// ==================================================================
//  Label sensor (dikirim ke dashboard lewat pesan info)
// ==================================================================
#if FLAME_COUNT == 2
  #define FLAME_LABELS_JSON "[\"Kiri\",\"Kanan\"]"
  #define FLAME_PINS_JSON   "[\"A0\",\"A1\"]"
  static const int8_t FLAME_POS[FLAME_COUNT] = { -1, 1 };     // posisi untuk menentukan arah belok
#elif FLAME_COUNT == 3
  #define FLAME_LABELS_JSON "[\"Kiri\",\"Depan\",\"Kanan\"]"
  #define FLAME_PINS_JSON   "[\"A0\",\"A1\",\"A2\"]"
  static const int8_t FLAME_POS[FLAME_COUNT] = { -1, 0, 1 };
#else
  #error "FLAME_COUNT harus 2 atau 3"
#endif

#if GAS_COUNT == 1
  #define GAS_LABELS_JSON "[\"MQ-2\"]"
  #define GAS_PINS_JSON   "[\"A3\"]"
#elif GAS_COUNT == 2
  #define GAS_LABELS_JSON "[\"MQ-2 #1\",\"MQ-2 #2\"]"
  #define GAS_PINS_JSON   "[\"A3\",\"A4\"]"
#else
  #error "GAS_COUNT harus 1 atau 2"
#endif

// ==================================================================
//  State
// ==================================================================
enum Mode : uint8_t { MODE_MANUAL = 0, MODE_AUTO = 1 };
enum State : uint8_t { ST_IDLE, ST_TURN, ST_APPROACH, ST_SPRAY, ST_REST, ST_MANUAL };

static Mode  mode = MODE_AUTO;       // FireGuard menyala dalam mode otomatis (diam sampai ada api)
static State state = ST_IDLE;
static unsigned long stateSince = 0;

static int   flameVal[FLAME_COUNT];
static uint8_t flameLvl[FLAME_COUNT];
static int   gasVal[GAS_COUNT];
static uint8_t gasLvl[GAS_COUNT];
static bool  sensorsPrimed = false;

static unsigned long warnSince = 0;  // sejak kapan ada tanda api (0 = tidak ada)
static unsigned long calmSince = 0;  // sejak kapan tidak ada tanda api

static int   speedCap = DEFAULT_SPEED;
static int   manualX = 0, manualY = 0;
static unsigned long lastDrv = 0;
static int   lastSpeed = 0;          // kecepatan motor yang dilaporkan (0..255)

static bool  pumpOn = false;
static bool  manualPump = false;
static unsigned long lastPumpCmd = 0;
static unsigned long sprayStart = 0;

static Servo nozzle;
static int   nozCur = NOZ_HOME;
static int   nozTarget = NOZ_HOME;
static int   nozManual = NOZ_HOME;
static unsigned long lastNozStep = 0;

#if HAS_BATTERY_SENSE
static int   batMv = 0;
#endif

static unsigned long lastTel = 0;
static unsigned long lastSensor = 0;

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

// left/right: -255..255 (negatif = mundur)
static void motorSet(int left, int right) {
  lastSpeed = max(abs(left), abs(right));
  if (INVERT_LEFT)  left  = -left;
  if (INVERT_RIGHT) right = -right;
  driveSide(left,  PIN_IN1, PIN_IN2, PIN_ENA);
  driveSide(right, PIN_IN3, PIN_IN4, PIN_ENB);
}

static void motorStop() { motorSet(0, 0); }

// skala 1..100 -> MIN_PWM..cap (0 tetap 0)
static int scalePwm(int v, int cap) {
  if (v == 0) return 0;
  int a = abs(v);
  int pwm;
  if (cap <= MIN_PWM) pwm = cap;
  else pwm = MIN_PWM + (int)(((long)(cap - MIN_PWM) * a) / 100L);
  if (pwm > 255) pwm = 255;
  return v > 0 ? pwm : -pwm;
}

// x: kanan positif, y: maju positif, keduanya -100..100
static void driveVector(int x, int y, int cap) {
  int l = y + x;
  int r = y - x;
  int m = max(abs(l), abs(r));
  if (m > 100) { l = (int)((long)l * 100 / m); r = (int)((long)r * 100 / m); }
  motorSet(scalePwm(l, cap), scalePwm(r, cap));
}

// ==================================================================
//  Pompa & nozzle
// ==================================================================
static void pumpSet(bool on) {
  pumpOn = on;
  digitalWrite(PIN_PUMP, (on == (PUMP_ACTIVE_HIGH != 0)) ? HIGH : LOW);
}

static void nozzleUpdate(unsigned long now) {
  if (now - lastNozStep < 15) return;
  lastNozStep = now;
  if (nozCur < nozTarget)      nozCur = min(nozCur + 3, nozTarget);
  else if (nozCur > nozTarget) nozCur = max(nozCur - 3, nozTarget);
  nozzle.write(nozCur);
}

// ==================================================================
//  Sensor
// ==================================================================
static int readAvg(uint8_t pin, uint8_t n) {
  long s = 0;
  for (uint8_t i = 0; i < n; i++) s += analogRead(pin);
  return (int)(s / n);
}

static uint8_t flameLevelOf(uint8_t prev, int v) {
  if (v <= FLAME_DANGER || (prev == 2 && v <= FLAME_DANGER + HYSTERESIS)) return 2;
  if (v <= FLAME_WARN   || (prev >= 1 && v <= FLAME_WARN + HYSTERESIS))   return 1;
  return 0;
}

static uint8_t gasLevelOf(uint8_t prev, int v) {
  if (v >= GAS_DANGER || (prev == 2 && v >= GAS_DANGER - HYSTERESIS)) return 2;
  if (v >= GAS_WARN   || (prev >= 1 && v >= GAS_WARN - HYSTERESIS))   return 1;
  return 0;
}

static void readSensors(unsigned long now) {
  for (uint8_t i = 0; i < FLAME_COUNT; i++) {
    int raw = readAvg(FLAME_PINS[i], 4);
    flameVal[i] = sensorsPrimed ? (flameVal[i] * 3 + raw) / 4 : raw;    // penghalus sederhana
    flameLvl[i] = flameLevelOf(flameLvl[i], flameVal[i]);
  }
  bool warm = now < GAS_WARMUP_MS;
  for (uint8_t i = 0; i < GAS_COUNT; i++) {
    int raw = readAvg(GAS_PINS[i], 4);
    gasVal[i] = sensorsPrimed ? (gasVal[i] * 3 + raw) / 4 : raw;
    gasLvl[i] = warm ? 0 : gasLevelOf(gasLvl[i], gasVal[i]);            // selama pemanasan jangan alarm
  }
#if HAS_BATTERY_SENSE
  unsigned long mv = (unsigned long)readAvg(PIN_BATTERY, 8) * 5000UL / 1023UL * BAT_DIVIDER_X100 / 100UL;
  batMv = sensorsPrimed ? (batMv * 7 + (int)mv) / 8 : (int)mv;
#endif
  sensorsPrimed = true;
}

// ==================================================================
//  Mode otomatis
// ==================================================================
static void enterState(State s, unsigned long now) { state = s; stateSince = now; }

// -1 = api di kiri, 0 = lurus, +1 = api di kanan (pakai titik berat intensitas)
static int8_t steerDir() {
  long num = 0, den = 0;
  for (uint8_t i = 0; i < FLAME_COUNT; i++) {
    int w = (FLAME_WARN + HYSTERESIS) - flameVal[i];
    if (w > 0) { num += (long)w * FLAME_POS[i] * 100L; den += w; }
  }
  if (den == 0) return 0;
  long pos = num / den;           // -100..100
  if (pos > 30) return 1;
  if (pos < -30) return -1;
  return 0;
}

static void autoStep(unsigned long now) {
  bool anyWarn = false, anyFire = false;
  for (uint8_t i = 0; i < FLAME_COUNT; i++) {
    if (flameLvl[i] >= 1) anyWarn = true;
    if (flameLvl[i] == 2) anyFire = true;
  }
  if (anyWarn) { if (!warnSince) warnSince = now; calmSince = 0; }
  else         { warnSince = 0; if (!calmSince) calmSince = now; }

  switch (state) {
    case ST_IDLE:
      motorStop(); pumpSet(false); nozTarget = NOZ_HOME;
      if (warnSince && now - warnSince > 300) enterState(ST_TURN, now);
      break;

    case ST_TURN: {
      int8_t dir = steerDir();
      if (anyFire) { motorStop(); enterState(ST_SPRAY, now); sprayStart = now; }
      else if (!anyWarn && calmSince && now - calmSince > 2000) { motorStop(); enterState(ST_IDLE, now); }
      else if (dir == 0) enterState(ST_APPROACH, now);
      else motorSet(dir * AUTO_TURN_PWM, -dir * AUTO_TURN_PWM);   // putar di tempat
      break;
    }

    case ST_APPROACH: {
      if (anyFire) { motorStop(); enterState(ST_SPRAY, now); sprayStart = now; }
      else if (!anyWarn && calmSince && now - calmSince > 2000) { motorStop(); enterState(ST_IDLE, now); }
      else if (steerDir() != 0) enterState(ST_TURN, now);
      else motorSet(AUTO_FWD_PWM, AUTO_FWD_PWM);
      break;
    }

    case ST_SPRAY:
      motorStop();
      pumpSet(true);
      nozTarget = NOZ_HOME + (int)(((now / 400) % 2 == 0) ? NOZ_SWEEP : -NOZ_SWEEP);   // ayun kiri-kanan
      if (calmSince && now - calmSince > 2500) { pumpSet(false); enterState(ST_REST, now); }
      else if (now - sprayStart > PUMP_MAX_ON_MS) { pumpSet(false); enterState(ST_REST, now); }
      break;

    case ST_REST:
      motorStop(); pumpSet(false); nozTarget = NOZ_HOME;
      if (anyFire && now - stateSince > PUMP_REST_MS) { enterState(ST_SPRAY, now); sprayStart = now; }
      else if (!anyWarn && now - stateSince > 2500) enterState(ST_IDLE, now);
      else if (anyWarn && now - stateSince > PUMP_REST_MS) enterState(ST_APPROACH, now);
      break;

    default:
      enterState(ST_IDLE, now);
  }
}

// ==================================================================
//  Mode manual
// ==================================================================
static void manualStep(unsigned long now) {
  if ((manualX != 0 || manualY != 0) && now - lastDrv > DEADMAN_MS) { manualX = 0; manualY = 0; }   // dead-man
  driveVector(manualX, manualY, speedCap);

  if (manualPump && now - lastPumpCmd > DEADMAN_MS) manualPump = false;                              // dead-man pompa
  pumpSet(manualPump);
  nozTarget = nozManual;
}

static void setMode(Mode m, unsigned long now) {
  mode = m;
  manualX = manualY = 0;
  manualPump = false;
  motorStop();
  pumpSet(false);
  nozManual = NOZ_HOME;
  nozTarget = NOZ_HOME;
  warnSince = 0; calmSince = 0;
  enterState(m == MODE_AUTO ? ST_IDLE : ST_MANUAL, now);
}

// ==================================================================
//  Telemetri
// ==================================================================
static const char* stateName() {
  if (mode == MODE_MANUAL) return "manual";
  switch (state) {
    case ST_TURN:     return "turn";
    case ST_APPROACH: return "approach";
    case ST_SPRAY:    return "spray";
    case ST_REST:     return "rest";
    default:          return "idle";
  }
}

static void printIntArray(const int* a, uint8_t n) {
  Serial.print('[');
  for (uint8_t i = 0; i < n; i++) { if (i) Serial.print(','); Serial.print(a[i]); }
  Serial.print(']');
}
static void printLvlArray(const uint8_t* a, uint8_t n) {
  Serial.print('[');
  for (uint8_t i = 0; i < n; i++) { if (i) Serial.print(','); Serial.print((int)a[i]); }
  Serial.print(']');
}

static void sendInfo() {
  Serial.print(F("{\"t\":\"info\",\"robot\":\"fireguard\",\"fw\":\"" FW_VERSION "\",\"flame\":" FLAME_LABELS_JSON
                 ",\"flamePins\":" FLAME_PINS_JSON ",\"gas\":" GAS_LABELS_JSON ",\"gasPins\":" GAS_PINS_JSON ",\"th\":{\"fw\":"));
  Serial.print(FLAME_WARN);   Serial.print(F(",\"fd\":"));
  Serial.print(FLAME_DANGER); Serial.print(F(",\"gw\":"));
  Serial.print(GAS_WARN);     Serial.print(F(",\"gd\":"));
  Serial.print(GAS_DANGER);   Serial.print(F("},\"noz\":{\"min\":"));
  Serial.print(NOZ_MIN);      Serial.print(F(",\"max\":"));
  Serial.print(NOZ_MAX);      Serial.print(F(",\"home\":"));
  Serial.print(NOZ_HOME);     Serial.print(F("},\"pump\":1}\n"));
}

static void sendTelemetry(unsigned long now) {
  Serial.print(F("{\"t\":\"tel\",\"up\":")); Serial.print(now / 1000UL);
  Serial.print(F(",\"m\":\""));              Serial.print(mode == MODE_AUTO ? 'A' : 'M');
  Serial.print(F("\",\"st\":\""));           Serial.print(stateName());
  Serial.print(F("\",\"fl\":"));             printIntArray(flameVal, FLAME_COUNT);
  Serial.print(F(",\"fs\":"));               printLvlArray(flameLvl, FLAME_COUNT);
  Serial.print(F(",\"gs\":"));               printIntArray(gasVal, GAS_COUNT);
  Serial.print(F(",\"gl\":"));               printLvlArray(gasLvl, GAS_COUNT);
  Serial.print(F(",\"gw\":"));               Serial.print(now < GAS_WARMUP_MS ? 1 : 0);
  Serial.print(F(",\"p\":"));                Serial.print(pumpOn ? 1 : 0);
  Serial.print(F(",\"na\":"));               Serial.print(nozCur);
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
    sendTelemetry(now);
    return;
  }
  if (!strcmp(cmd, "PUMP") && a1) {
    if (mode == MODE_MANUAL) { manualPump = (a1[0] == '1'); lastPumpCmd = now; }
    return;
  }
  if (!strcmp(cmd, "NOZ") && a1) {
    if (mode == MODE_MANUAL) nozManual = clampi(atol(a1), NOZ_MIN, NOZ_MAX);
    return;
  }
  // perintah lain (mis. PING yang sudah dijawab ESP) diabaikan
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
      lineOverflow = true;      // baris kepanjangan: buang sampai ketemu newline
    }
  }
}

// ==================================================================
//  setup & loop
// ==================================================================
void setup() {
  pinMode(PIN_ENA, OUTPUT); pinMode(PIN_IN1, OUTPUT); pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_ENB, OUTPUT); pinMode(PIN_IN3, OUTPUT); pinMode(PIN_IN4, OUTPUT);
  pinMode(PIN_PUMP, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  motorStop();
  pumpSet(false);                       // pompa harus mati dulu sebelum apa pun

  nozzle.attach(PIN_NOZZLE);
  nozzle.write(NOZ_HOME);

  Serial.begin(SERIAL_BAUD);

  unsigned long now = millis();
  readSensors(now);
  setMode(MODE_AUTO, now);
  sendInfo();
}

void loop() {
  unsigned long now = millis();

  readSerial(now);

  if (now - lastSensor >= SENSOR_EVERY_MS) { lastSensor = now; readSensors(now); }

  if (mode == MODE_AUTO) autoStep(now);
  else                   manualStep(now);

  nozzleUpdate(now);

  bool anyFire = false;
  for (uint8_t i = 0; i < FLAME_COUNT; i++) if (flameLvl[i] == 2) anyFire = true;
  digitalWrite(LED_BUILTIN, anyFire ? HIGH : LOW);       // LED di board menyala kalau api terdeteksi

  if (now - lastTel >= TEL_EVERY_MS) { lastTel = now; sendTelemetry(now); }
}
