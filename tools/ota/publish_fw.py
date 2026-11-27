#!/usr/bin/env python3
"""
Menerbitkan firmware ESP bridge ke folder server OTA dan memperbarui manifest.

Versi yang lebih ketat dari publish_fw.py di modul praktikum: selain menghitung MD5 dan
ukuran, skrip ini membaca penanda versi di dalam file .bin (FWID), menolak file yang nomor
versinya tidak sama dengan yang mau diterbitkan, mengecek file muat di slot OTA, dan
menandatangani firmware kalau kunci rahasia ada (lihat keygen.py).

Contoh (dari folder utama repo):
  python tools/ota/publish_fw.py --root ../fireguard-ota --base-url http://192.168.10.23:8000 \\
      --group kel04 --channel both --bin firmware/esp_bridge/build/esp32.esp32.esp32/esp_bridge.ino.bin

  --channel latest  : versi yang akan dipasang robot (update)
  --channel stable  : versi cadangan untuk rollback lewat server
  --channel both    : keduanya (dipakai saat menerbitkan versi pertama)

Setelah versi baru dinyatakan VALID di robot, jadikan juga versi stable:
  python tools/ota/publish_fw.py --root ../fireguard-ota --group kel04 --promosikan

Lalu jalankan server:  python -m http.server 8000 --directory ../fireguard-ota
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import otasign  # noqa: E402

ESP_IMAGE_MAGIC = 0xE9
FWID_RE = re.compile(rb"FWID:([a-z0-9-]{1,32}):(\d{1,5}\.\d{1,5}\.\d{1,5});")
SLOT_DEFAULT = 0x140000           # Partition Scheme "Default 4MB with spiffs": app0/app1 masing-masing 1.25 MB
CHIP_ID = {"esp32": 0x0000}       # byte 12-13 header image ESP-IDF
DEFAULT_KEY = HERE / "kunci" / "ota_private.pem"


class PublishError(Exception):
    pass


def semver(v):
    m = re.fullmatch(r"(\d{1,5})\.(\d{1,5})\.(\d{1,5})", v or "")
    return tuple(int(x) for x in m.groups()) if m else None


def find_fwid(data):
    """(produk, versi) dari penanda FWID di dalam biner, atau (None, None)."""
    m = FWID_RE.search(data)
    if not m:
        return None, None
    return m.group(1).decode(), m.group(2).decode()


def sign_message(product, board, version, size, sha256hex):
    # HARUS sama persis dengan ota::signMessage() di firmware/esp_bridge/ota_core.h
    return f"KOPAK-OTA1|{product}|{board}|{version}|{size}|{sha256hex}"


def check_binary(path, board, slot_size):
    src = Path(path)
    if not src.is_file():
        raise PublishError(f"file tidak ditemukan: {src}")
    name = src.name.lower()
    if "merged" in name or "bootloader" in name or "partitions" in name:
        raise PublishError("pilih biner APLIKASI (<nama_sketch>.ino.bin), bukan merged/bootloader/partitions")
    data = src.read_bytes()
    if not data or data[0] != ESP_IMAGE_MAGIC:
        raise PublishError("byte pertama bukan 0xE9: ini bukan image aplikasi ESP")
    if len(data) < 24:
        raise PublishError("file terlalu kecil untuk image aplikasi ESP")
    chip = data[12] | (data[13] << 8)
    if board in CHIP_ID and chip != CHIP_ID[board]:
        raise PublishError(f"image ini untuk chip lain (chip id {chip:#06x}), bukan {board}. Cek pilihan board di Arduino IDE")
    if len(data) > slot_size:
        raise PublishError(f"ukuran {len(data)} byte lebih besar dari slot OTA ({slot_size} byte). "
                           "Pakai Partition Scheme yang punya OTA, atau kecilkan program")
    warnings = []
    if len(data) < 64 * 1024:
        warnings.append("ukuran < 64 KB, pastikan ini biner aplikasi, bukan bootloader")
    return data, warnings


def load_manifest(path, product, board):
    if not path.is_file():
        return {"product": product, "board": board}
    try:
        m = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise PublishError(f"manifest lama rusak ({e}). Perbaiki atau hapus {path}")
    if m.get("board") != board or m.get("product", product) != product:
        raise PublishError("manifest lama berisi board/produk lain; periksa folder")
    m["product"] = product
    return m


def write_json(path, obj):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def load_key(path, explicit):
    if path is None:
        return None
    p = Path(path)
    if not p.is_file():
        if explicit:
            raise PublishError(f"kunci rahasia tidak ditemukan: {p}")
        return None
    try:
        return otasign.load_private_pem(p.read_text(encoding="utf-8"))
    except otasign.KeyError_ as e:
        raise PublishError(f"kunci rahasia tidak bisa dibaca: {e}")


def guess_product(group_dir):
    found = sorted(group_dir.glob("manifest-*.json")) if group_dir.is_dir() else []
    if len(found) == 1:
        return found[0].stem[len("manifest-"):]
    if not found:
        raise PublishError(f"belum ada manifest di {group_dir}")
    raise PublishError("ada beberapa manifest, sebutkan --product (mis. fireguard-bridge)")


def publish(a, out=print):
    if not re.fullmatch(r"kel\d{2}", a.group):
        raise PublishError("ID kelompok harus berformat kelNN, contoh kel04")
    group_dir = Path(a.root) / a.group

    if a.promosikan or a.lihat:
        product = a.product or guess_product(group_dir)
        mpath = group_dir / f"manifest-{product}.json"
        manifest = load_manifest(mpath, product, a.board)
        if a.lihat:
            out(json.dumps(manifest, indent=2))
            return manifest
        if "latest" not in manifest:
            raise PublishError("manifest belum punya versi latest")
        manifest["stable"] = dict(manifest["latest"])
        write_json(mpath, manifest)
        out(f"OK: v{manifest['latest']['version']} sekarang juga menjadi stable")
        return manifest

    if not a.bin or not a.base_url:
        raise PublishError("--bin dan --base-url wajib diisi untuk menerbitkan firmware")
    if not re.match(r"^https?://", a.base_url):
        raise PublishError("--base-url harus diawali http:// atau https://")

    data, warnings = check_binary(a.bin, a.board, a.slot_size)
    for w in warnings:
        out(f"PERINGATAN: {w}")

    product, inside = find_fwid(data)
    if product is None:
        raise PublishError("penanda FWID tidak ditemukan di file ini. Apakah ini firmware esp_bridge proyek ini?")
    if a.product and a.product != product:
        raise PublishError(f"isi file adalah '{product}', bukan '{a.product}'")
    version = a.version or inside
    if not semver(version):
        raise PublishError("versi harus berformat MAJOR.MINOR.PATCH, contoh 1.2.0")
    if version != inside:
        if not a.lewati_cek_versi:
            raise PublishError(f"isi file melapor v{inside}, tapi mau diterbitkan sebagai v{version}. "
                               "Naikkan FW_VERSION di config.h lalu compile ulang (jebakan 'lupa naik versi')")
        out(f"PERINGATAN: isi file v{inside} diterbitkan sebagai v{version} (--lewati-cek-versi). HANYA untuk uji!")
    if a.min_uno and not semver(a.min_uno):
        raise PublishError("--min-uno harus berformat MAJOR.MINOR.PATCH")

    mpath = group_dir / f"manifest-{product}.json"
    manifest = load_manifest(mpath, product, a.board)
    channels = ["latest", "stable"] if a.channel == "both" else [a.channel]
    old = manifest.get("latest", {}).get("version")
    if "latest" in channels and old and semver(old) and semver(version) <= semver(old) and not a.paksa:
        raise PublishError(f"versi latest sekarang v{old}; versi baru harus lebih tinggi. "
                           "(Untuk uji downgrade, tambahkan --paksa)")

    group_dir.mkdir(parents=True, exist_ok=True)
    fw_name = f"{product}-{version}.bin"
    dest = group_dir / fw_name
    if Path(a.bin).resolve() != dest.resolve():
        shutil.copyfile(a.bin, dest)

    sha = hashlib.sha256(data).hexdigest()
    entry = {
        "version": version,
        "url": f"{a.base_url.rstrip('/')}/{a.group}/{fw_name}",
        "md5": hashlib.md5(data).hexdigest(),
        "sha256": sha,
        "size": len(data),
    }
    key_explicit = a.key is not None
    d = None if a.tanpa_tanda_tangan else load_key(a.key if key_explicit else DEFAULT_KEY, key_explicit)
    if d is not None:
        msg = sign_message(product, a.board, version, len(data), sha).encode()
        sig = otasign.sign(d, msg)
        if not otasign.verify(otasign.public_from_private(d), msg, sig):
            raise PublishError("tanda tangan gagal diverifikasi ulang (aneh, coba lagi)")
        entry["sig"] = sig.hex()
    if a.min_uno:
        entry["min_uno"] = a.min_uno
    if a.notes:
        entry["notes"] = a.notes[:120]

    for ch in channels:
        manifest[ch] = entry
    write_json(mpath, manifest)
    out(f"OK: {fw_name} -> {', '.join(channels)}" + ("" if d is not None else " (TANPA tanda tangan)"))
    out(json.dumps(manifest, indent=2))
    return manifest


def build_parser():
    p = argparse.ArgumentParser(description="Terbitkan firmware OTA + manifest")
    p.add_argument("--root", required=True, help="folder akar server, mis. ../fireguard-ota")
    p.add_argument("--group", required=True, help="ID kelompok, mis. kel04")
    p.add_argument("--base-url", help="alamat server, mis. http://192.168.10.23:8000 atau https://akun.github.io/fireguard-ota")
    p.add_argument("--bin", help="file .bin hasil Sketch > Export Compiled Binary")
    p.add_argument("--version", help="MAJOR.MINOR.PATCH. Bawaan: dibaca dari isi file")
    p.add_argument("--product", help="mis. fireguard-bridge. Bawaan: dibaca dari isi file")
    p.add_argument("--board", default="esp32", choices=["esp32"])
    p.add_argument("--channel", default="latest", choices=["latest", "stable", "both"])
    p.add_argument("--min-uno", help="versi firmware Uno minimal, mis. 1.4.0")
    p.add_argument("--notes", help="catatan singkat yang tampil di dashboard (maks 120 karakter)")
    p.add_argument("--key", help=f"kunci rahasia (bawaan {DEFAULT_KEY} kalau ada)")
    p.add_argument("--tanpa-tanda-tangan", action="store_true", help="jangan menandatangani walaupun kunci ada")
    p.add_argument("--slot-size", type=lambda x: int(x, 0), default=SLOT_DEFAULT, help="ukuran slot OTA (byte)")
    p.add_argument("--promosikan", action="store_true", help="jadikan versi latest sebagai stable")
    p.add_argument("--lihat", action="store_true", help="tampilkan isi manifest")
    p.add_argument("--paksa", action="store_true", help="izinkan versi yang tidak lebih tinggi (uji downgrade)")
    p.add_argument("--lewati-cek-versi", action="store_true", help="izinkan isi file beda versi (HANYA uji 'lupa naik versi')")
    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    try:
        publish(a)
    except PublishError as e:
        print(f"GAGAL: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
