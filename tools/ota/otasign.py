"""
Tanda tangan digital ECDSA P-256 + SHA-256, ditulis tanpa library tambahan.

Dipakai oleh keygen.py (membuat pasangan kunci) dan publish_fw.py (menandatangani firmware).
ESP32 memeriksa tanda tangan yang sama dengan mbedTLS (firmware/esp_bridge/ota_crypto.h).

Kenapa ditulis sendiri? Supaya alat ini cukup butuh Python 3 biasa, sama seperti publish_fw.py
di modul praktikum. Bilangan acak untuk tanda tangan dibuat dengan cara deterministik (RFC 6979),
jadi tidak bergantung pada kualitas pembangkit acak, dan menandatangani file yang sama dua kali
menghasilkan tanda tangan yang sama.
"""
import base64
import hashlib
import hmac
import secrets

# Parameter kurva secp256r1 (prime256v1 / NIST P-256)
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
     0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)

_OID_EC_PUBKEY = bytes.fromhex("2a8648ce3d0201")
_OID_P256 = bytes.fromhex("2a8648ce3d030107")
_SPKI_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")


class KeyError_(ValueError):
    """Kunci atau tanda tangan tidak bisa dibaca."""


# ------------------------------------------------------------------
#  Aritmetika titik kurva (koordinat Jacobian)
# ------------------------------------------------------------------
def _inv(x, m):
    return pow(x, m - 2, m)


def _jac(pt):
    return (pt[0], pt[1], 1)


def _affine(j):
    x, y, z = j
    if z == 0:
        return None
    zi = _inv(z, P)
    zi2 = zi * zi % P
    return (x * zi2 % P, y * zi2 * zi % P)


def _double(j):
    x, y, z = j
    if y == 0 or z == 0:
        return (0, 1, 0)
    ysq = y * y % P
    s = 4 * x * ysq % P
    z2 = z * z % P
    m = 3 * (x - z2) * (x + z2) % P          # a = -3
    nx = (m * m - 2 * s) % P
    ny = (m * (s - nx) - 8 * ysq * ysq) % P
    nz = 2 * y * z % P
    return (nx, ny, nz)


def _add(p, q):
    if p[2] == 0:
        return q
    if q[2] == 0:
        return p
    x1, y1, z1 = p
    x2, y2, z2 = q
    z1s = z1 * z1 % P
    z2s = z2 * z2 % P
    u1 = x1 * z2s % P
    u2 = x2 * z1s % P
    s1 = y1 * z2s * z2 % P
    s2 = y2 * z1s * z1 % P
    if u1 == u2:
        if s1 != s2:
            return (0, 1, 0)
        return _double(p)
    h = (u2 - u1) % P
    r = (s2 - s1) % P
    h2 = h * h % P
    h3 = h * h2 % P
    u1h2 = u1 * h2 % P
    nx = (r * r - h3 - 2 * u1h2) % P
    ny = (r * (u1h2 - nx) - s1 * h3) % P
    nz = h * z1 * z2 % P
    return (nx, ny, nz)


def _mul_jac(k, pt):
    r = (0, 1, 0)
    q = _jac(pt)
    while k:
        if k & 1:
            r = _add(r, q)
        q = _double(q)
        k >>= 1
    return r


def scalar_mult(k, pt):
    return _affine(_mul_jac(k, pt))


def on_curve(pt):
    x, y = pt
    return 0 <= x < P and 0 <= y < P and (y * y - (x * x * x + A * x + B)) % P == 0


# ------------------------------------------------------------------
#  Kunci
# ------------------------------------------------------------------
def generate():
    """Kembalikan (d, Q): kunci rahasia d dan kunci publik Q."""
    d = secrets.randbelow(N - 1) + 1
    return d, scalar_mult(d, G)


def public_from_private(d):
    if not 1 <= d < N:
        raise KeyError_("kunci rahasia di luar rentang")
    return scalar_mult(d, G)


def _pem(label, der):
    b64 = base64.b64encode(der).decode()
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----\n"


def _unpem(text):
    lines = [l.strip() for l in text.strip().splitlines()]
    if not lines or not lines[0].startswith("-----BEGIN ") or not lines[-1].startswith("-----END "):
        raise KeyError_("bukan file PEM")
    label = lines[0][len("-----BEGIN "):].rstrip("-")
    try:
        der = base64.b64decode("".join(l for l in lines[1:-1] if l and ":" not in l), validate=True)
    except Exception as e:
        raise KeyError_(f"isi PEM rusak: {e}")
    return label, der


def _point_bytes(Q):
    return b"\x04" + Q[0].to_bytes(32, "big") + Q[1].to_bytes(32, "big")


def public_pem(Q):
    return _pem("PUBLIC KEY", _SPKI_PREFIX + _point_bytes(Q))


def private_pem(d):
    Q = public_from_private(d)
    der = (bytes.fromhex("30770201010420") + d.to_bytes(32, "big") +
           bytes.fromhex("a00a06082a8648ce3d030107a144034200") + _point_bytes(Q))
    return _pem("EC PRIVATE KEY", der)


