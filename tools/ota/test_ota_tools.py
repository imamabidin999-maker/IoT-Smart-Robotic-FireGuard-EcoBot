"""
Uji alat OTA (publish_fw.py, keygen.py, otasign.py). Cukup Python 3, tanpa library tambahan.

    python -m unittest discover -s tools/ota -p "test_*.py" -v
"""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import keygen  # noqa: E402
import otasign  # noqa: E402
import publish_fw  # noqa: E402


def image(path, product="fireguard-bridge", version="1.2.0", size=90000, chip=0):
    head = bytearray(24)
    head[0] = 0xE9
    head[12] = chip & 0xFF
    head[13] = chip >> 8
    mark = f"FWID:{product}:{version};".encode() if product else b""
    body = bytes((i * 7 + len(version)) & 0xFF for i in range(size - len(head) - len(mark)))
    Path(path).write_bytes(bytes(head) + mark + body)
    return str(path)


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "server"
        self.no_key = str(self.tmp / "tidak-ada.pem")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def pub(self, *args, bin_=None, expect_fail=None):
        argv = ["--root", str(self.root), "--group", "kel04", "--base-url", "http://192.168.10.23:8000"]
        if bin_:
            argv += ["--bin", bin_]
        argv += list(args)
        a = publish_fw.build_parser().parse_args(argv)
        if a.key is None and "--tanpa-tanda-tangan" not in args:
            a.tanpa_tanda_tangan = True               # jangan memakai kunci asli di laptop yang menjalankan tes
        if expect_fail:
            with self.assertRaises(publish_fw.PublishError) as cm:
                publish_fw.publish(a, out=lambda *_: None)
            self.assertIn(expect_fail, str(cm.exception))
            return None
        return publish_fw.publish(a, out=lambda *_: None)

    def test_terbit_pertama_both_dan_isi_manifest(self):
        b = image(self.tmp / "esp_bridge.ino.bin")
        m = self.pub("--channel", "both", "--min-uno", "1.4.0", "--notes", "versi awal", bin_=b)
        data = Path(b).read_bytes()
        self.assertEqual(m["product"], "fireguard-bridge")
        self.assertEqual(m["board"], "esp32")
        e = m["latest"]
        self.assertEqual(m["stable"], e)
        self.assertEqual(e["version"], "1.2.0")
        self.assertEqual(e["url"], "http://192.168.10.23:8000/kel04/fireguard-bridge-1.2.0.bin")
        self.assertEqual(e["md5"], hashlib.md5(data).hexdigest())
        self.assertEqual(e["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(e["size"], len(data))
        self.assertEqual(e["min_uno"], "1.4.0")
        self.assertNotIn("sig", e)
        self.assertTrue((self.root / "kel04" / "fireguard-bridge-1.2.0.bin").is_file())
        on_disk = json.loads((self.root / "kel04" / "manifest-fireguard-bridge.json").read_text())
        self.assertEqual(on_disk, m)

    def test_menolak_file_yang_salah(self):
        self.pub(bin_=image(self.tmp / "esp_bridge.ino.merged.bin"), expect_fail="merged")
        self.pub(bin_=image(self.tmp / "esp_bridge.ino.bootloader.bin"), expect_fail="bootloader")
        bad = self.tmp / "x.ino.bin"
        bad.write_bytes(b"\x00" * 1000)
        self.pub(bin_=str(bad), expect_fail="0xE9")
        self.pub(bin_=image(self.tmp / "s3.ino.bin", chip=9), expect_fail="chip lain")
        self.pub(bin_=image(self.tmp / "tanpa.ino.bin", product=None), expect_fail="FWID")
        self.pub("--slot-size", "1000", bin_=image(self.tmp / "besar.ino.bin"), expect_fail="slot OTA")
        self.pub(bin_=str(self.tmp / "tidak-ada.bin"), expect_fail="tidak ditemukan")

    def test_versi_harus_naik_dan_cocok_dengan_isi_file(self):
        self.pub(bin_=image(self.tmp / "a.ino.bin", version="1.2.0"))
        self.pub(bin_=image(self.tmp / "b.ino.bin", version="1.2.0"), expect_fail="lebih tinggi")
        self.pub(bin_=image(self.tmp / "c.ino.bin", version="1.1.9"), expect_fail="lebih tinggi")
        m = self.pub("--paksa", bin_=image(self.tmp / "d.ino.bin", version="1.0.5"))
        self.assertEqual(m["latest"]["version"], "1.0.5")
        # jebakan lupa naik versi: isi file 1.2.1, mau diterbitkan sebagai 1.3.0
        self.pub("--version", "1.3.0", bin_=image(self.tmp / "e.ino.bin", version="1.2.1"), expect_fail="lupa naik versi")
        m = self.pub("--version", "1.3.0", "--lewati-cek-versi", bin_=image(self.tmp / "f.ino.bin", version="1.2.1"))
        self.assertEqual(m["latest"]["version"], "1.3.0")
        self.pub("--product", "ecobot-bridge", bin_=image(self.tmp / "g.ino.bin", version="1.4.0"), expect_fail="bukan 'ecobot-bridge'")

    def test_promosikan_dan_lihat(self):
        self.pub("--channel", "both", bin_=image(self.tmp / "a.ino.bin", version="1.1.0"))
        self.pub(bin_=image(self.tmp / "b.ino.bin", version="1.2.0"))
        m = self.pub("--lihat")
        self.assertEqual((m["latest"]["version"], m["stable"]["version"]), ("1.2.0", "1.1.0"))
        a = publish_fw.build_parser().parse_args(["--root", str(self.root), "--group", "kel04", "--promosikan"])
        m = publish_fw.publish(a, out=lambda *_: None)
        self.assertEqual(m["stable"]["version"], "1.2.0")

    def test_group_harus_kelNN(self):
        a = publish_fw.build_parser().parse_args(["--root", str(self.root), "--group", "kelompok4", "--base-url", "http://x", "--bin", "y"])
        with self.assertRaises(publish_fw.PublishError):
            publish_fw.publish(a, out=lambda *_: None)

    def test_tanda_tangan_bisa_diperiksa_dan_mengunci_versi(self):
        key = self.tmp / "kunci" / "ota_private.pem"
        header = self.tmp / "ota_pubkey.h"
        keygen.main(["--key", str(key), "--header", str(header)])
        self.assertIn("BEGIN PUBLIC KEY", header.read_text())
        with self.assertRaises(SystemExit):              # tidak menimpa kunci yang sudah ada tanpa --ganti
            keygen.main(["--key", str(key), "--header", str(header)])
        b = image(self.tmp / "s.ino.bin", version="1.5.0")
        m = self.pub("--key", str(key), bin_=b)
        e = m["latest"]
        Q = otasign.public_from_private(otasign.load_private_pem(key.read_text()))
        msg = publish_fw.sign_message("fireguard-bridge", "esp32", "1.5.0", e["size"], e["sha256"]).encode()
        self.assertTrue(otasign.verify(Q, msg, bytes.fromhex(e["sig"])))
        # tanda tangan yang sama tidak berlaku untuk versi lain (versi ikut ditandatangani)
        other = publish_fw.sign_message("fireguard-bridge", "esp32", "1.6.0", e["size"], e["sha256"]).encode()
        self.assertFalse(otasign.verify(Q, other, bytes.fromhex(e["sig"])))
        # header kunci publik ditulis ulang dari kunci yang ada
        header.unlink()
        keygen.main(["--key", str(key), "--header", str(header), "--tulis-header"])
        self.assertIn(otasign.fingerprint(Q), header.read_text())


class SignCompatTest(unittest.TestCase):
    """Tanda tangan buatan otasign harus diterima OpenSSL, dan sebaliknya."""

    @unittest.skipIf(shutil.which("openssl") is None, "openssl tidak ada")
    def test_cocok_dengan_openssl(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            d, Q = otasign.generate()
            (tmp / "priv.pem").write_text(otasign.private_pem(d))
            (tmp / "pub.pem").write_text(otasign.public_pem(Q))
            msg = b"KOPAK-OTA1|fireguard-bridge|esp32|1.2.0|10|" + b"ab" * 32
            (tmp / "msg").write_bytes(msg)
            (tmp / "sig").write_bytes(otasign.sign(d, msg))
            r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(tmp / "pub.pem"), "-signature", str(tmp / "sig"), str(tmp / "msg")],
                               capture_output=True, text=True)
            self.assertIn("Verified OK", r.stdout)
            subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(tmp / "priv.pem"), "-out", str(tmp / "sig2"), str(tmp / "msg")], check=True)
            self.assertTrue(otasign.verify(Q, msg, (tmp / "sig2").read_bytes()))
            self.assertFalse(otasign.verify(Q, msg + b"x", (tmp / "sig2").read_bytes()))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_deterministik_dan_low_s(self):
        d, Q = otasign.generate()
        s1 = otasign.sign(d, b"pesan")
        self.assertEqual(s1, otasign.sign(d, b"pesan"))
        r, s = otasign.parse_der_sig(s1)
        self.assertLessEqual(s, otasign.N // 2)
        self.assertTrue(otasign.verify(Q, b"pesan", s1))
        self.assertFalse(otasign.verify(Q, b"pesan", b"\x30\x00"))
        with self.assertRaises(otasign.KeyError_):
            otasign.load_public_pem("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")


if __name__ == "__main__":
    unittest.main()
