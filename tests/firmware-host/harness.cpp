// Harness: menjalankan sketch Uno asli di PC dengan sensor palsu.
// Dikendalikan lewat stdin (satu perintah per baris), hasil ke stdout. Setelah tiap perintah
// harness mencetak "DONE" supaya skrip uji tahu kapan boleh lanjut.
//
//   INIT                 panggil setup()
//   T <ms>               majukan waktu <ms> milidetik (loop() dipanggil tiap 5 ms)
//   S <teks>             kirim satu baris ke Serial Uno (seperti dari ESP)
//   A <pin> <nilai>      atur nilai analogRead(pin)
//   E <pin> <cm>         atur jarak ultrasonik di pin ECHO (cm <= 0 = tidak ada pantulan)
//   QP <pin>             cetak digitalWrite terakhir di pin
//   QW <pin>             cetak analogWrite (PWM) terakhir di pin
//   QS <pin>             cetak sudut servo terakhir di pin
//   Keluaran Serial Uno muncul sebagai "OUT <baris>".

#include "Arduino.h"

unsigned long g_now_ms = 0;
int g_pin_state[64] = {0};
int g_pin_pwm[64] = {0};
int g_analog[64] = {0};
unsigned long g_echo_us[64] = {0};
int g_servo_angle[64] = {0};
unsigned long g_rand_state = 12345;
SerialShim Serial;

#include SKETCH_PATH

static void flushSerial() {
  size_t pos;
  while ((pos = Serial.out.find('\n')) != std::string::npos) {
    std::string line = Serial.out.substr(0, pos);
    Serial.out.erase(0, pos + 1);
    printf("OUT %s\n", line.c_str());
  }
}

int main() {
  setvbuf(stdout, NULL, _IOLBF, 0);
  char buf[512];
  while (fgets(buf, sizeof(buf), stdin)) {
    size_t n = strlen(buf);
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) buf[--n] = '\0';
    char* sp = strchr(buf, ' ');
    std::string cmd = sp ? std::string(buf, sp - buf) : std::string(buf);
    const char* arg = sp ? sp + 1 : "";

    if (cmd == "INIT") {
      setup();
    } else if (cmd == "T") {
      long ms = atol(arg);
      for (long t = 0; t < ms; t += 5) { g_now_ms += 5; loop(); flushSerial(); }
    } else if (cmd == "S") {
      for (const char* p = arg; *p; p++) Serial.in.push_back(*p);
      Serial.in.push_back('\n');
    } else if (cmd == "A") {
      int pin, v;
      if (sscanf(arg, "%d %d", &pin, &v) == 2) g_analog[pin] = v;
    } else if (cmd == "E") {
      int pin, cm;
      if (sscanf(arg, "%d %d", &pin, &cm) == 2) g_echo_us[pin] = cm > 0 ? (unsigned long)cm * 58UL : 0;
    } else if (cmd == "QP") {
      printf("RES %d\n", g_pin_state[atoi(arg)]);
    } else if (cmd == "QW") {
      printf("RES %d\n", g_pin_pwm[atoi(arg)]);
    } else if (cmd == "QS") {
      printf("RES %d\n", g_servo_angle[atoi(arg)]);
    }
    flushSerial();
    printf("DONE\n");
  }
  return 0;
}
