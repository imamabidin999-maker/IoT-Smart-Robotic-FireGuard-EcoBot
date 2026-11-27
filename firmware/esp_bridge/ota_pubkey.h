// ota_pubkey.h — kunci PUBLIK untuk memeriksa tanda tangan firmware.
// ------------------------------------------------------------------
// File ini ditulis ulang oleh:   python tools/ota/keygen.py
// Kunci publik aman dibagikan dan boleh ikut ke GitHub. Kunci RAHASIA-nya disimpan keygen.py di
// tools/ota/kunci/ dan tidak ikut ke GitHub (.gitignore). Jangan pernah membagikan kunci rahasia.
//
// Selama masih kosong seperti sekarang, robot menerima firmware tanpa tanda tangan (tetap dicek
// MD5, SHA-256, board, produk, dan versinya). Begitu kunci diisi lalu firmware di-upload lewat USB
// sekali, robot hanya mau memasang firmware yang ditandatangani kunci rahasia pasangannya.
#pragma once

static const char OTA_PUBKEY_PEM[] = "";
