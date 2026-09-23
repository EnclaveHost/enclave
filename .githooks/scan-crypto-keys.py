#!/usr/bin/env python3
"""Refuse commits that carry cryptocurrency private keys.

GitHub's free-plan secret scanning only knows provider tokens (AWS, Stripe,
GitHub...). A raw Ethereum/Bitcoin key is just 64 hex characters, a WIF string
or twelve dictionary words, and nothing on GitHub's side blocks those. This
scanner does, at pre-commit / pre-push time (.githooks/) and in CI
(.github/workflows/secret-scan.yml). It needs only python3 and git.

What it refuses (each check is precise where the format allows it):
  wif        Bitcoin WIF private key       -> base58check checksum VERIFIED
  xprv       BIP32 extended private key    -> base58check checksum VERIFIED
  mnemonic   BIP39 seed phrase (12-24 wd)  -> wordlist + checksum VERIFIED
  keystore   Ethereum/web3 keystore JSON   -> "kdf" + "ciphertext" together
  eth-known  a 32-byte hex scalar whose secp256k1 address is one of THIS
             project's wallets/contracts   -> derived, not guessed
  eth-key    a 32-byte hex literal assigned to something called a private
             key / secret / signer / operator key, passed to a wallet
             constructor, or set in a *KEY= / *SECRET= env line

Anything else that is 64 hex characters (sha256 digests, topics, CIDs,
measurements, volume ids) is NOT a finding: this repo is full of those.

Usage:
  scan-crypto-keys.py --range <git log args...>   added lines of those commits
                                                  (e.g. A..B, "X --not --remotes=origin", --all)
  scan-crypto-keys.py --staged                     the staged diff (pre-commit)
  scan-crypto-keys.py --files <path...>            whole files
  scan-crypto-keys.py --stdin                      text on stdin
  scan-crypto-keys.py --selftest                   generate fresh secrets, assert detection
Exit status: 0 clean, 1 findings (report on stderr), 2 usage/internal error.
Bypass for a confirmed false positive: git commit/push --no-verify.
"""
import hashlib, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- allowlists
# Hardhat / Anvil default accounts 0-9: public test keys, in every tutorial.
HARDHAT_KEYS = {
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
}
HARDHAT_MNEMONIC = "test test test test test test test test test test test junk"
# English function words that happen to be BIP39 words. A random seed phrase
# almost never holds three of them; a window of prose almost always does.
GLUE = set("""this that with from have will also into over than then when what which there
other more most such only like make just about would could they here where very upon
among all any can must much own same still while""".split())
# words may be separated only by whitespace, commas, quotes and brackets (how a
# phrase is written down or quoted); any other punctuation or a non-wordlist
# token breaks the run, so minified code and macros do not form runs.
TOKEN = re.compile(r"[A-Za-z0-9_]+|[^A-Za-z0-9_\s,\"'\[\]]+")
SKIP_PATH = re.compile(r"(^|/)node_modules/|^\.githooks/bip39-english\.txt$")

# ---------------------------------------------------------------- primitives
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + body

def b58check(s):
    """payload if the 4-byte double-sha256 checksum verifies, else None"""
    try:
        raw = b58decode(s)
    except ValueError:
        return None
    if len(raw) < 5:
        return None
    payload, cs = raw[:-4], raw[-4:]
    return payload if hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4] == cs else None

def b58encode(b):
    n = int.from_bytes(b, "big"); out = ""
    while n:
        n, r = divmod(n, 58); out = B58[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + out

def b58check_encode(payload):
    return b58encode(payload + hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4])

_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
       0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
       0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
       0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M64 = (1 << 64) - 1

