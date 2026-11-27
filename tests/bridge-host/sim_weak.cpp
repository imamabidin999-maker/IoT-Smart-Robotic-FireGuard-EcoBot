// Bawaan core Arduino-ESP32: firmware baru langsung ditandai sah saat menyala.
// Sketch bisa menimpanya (ROLLBACK_BOOTLOADER 1). Ada di file terpisah supaya bisa "weak".
extern "C" __attribute__((weak)) bool verifyRollbackLater() { return false; }
