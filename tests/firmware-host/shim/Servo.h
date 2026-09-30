// Servo palsu: hanya mencatat sudut terakhir per pin.
#pragma once
#include "Arduino.h"

class Servo {
 public:
  uint8_t attach(int p) { pin = p; return (uint8_t)p; }
  void write(int angle) { if (pin >= 0) g_servo_angle[pin] = angle; }
  int read() { return pin >= 0 ? g_servo_angle[pin] : 0; }
 private:
  int pin = -1;
};