def keccak256(data):
    """Original Keccak-256 (Ethereum's), NOT hashlib.sha3_256 (different padding)."""
    def rol(x, n):
        n %= 64
        return ((x << n) | (x >> (64 - n))) & _M64 if n else x
    def f(A):
        for rc in _RC:
            C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
            D = [C[(x - 1) % 5] ^ rol(C[(x + 1) % 5], 1) for x in range(5)]
            A = [[A[x][y] ^ D[x] for y in range(5)] for x in range(5)]
            B = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    B[y][(2 * x + 3 * y) % 5] = rol(A[x][y], _ROT[x][y])
            A = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
            A[0][0] ^= rc
        return A
    rate = 136
    msg = bytearray(data) + b"\x01"
    msg += b"\x00" * (-len(msg) % rate)
    msg[-1] |= 0x80
    A = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        for i in range(rate // 8):
            A[i % 5][i // 5] ^= int.from_bytes(msg[off + 8 * i: off + 8 * i + 8], "little")
        A = f(A)
    return b"".join(A[i % 5][i // 5].to_bytes(8, "little") for i in range(4))

_P = 2 ** 256 - 2 ** 32 - 977
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
      0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

def _jdbl(X, Y, Z):
    if Y == 0 or Z == 0:
        return (0, 0, 0)
    S = (4 * X * Y * Y) % _P; M = (3 * X * X) % _P
    X3 = (M * M - 2 * S) % _P
    return X3, (M * (S - X3) - 8 * pow(Y, 4, _P)) % _P, (2 * Y * Z) % _P

def _jadd(X1, Y1, Z1, X2, Y2, Z2):
    if Z1 == 0:
        return X2, Y2, Z2
    if Z2 == 0:
        return X1, Y1, Z1
    U1 = (X1 * Z2 * Z2) % _P; U2 = (X2 * Z1 * Z1) % _P
    S1 = (Y1 * pow(Z2, 3, _P)) % _P; S2 = (Y2 * pow(Z1, 3, _P)) % _P
    if U1 == U2:
        return _jdbl(X1, Y1, Z1) if S1 == S2 else (0, 0, 0)
    H = (U2 - U1) % _P; R = (S2 - S1) % _P
    H2 = H * H % _P; H3 = H * H2 % _P
    X3 = (R * R - H3 - 2 * U1 * H2) % _P
    return X3, (R * (U1 * H2 - X3) - S1 * H3) % _P, (H * Z1 * Z2) % _P

_addr_cache = {}
def eth_address(hexkey):
    """0x-prefixed lowercase address for a 32-byte scalar, or None if not a valid key."""
    k = int(hexkey, 16)
    if not (0 < k < _N):
        return None
    if hexkey in _addr_cache:
        return _addr_cache[hexkey]
    Rx, Ry, Rz = 0, 0, 0
    Qx, Qy, Qz = _G[0], _G[1], 1
    while k:
        if k & 1:
            Rx, Ry, Rz = _jadd(Rx, Ry, Rz, Qx, Qy, Qz)
        Qx, Qy, Qz = _jdbl(Qx, Qy, Qz)
        k >>= 1
    zi = pow(Rz, -1, _P)
    x = (Rx * zi * zi) % _P; y = (Ry * pow(zi, 3, _P)) % _P
    addr = "0x" + keccak256(x.to_bytes(32, "big") + y.to_bytes(32, "big"))[12:].hex()
    _addr_cache[hexkey] = addr
    return addr

def load_words(path):
    with open(path, encoding="ascii") as f:
        words = [w.strip() for w in f if w.strip()]
    if len(words) != 2048:
        raise SystemExit(f"{path}: expected 2048 BIP39 words, got {len(words)}")
    return {w: i for i, w in enumerate(words)}

BIP39 = load_words(os.path.join(HERE, "bip39-english.txt"))
BIP39_WORDS = [w for w, _ in sorted(BIP39.items(), key=lambda kv: kv[1])]

def bip39_valid(words):
    n = len(words)
    if n not in (12, 15, 18, 21, 24):
        return False
    bits = 0
    for w in words:
        bits = (bits << 11) | BIP39[w]
    cs_len = n * 11 // 33
    ent_len = n * 11 - cs_len
    entropy = (bits >> cs_len).to_bytes(ent_len // 8, "big")
    return (hashlib.sha256(entropy).digest()[0] >> (8 - cs_len)) == (bits & ((1 << cs_len) - 1))

def load_known_addresses():
    known = set()
    p = os.path.join(HERE, "known-addresses.txt")
    if os.path.exists(p):
        with open(p) as f:
            for line in f:
                line = line.split("#", 1)[0].strip().lower()
                if re.fullmatch(r"0x[0-9a-f]{40}", line):
                    known.add(line)
    return known

KNOWN = load_known_addresses()

def low_entropy(h):
    if len(set(h)) <= 4:
        return True
    return any(h == h[:k] * (64 // k) for k in (1, 2, 4, 8, 16, 32))

# ---------------------------------------------------------------- patterns
HEX64 = re.compile(r"(?<![0-9a-zA-Z])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-zA-Z])")
WIF = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])[5KL9c][1-9A-HJ-NP-Za-km-z]{50,51}(?![1-9A-HJ-NP-Za-km-z])")
XPRV = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])[xyztuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{100,112}(?![1-9A-HJ-NP-Za-km-z])")
KEYWORDED = re.compile(r"""(?ix)
    (?: private[_\s-]?key | privkey | priv[_\s-]?key | secret[_\s-]?key | signing[_\s-]?key
      | (?:operator|deployer|registry|wallet|owner|admin|funder|payer|relayer|burner|governance|signer|account|eoa|mint|minter)[_\s-]?(?:private[_\s-]?)?key
      | \bpk\b | \bsk\b | \bprivate\b | \bsecret\b )
    [^\n]{0,24}? [:=] [^\n]{0,8}? ["'`]? (?:0x)? ([0-9a-fA-F]{64}) (?![0-9a-zA-Z])""")
ENVLINE = re.compile(r"""(?m)^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:KEY|SECRET|PRIV|_PK|_SK)[A-Z0-9_]*)\s*=\s*["']?(?:0x)?([0-9a-fA-F]{64})(?![0-9a-zA-Z])""")
CALL = re.compile(r"""(?ix)
    (?: privateKeyToAccount | new\s+(?:ethers\.)?Wallet | Wallet\.fromPrivateKey | fromPrivateKey | fromPrivate
      | --private-key(?:=|\s+) | --priv(?:ate)?(?:=|\s+) | -k\s+ | PrivateKey\.fromHex | ECPair\.fromPrivateKey
      | bip32\.fromPrivateKey | Account\.from_key | account\.from_key | from_key | privateKeyToAddress
      | signingKey | SigningKey | LocalAccount | Keypair\.from )
    \s* \(? \s* ["'`]? (?:0x)? ([0-9a-fA-F]{64}) (?![0-9a-zA-Z])""")
NOISE = re.compile(r"(?i)sha-?256|sha3|keccak|digest|hash|measurement|topic|blob|commit|tree|txid|tx[_ ]?hash|merkle|root|\bcid\b|checksum|fingerprint|thumbprint|hmac|\bmac\b|salt|nonce|\biv\b|\btag\b|vol[_ ]?id|[a-z]+[_ ]?id\b|\bid\b|pub(?:lic)?[_ -]?key|pubkey|encrypted|cipher|verifying")
NAME_NOISE = re.compile(r"(?i)PUB|HASH|DIGEST|SHA|MEASUREMENT|TOPIC|ID$|_ID_|CID|ROOT|SALT|NONCE|HMAC|MAC$|TAG$|ENCRYPTED|CIPHER")
KEYSTORE = re.compile(r'"kdf"\s*:\s*"(?:scrypt|pbkdf2)"')
CIPHERTEXT = re.compile(r'"ciphertext"\s*:\s*"[0-9a-fA-F]{32,}"')

def redact(s):
    return s[:6] + "…" + s[-4:] if len(s) > 14 else "…"

# ---------------------------------------------------------------- scanning
class Finding:
    def __init__(self, rule, path, line, commit, value, note=""):
        self.rule, self.path, self.line, self.commit, self.value, self.note = rule, path, line, commit, value, note
    def __str__(self):
        where = f"{self.path}:{self.line}" if self.path else f"line {self.line}"
        if self.commit:
            where = f"{self.commit[:10]} {where}"
        return f"  [{self.rule}] {where}: {redact(self.value)}{('  ' + self.note) if self.note else ''}"

def scan_lines(lines, path="", commit="", out=None):
    """lines: iterable of (lineno, text). Appends Findings to out."""
    out = out if out is not None else []
    if path and SKIP_PATH.search(path):
        return out
    tokens = []            # (word, lineno) stream for wrapped mnemonics
    seen_keystore = seen_cipher = None
    for ln, text in lines:
        if len(text) > 200000:
            text = text[:200000]
        for m in WIF.finditer(text):
            p = b58check(m.group(0))
            if p and len(p) in (33, 34) and p[0] in (0x80, 0xEF) and (len(p) == 33 or p[-1] == 0x01):
                out.append(Finding("wif", path, ln, commit, m.group(0), "Bitcoin WIF private key (checksum verified)"))
        for m in XPRV.finditer(text):
            p = b58check(m.group(0))
            if p and len(p) == 78 and p[45] == 0:
                out.append(Finding("xprv", path, ln, commit, m.group(0), "BIP32 extended private key (checksum verified)"))
        if KEYSTORE.search(text):
            seen_keystore = ln
        if CIPHERTEXT.search(text):
            seen_cipher = ln
        # 32-byte hex scalars
        hexes = [(m.start(1), m.group(1).lower()) for m in HEX64.finditer(text)]
        if hexes:
            flagged = set()
            for m in KEYWORDED.finditer(text):
                h = m.group(1).lower()
                if h in HARDHAT_KEYS or low_entropy(h) or NOISE.search(text[m.start():m.start(1)]):
                    continue
                flagged.add(h)
                out.append(Finding("eth-key", path, ln, commit, h, "hex private key assigned to a key/secret field"))
            for m in ENVLINE.finditer(text):
                h = m.group(2).lower()
                if h in flagged or h in HARDHAT_KEYS or low_entropy(h) or NAME_NOISE.search(m.group(1)):
                    continue
                flagged.add(h)
                out.append(Finding("eth-key", path, ln, commit, h, f"hex private key in env line {m.group(1)}="))
            for m in CALL.finditer(text):
                h = m.group(1).lower()
                if h in flagged or h in HARDHAT_KEYS or low_entropy(h):
                    continue
                flagged.add(h)
                out.append(Finding("eth-key", path, ln, commit, h, "hex private key passed to a wallet/signer constructor"))
            if KNOWN:
                for _, h in hexes:
                    if h in flagged or h in HARDHAT_KEYS or low_entropy(h):
                        continue
                    a = eth_address(h)
                    if a and a in KNOWN:
                        flagged.add(h)
                        out.append(Finding("eth-known", path, ln, commit, h, f"is the private key of {a} (a wallet this project uses)"))
        tokens.append((ln, text))
    if seen_keystore is not None and seen_cipher is not None:
        out.append(Finding("keystore", path, seen_keystore, commit, "keystore", "encrypted web3 keystore JSON (kdf + ciphertext)"))
    # mnemonics: maximal runs of lowercase wordlist words (lines joined, so a
    # wrapped phrase still forms one run); any valid 12/15/18/21/24 window.
    if tokens:
        starts, buf, pos = [], [], 0
        for ln, text in tokens:
            starts.append((pos, ln)); buf.append(text); pos += len(text) + 1
        joined = "\n".join(buf)
        def line_of(off):
            lo, hi = 0, len(starts) - 1
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if starts[mid][0] <= off: lo = mid
                else: hi = mid - 1
            return starts[lo][1]
        run = []
        def flush(run):
            if len(run) < 12:
                return
            words = [w for w, _ in run]
            reported = []
            for size in (24, 21, 18, 15, 12):
                for i in range(0, len(words) - size + 1):
                    win = words[i:i + size]
                    if len(set(win)) < size - 1 or sum(w in GLUE for w in win) >= 3:
                        continue
                    if any(i < e and i + size > b for b, e in reported) or not bip39_valid(win):
                        continue
                    phrase = " ".join(win)
                    if phrase == HARDHAT_MNEMONIC:
                        continue
                    reported.append((i, i + size))
                    out.append(Finding("mnemonic", path, line_of(run[i][1]), commit, phrase, f"BIP39 {size}-word seed phrase (checksum verified)"))
        for m in TOKEN.finditer(joined):
            t = m.group(0)
            if t in BIP39:
                run.append((t, m.start()))
            else:
                flush(run); run = []
        flush(run)
    return out

def scan_text(text, path="", commit=""):
    return scan_lines(((i + 1, l) for i, l in enumerate(text.splitlines())), path, commit)

def scan_diff(stream, commit_prefix="commit:"):
    """Parse `git log -p -U0 --format=commit:%H` or `git diff -U0` output; scan added lines."""
    findings = []
    commit = ""; path = None; expect_plus = False
    lines = []; lineno = 0
    def flush():
        nonlocal lines
        if path and lines:
            scan_lines(lines, path, commit, findings)
        lines = []
    for raw in stream:
        line = raw.rstrip("\n")
        if line.startswith(commit_prefix):
            flush(); commit = line[len(commit_prefix):].strip(); path = None
        elif line.startswith("diff --git "):
            flush(); path = None; expect_plus = False
        elif line.startswith("--- "):
            expect_plus = True
        elif expect_plus and line.startswith("+++ "):
            expect_plus = False
            name = line[4:]
            path = None if name == "/dev/null" else (name[2:] if name.startswith("b/") else name)
        elif line.startswith("@@"):
            m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
            lineno = int(m.group(1)) if m else 0
        elif line.startswith("+") and path is not None:
            lines.append((lineno, line[1:])); lineno += 1
        else:
            if line.startswith("-") is False and line and not line.startswith("\\"):
                pass
    flush()
    return findings

def git_lines(args):
    p = subprocess.Popen(["git"] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors="replace")
    for line in p.stdout:
        yield line
    p.wait()
    if p.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {p.stderr.read().strip()}")

def report(findings, what):
    if not findings:
        return 0
    sys.stderr.write(f"\nscan-crypto-keys: REFUSED - {len(findings)} cryptocurrency private key(s) in {what}\n")
    for f in findings:
        sys.stderr.write(str(f) + "\n")
    sys.stderr.write("\nA committed key is public the moment it is pushed and cannot be un-published,\n"
                     "only rotated. Remove it from the commit (git reset / rebase) and move the\n"
                     "secret to metal/config.json, a .env file or the deployment secrets store.\n"
                     "Confirmed false positive? Re-run with --no-verify.\n")
    return 1

# ---------------------------------------------------------------- selftest
def selftest():
    import secrets as rnd
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert eth_address("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") == "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
    assert bip39_valid(HARDHAT_MNEMONIC.split())
    key = rnd.token_bytes(32)
    wif_c = b58check_encode(b"\x80" + key + b"\x01")
    wif_u = b58check_encode(b"\x80" + key)
    xprv = b58check_encode(bytes.fromhex("0488ADE4") + b"\x00" * 9 + rnd.token_bytes(32) + b"\x00" + key)
    ent = rnd.token_bytes(16)
    bits = (int.from_bytes(ent, "big") << 4) | (hashlib.sha256(ent).digest()[0] >> 4)
    mnemonic = " ".join(BIP39_WORDS[(bits >> (11 * (11 - i))) & 2047] for i in range(12))
    assert bip39_valid(mnemonic.split())
    kh = key.hex()
    ka = eth_address(kh)
    KNOWN.add(ka)
    digest = hashlib.sha256(b"x").hexdigest()
    cases = {  # text -> expected rule or None
        f"BTC_WIF={wif_c}": "wif",
        f"uncompressed {wif_u} here": "wif",
        f'"xprv": "{xprv}"': "xprv",
        f"backup: {mnemonic}": "mnemonic",
        "wrapped:\n" + " ".join(mnemonic.split()[:7]) + "\n" + " ".join(mnemonic.split()[7:]): "mnemonic",
        f"PRIVATE_KEY=0x{rnd.token_hex(32)}": "eth-key",
        f"export OPERATOR_KEY='{rnd.token_hex(32)}'": "eth-key",
        f'  "registryKey": "0x{rnd.token_hex(32)}",': "eth-key",
        f"const signer = new ethers.Wallet('0x{rnd.token_hex(32)}')": "eth-key",
        f"cast send --private-key 0x{rnd.token_hex(32)} ...": "eth-key",
        f"privateKeyToAccount(\"0x{rnd.token_hex(32)}\")": "eth-key",
        f"secret: {rnd.token_hex(32)}": "eth-key",
        f"// unlabeled but it is OUR wallet's key: {kh}": "eth-known",
        f'{{"kdf": "scrypt", "ciphertext": "{rnd.token_hex(32)}"}}': "keystore",
        # must pass
        f"sha256: {digest}": None,
        f"tokenSha256: \"{digest}\"": None,
        f'"privateKeyHash": "{digest}"': None,
        f"MEASUREMENT_KEY={digest}": None,
        f"const DEP_CREATED_TOPIC = \"0x{digest}\";": None,
        f"privateKey: \"0x{'ab' * 32}\"": None,
        f"PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80": None,
        f"mnemonic: {HARDHAT_MNEMONIC}": None,
        "the quick brown fox jumps over the lazy dog again and again and again and again": None,
        "#define REDUCE32(OFF) STAGE(OFF, 16, 16) STAGE(OFF, 8, 8) STAGE(OFF, 4, 4) STAGE(OFF, 2, 2) STAGE(OFF, 1, 1)": None,
        "switch(t){case ee.Mobile:return{isMobile:!0};case ee.Tablet:return{isTablet:!0};case ee.SmartTv:return{isSmartTV:!0};case ee.Console:return{isConsole:!0}}": None,
        "| Message | Audience Need | Proof Point | need proof point message need evidence message need evidence message need evidence |": None,
        "this.parse=this.parse.bind(this),this.safeParse=this.safeParse.bind(this),this.parseAsync=this.parseAsync.bind(this)": None,
        # a real phrase survives being quoted / comma-separated / in a JSON array
        '"mnemonic": ["' + '", "'.join(mnemonic.split()) + '"]': "mnemonic",
        f"ipfs QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG {'K' + 'x' * 50}": None,
    }
    bad = 0
    for text, want in cases.items():
        got = [f.rule for f in scan_text(text)]
        ok = (got == [] if want is None else want in got)
        if not ok:
            bad += 1; print(f"FAIL want={want} got={got}: {text[:80]!r}")
    KNOWN.discard(ka)
    print(f"selftest: {len(cases) - bad}/{len(cases)} cases ok")
    return 0 if bad == 0 else 1

def main(argv):
    if not argv:
        print(__doc__); return 2
    mode, rest = argv[0], argv[1:]
    if mode == "--selftest":
        return selftest()
    if mode == "--range":
        if not rest:
            print("--range needs git log arguments"); return 2
        f = scan_diff(git_lines(["log", "--no-color", "-p", "-U0", "--no-ext-diff", "--diff-filter=AMCR", "--format=commit:%H"] + rest))
        return report(f, f"commits {' '.join(rest)}")
    if mode == "--staged":
        f = scan_diff(git_lines(["diff", "--cached", "--no-color", "-U0", "--no-ext-diff", "--diff-filter=AMCR"]))
        return report(f, "the staged changes")
    if mode == "--files":
        f = []
        for p in rest:
            try:
                with open(p, encoding="utf-8", errors="replace") as fh:
                    f += scan_text(fh.read(), p)
            except OSError as e:
                sys.stderr.write(f"{p}: {e}\n")
        return report(f, f"{len(rest)} file(s)")
    if mode == "--stdin":
        return report(scan_text(sys.stdin.read()), "stdin")
    print(__doc__); return 2

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