def _tlv(b, i):
    if i + 2 > len(b):
        raise KeyError_("DER terpotong")
    tag = b[i]
    ln = b[i + 1]
    i += 2
    if ln & 0x80:
        n = ln & 0x7F
        if n == 0 or n > 2 or i + n > len(b):
            raise KeyError_("panjang DER tidak sah")
        ln = int.from_bytes(b[i:i + n], "big")
        i += n
    if i + ln > len(b):
        raise KeyError_("DER terpotong")
    return tag, b[i:i + ln], i + ln


def _parse_sec1(der):
    tag, body, _ = _tlv(der, 0)
    if tag != 0x30:
        raise KeyError_("struktur kunci tidak dikenal")
    tag, ver, i = _tlv(body, 0)
    if tag != 0x02 or ver != b"\x01":
        raise KeyError_("versi kunci EC tidak dikenal")
    tag, dbytes, i = _tlv(body, i)
    if tag != 0x04:
        raise KeyError_("kunci rahasia tidak ditemukan")
    while i < len(body):
        tag, val, i = _tlv(body, i)
        if tag == 0xA0:
            t2, oid, _ = _tlv(val, 0)
            if t2 != 0x06 or oid != _OID_P256:
                raise KeyError_("kunci ini bukan kurva P-256 (prime256v1)")
    return int.from_bytes(dbytes, "big")


def load_private_pem(text):
    """Baca kunci rahasia: format 'EC PRIVATE KEY' (SEC1) atau 'PRIVATE KEY' (PKCS#8)."""
    label, der = _unpem(text)
    if label == "EC PRIVATE KEY":
        d = _parse_sec1(der)
    elif label == "PRIVATE KEY":
        tag, body, _ = _tlv(der, 0)
        _, _, i = _tlv(body, 0)                 # versi
        tag, alg, i = _tlv(body, i)
        if tag != 0x30 or _OID_EC_PUBKEY not in alg or _OID_P256 not in alg:
            raise KeyError_("kunci ini bukan EC P-256")
        tag, inner, _ = _tlv(body, i)
        d = _parse_sec1(inner)
    elif label.endswith("ENCRYPTED PRIVATE KEY"):
        raise KeyError_("kunci terenkripsi belum didukung; buat kunci dengan keygen.py")
    else:
        raise KeyError_(f"jenis PEM '{label}' bukan kunci rahasia EC")
    public_from_private(d)
    return d


def load_public_pem(text):
    label, der = _unpem(text)
    if label != "PUBLIC KEY" or not der.startswith(_SPKI_PREFIX) or len(der) != len(_SPKI_PREFIX) + 65:
        raise KeyError_("bukan kunci publik EC P-256")
    pt = der[len(_SPKI_PREFIX):]
    if pt[0] != 4:
        raise KeyError_("format titik kunci publik tidak didukung")
    Q = (int.from_bytes(pt[1:33], "big"), int.from_bytes(pt[33:], "big"))
    if not on_curve(Q):
        raise KeyError_("kunci publik tidak berada di kurva P-256")
    return Q


# ------------------------------------------------------------------
#  Tanda tangan
# ------------------------------------------------------------------
def _rfc6979_k(d, h):
    x = d.to_bytes(32, "big")
    hm = (int.from_bytes(h, "big") % N).to_bytes(32, "big")
    v = b"\x01" * 32
    k = b"\x00" * 32
    k = hmac.new(k, v + b"\x00" + x + hm, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + hm, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        cand = int.from_bytes(v, "big")
        if 1 <= cand < N:
            yield cand
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def _der_int(v):
    b = v.to_bytes((v.bit_length() + 7) // 8 or 1, "big")
    if b[0] & 0x80:
        b = b"\x00" + b
    return b"\x02" + bytes([len(b)]) + b


def _der_sig(r, s):
    body = _der_int(r) + _der_int(s)
    return b"\x30" + bytes([len(body)]) + body


def parse_der_sig(sig):
    tag, body, end = _tlv(sig, 0)
    if tag != 0x30 or end != len(sig):
        raise KeyError_("tanda tangan bukan DER")
    tag, rb, i = _tlv(body, 0)
    if tag != 0x02:
        raise KeyError_("tanda tangan bukan DER")
    tag, sb, i = _tlv(body, i)
    if tag != 0x02 or i != len(body):
        raise KeyError_("tanda tangan bukan DER")
    return int.from_bytes(rb, "big"), int.from_bytes(sb, "big")


def sign(d, message):
    """Tanda tangan DER (bytes) untuk message (bytes)."""
    h = hashlib.sha256(message).digest()
    e = int.from_bytes(h, "big")
    for k in _rfc6979_k(d, h):
        R = scalar_mult(k, G)
        r = R[0] % N
        if r == 0:
            continue
        s = _inv(k, N) * (e + r * d) % N
        if s == 0:
            continue
        if s > N // 2:                           # bentuk "low-S", diterima semua pemeriksa
            s = N - s
        return _der_sig(r, s)


def verify(Q, message, sig):
    try:
        r, s = parse_der_sig(sig)
    except KeyError_:
        return False
    if not (1 <= r < N and 1 <= s < N):
        return False
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = _inv(s, N)
    X = _affine(_add(_mul_jac(e * w % N, G), _mul_jac(r * w % N, Q)))
    return X is not None and X[0] % N == r


def fingerprint(Q):
    """Sidik jari pendek kunci publik, untuk dicocokkan dengan log ESP."""
    return hashlib.sha256(_SPKI_PREFIX + _point_bytes(Q)).hexdigest()[:16]
