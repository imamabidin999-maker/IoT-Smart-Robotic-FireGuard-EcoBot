#!/usr/bin/env python3
"""
Membuat pasangan kunci untuk menandatangani firmware OTA (ECDSA P-256).

    python tools/ota/keygen.py

Hasilnya:
  - tools/ota/kunci/ota_private.pem   kunci RAHASIA. Jangan dibagikan, jangan di-upload ke GitHub
                                      (folder kunci/ sudah masuk .gitignore). Simpan cadangannya.
  - firmware/esp_bridge/ota_pubkey.h  kunci PUBLIK untuk firmware. Upload ulang firmware ESP lewat
                                      USB sekali, sesudah itu robot hanya mau memasang firmware
                                      yang ditandatangani kunci rahasia di atas.

Pilihan lain:
  --ganti           buat kunci baru walaupun sudah ada (kunci lama disimpan sebagai cadangan).
                    Robot yang masih memakai kunci publik lama akan MENOLAK firmware yang
                    ditandatangani kunci baru, jadi upload ulang lewat USB.
  --tulis-header    tulis ulang ota_pubkey.h dari kunci rahasia yang sudah ada
"""
import argparse
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import otasign  # noqa: E402

REPO = HERE.parent.parent
DEFAULT_KEY = HERE / "kunci" / "ota_private.pem"
DEFAULT_HEADER = REPO / "firmware" / "esp_bridge" / "ota_pubkey.h"

HEADER_TEMPLATE = """// ota_pubkey.h — kunci PUBLIK untuk memeriksa tanda tangan firmware.
// ------------------------------------------------------------------
// Dibuat oleh tools/ota/keygen.py pada {when}. Sidik jari kunci: {fp}
// Kunci publik aman dibagikan dan boleh ikut ke GitHub. Kunci RAHASIA pasangannya ada di
// tools/ota/kunci/ota_private.pem dan TIDAK boleh dibagikan.
//
// Setelah file ini berisi kunci, robot hanya mau memasang firmware yang ditandatangani
// (publish_fw.py menandatangani otomatis kalau kunci rahasianya ada).
#pragma once

static const char OTA_PUBKEY_PEM[] =
{pem_lines};
"""


def fail(msg):
    print(f"GAGAL: {msg}", file=sys.stderr)
    sys.exit(1)


def write_header(path, Q):
    pem = otasign.public_pem(Q).strip().splitlines()
    pem_lines = "\n".join(f'    "{line}\\n"' for line in pem)
    text = HEADER_TEMPLATE.format(when=time.strftime("%Y-%m-%d %H:%M"), fp=otasign.fingerprint(Q), pem_lines=pem_lines)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main(argv=None):
    p = argparse.ArgumentParser(description="Buat kunci tanda tangan firmware OTA")
    p.add_argument("--key", type=Path, default=DEFAULT_KEY, help=f"lokasi kunci rahasia (bawaan {DEFAULT_KEY.relative_to(REPO)})")
    p.add_argument("--header", type=Path, default=DEFAULT_HEADER, help="header kunci publik untuk firmware")
    p.add_argument("--ganti", action="store_true", help="buat kunci baru walaupun sudah ada")
    p.add_argument("--tulis-header", action="store_true", help="tulis ulang header dari kunci yang sudah ada")
    a = p.parse_args(argv)

    if a.tulis_header:
        if not a.key.is_file():
            fail(f"kunci rahasia belum ada: {a.key}. Jalankan keygen.py tanpa --tulis-header dulu.")
        try:
            d = otasign.load_private_pem(a.key.read_text(encoding="utf-8"))
        except otasign.KeyError_ as e:
            fail(f"kunci rahasia tidak bisa dibaca: {e}")
        Q = otasign.public_from_private(d)
        write_header(a.header, Q)
        print(f"OK: {a.header} ditulis ulang. Sidik jari kunci: {otasign.fingerprint(Q)}")
        return

    if a.key.exists() and not a.ganti:
        fail(f"kunci sudah ada di {a.key}. Pakai --ganti kalau memang mau membuat kunci baru "
             "(robot harus di-upload ulang lewat USB sesudahnya).")
    if a.key.exists():
        backup = a.key.with_name(a.key.stem + time.strftime("-lama-%Y%m%d-%H%M%S") + a.key.suffix)
        a.key.rename(backup)
        print(f"Kunci lama disimpan sebagai {backup}")

    d, Q = otasign.generate()
    a.key.parent.mkdir(parents=True, exist_ok=True)
    a.key.write_text(otasign.private_pem(d), encoding="utf-8")
    try:
        a.key.chmod(0o600)
    except OSError:
        pass
    write_header(a.header, Q)
    print(f"OK: kunci rahasia  -> {a.key}")
    print(f"    kunci publik   -> {a.header}")
    print(f"    sidik jari     -> {otasign.fingerprint(Q)}")
    print("Langkah berikutnya: upload esp_bridge lewat USB sekali, lalu terbitkan firmware dengan publish_fw.py.")
    print("JANGAN bagikan file kunci rahasia. Simpan cadangannya di tempat aman (mis. flashdisk).")


if __name__ == "__main__":
    main()
