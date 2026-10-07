// Shim Arduino minimal supaya sketch .ino bisa dikompilasi & dijalankan di PC (untuk pengujian logika).
// Hanya berisi fungsi yang dipakai sketch di proyek ini. Bukan pengganti core Arduino asli.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <string>
#include <deque>
#include <algorithm>

typedef uint8_t byte;
typedef bool boolean;

#define PROGMEM
#define PSTR(s) (s)
class __FlashStringHelper;
#define F(s) (reinterpret_cast<const __FlashStringHelper*>(s))

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define LED_BUILTIN 13
#define A0 14
#define A1 15
#define A2 16
#define A3 17
#define A4 18
#define A5 19

// makro min/max gaya Arduino (didefinisikan setelah semua header standar di-include)
#define min(a, b) ((a) < (b) ? (a) : (b))
#define max(a, b) ((a) > (b) ? (a) : (b))

// ---------- state perangkat keras palsu (dibaca/diatur oleh harness) ----------
extern unsigned long g_now_ms;
extern int g_pin_state[64];
extern int g_pin_pwm[64];
extern int g_analog[64];
extern unsigned long g_echo_us[64];
extern int g_servo_angle[64];

inline unsigned long millis() { return g_now_ms; }
inline unsigned long micros() { return g_now_ms * 1000UL; }
inline void delayMicroseconds(unsigned int) {}
inline void delay(unsigned long) {}
inline void pinMode(uint8_t, uint8_t) {}
inline void digitalWrite(uint8_t pin, uint8_t v) { g_pin_state[pin] = v; }
inline int digitalRead(uint8_t pin) { return g_pin_state[pin]; }
inline void analogWrite(uint8_t pin, int v) { g_pin_pwm[pin] = v; }
inline int analogRead(uint8_t pin) { return g_analog[pin]; }
inline unsigned long pulseIn(uint8_t pin, uint8_t, unsigned long) { return g_echo_us[pin]; }

// random() gaya Arduino, deterministik supaya pengujian bisa diulang
extern unsigned long g_rand_state;
inline void randomSeed(unsigned long s) { (void)s; }
inline long random(long lo, long hi) {
  if (hi <= lo) return lo;
  g_rand_state = g_rand_state * 1103515245UL + 12345UL;
  return lo + (long)((g_rand_state >> 16) % (unsigned long)(hi - lo));
}

// ---------- Serial palsu ----------
class SerialShim {
 public:
  std::string out;
  std::deque<char> in;
  void begin(unsigned long) {}
  int available() { return (int)in.size(); }
  int read() { if (in.empty()) return -1; char c = in.front(); in.pop_front(); return (unsigned char)c; }
  void print(const char* s) { out += s; }
  void print(const __FlashStringHelper* s) { out += reinterpret_cast<const char*>(s); }
  void print(char c) { out += c; }
  void print(int v) { out += std::to_string(v); }
  void print(unsigned int v) { out += std::to_string(v); }
  void print(long v) { out += std::to_string(v); }
  void print(unsigned long v) { out += std::to_string(v); }
};
extern SerialShim Serial;
