// ota_crypto.h — sidik jari SHA-256 dan pemeriksaan tanda tangan firmware (ECDSA P-256).
// ------------------------------------------------------------------
// Memakai mbedTLS yang sudah ada di core ESP32 (dipakai juga untuk HTTPS), jadi tidak perlu
// library tambahan. File yang sama dikompilasi di PC untuk pengujian (tests/bridge-host).
//
// Kenapa perlu tanda tangan, padahal sudah ada MD5 dan HTTPS? MD5 hanya membuktikan file sampai
// utuh, HTTPS hanya membuktikan jalurnya aman. Orang yang bisa mengubah isi server (mis. akun
// GitHub kebobolan) bisa mengganti file DAN sidik jarinya sekaligus. Tanda tangan dibuat dengan
// kunci rahasia yang hanya ada di laptop kelompok, tidak pernah di server, jadi file palsu ketahuan.
#pragma once

#include <stdint.h>
#include <string.h>
#include "mbedtls/version.h"
#include "mbedtls/sha256.h"
#include "mbedtls/pk.h"
#include "mbedtls/md.h"
#include "ota_core.h"

namespace ota {

class Sha256 {
 public:
  Sha256() { mbedtls_sha256_init(&ctx_); }
  ~Sha256() { mbedtls_sha256_free(&ctx_); }
  Sha256(const Sha256&) = delete;
  Sha256& operator=(const Sha256&) = delete;

  void begin() {
#if MBEDTLS_VERSION_MAJOR >= 3
    mbedtls_sha256_starts(&ctx_, 0);
#else
    mbedtls_sha256_starts_ret(&ctx_, 0);
#endif
  }
  void update(const uint8_t* data, size_t n) {
#if MBEDTLS_VERSION_MAJOR >= 3
    mbedtls_sha256_update(&ctx_, data, n);
#else
    mbedtls_sha256_update_ret(&ctx_, data, n);
#endif
  }
  void finish(uint8_t out[32]) {
#if MBEDTLS_VERSION_MAJOR >= 3
    mbedtls_sha256_finish(&ctx_, out);
#else
    mbedtls_sha256_finish_ret(&ctx_, out);
#endif
  }

 private:
  mbedtls_sha256_context ctx_;
};

inline void sha256Of(const void* data, size_t n, uint8_t out[32]) {
  Sha256 s;
  s.begin();
  s.update((const uint8_t*)data, n);
  s.finish(out);
}

// Kunci publik sudah diisi? (ota_pubkey.h dibuat oleh tools/ota/keygen.py)
inline bool keyConfigured(const char* pubPem) {
  return pubPem && strstr(pubPem, "BEGIN PUBLIC KEY") != nullptr;
}

// 0 = tanda tangan sah untuk pesan ini. Selain 0 = tidak sah / format salah.
inline int verifySignature(const char* pubPem, const char* message, const char* sigHex) {
  uint8_t sig[80];
  size_t sigLen = hexDecode(sigHex, sig, sizeof(sig));
  if (!sigLen) return 1;
  uint8_t hash[32];
  sha256Of(message, strlen(message), hash);

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int r = mbedtls_pk_parse_public_key(&pk, (const unsigned char*)pubPem, strlen(pubPem) + 1);
  if (r == 0 && !mbedtls_pk_can_do(&pk, MBEDTLS_PK_ECDSA)) r = 2;
  if (r == 0) r = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, sizeof(hash), sig, sigLen);
  mbedtls_pk_free(&pk);
  return r;
}

}  // namespace ota
