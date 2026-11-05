/*
  Tes motor roda — untuk FireGuard dan EcoBot
  ------------------------------------------------------------------
  Sketch kecil untuk memastikan baterai, L298N, kabel, dan motor sudah benar,
  tanpa dashboard, tanpa ESP, dan tanpa perlu mengetik perintah apa pun.

  Cara pakai:
    1. Angkat robot sampai semua roda tidak menyentuh apa pun.
    2. Upload sketch ini ke Uno (lepas dulu kabel di D0/D1 kalau ada).
    3. Nyalakan saklar baterai. Buka Serial Monitor dengan baud 57600 untuk melihat langkah
       yang sedang berjalan (tidak wajib, roda tetap berputar tanpa Serial Monitor).
    4. Perhatikan roda. Urutannya diulang terus:
         1) kiri maju   2) kiri mundur   3) kanan maju   4) kanan mundur
         5) dua sisi maju, kecepatan dinaikkan pelan-pelan
    5. Setelah selesai, upload lagi firmware robot (fireguard_uno atau ecobot_uno).

  Arti hasilnya ada di docs/RAKIT-FIREGUARD.md dan docs/RAKIT-ECOBOT.md, langkah 3.
  Pin di bawah sama dengan firmware robot. Kalau kabelnya Anda pindah, samakan angkanya.
*/

#define PIN_ENA         5      // PWM, roda kiri (channel A: OUT1/OUT2)
#define PIN_IN1         7
#define PIN_IN2         8
#define PIN_ENB         6      // PWM, roda kanan (channel B: OUT3/OUT4)
#define PIN_IN3         9
#define PIN_IN4         10

#define RUN_MS          2000   // lama tiap langkah (ms)
#define REST_MS         1000   // jeda antar langkah (ms)

// v: -255..255, negatif = mundur, 0 = berhenti
static void driveSide(int v, uint8_t inA, uint8_t inB, uint8_t en) {
  digitalWrite(inA, v > 0 ? HIGH : LOW);
  digitalWrite(inB, v < 0 ? HIGH : LOW);
  analogWrite(en, v < 0 ? -v : v);
}

static void drive(int left, int right) {
  driveSide(left,  PIN_IN1, PIN_IN2, PIN_ENA);
  driveSide(right, PIN_IN3, PIN_IN4, PIN_ENB);
}

static void runStep(const __FlashStringHelper* label, int left, int right) {
  Serial.println(label);
  drive(left, right);
  delay(RUN_MS);
  drive(0, 0);
  delay(REST_MS);
}

void setup() {
  pinMode(PIN_ENA, OUTPUT); pinMode(PIN_IN1, OUTPUT); pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_ENB, OUTPUT); pinMode(PIN_IN3, OUTPUT); pinMode(PIN_IN4, OUTPUT);
  drive(0, 0);

  Serial.begin(57600);
  Serial.println();
  Serial.println(F("=== TES MOTOR RODA ==="));
  Serial.println(F("Kalau tulisan ini muncul lagi setiap roda mulai berputar, Uno restart: daya baterai kurang."));
  Serial.println(F("Mulai 3 detik lagi. Pastikan roda sudah diangkat."));
  delay(3000);
}

void loop() {
  runStep(F("1/5  roda KIRI maju"),    255,    0);
  runStep(F("2/5  roda KIRI mundur"), -255,    0);
  runStep(F("3/5  roda KANAN maju"),     0,  255);
  runStep(F("4/5  roda KANAN mundur"),   0, -255);

  Serial.println(F("5/5  dua sisi maju, kecepatan naik pelan. Catat angka saat roda mulai berputar:"));
  for (int pwm = 40; pwm <= 255; pwm += 15) {
    Serial.print(F("     PWM "));
    Serial.println(pwm);
    drive(pwm, pwm);
    delay(500);
  }
  drive(0, 0);
  Serial.println(F("Selesai, diulang lagi 3 detik lagi."));
  Serial.println();
  delay(3000);
}
