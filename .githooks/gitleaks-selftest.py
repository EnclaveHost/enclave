#!/usr/bin/env python3
"""gitleaks-selftest.py -- the repository's .gitleaks.toml must FIND private keys and must NOT flag the look-alikes it is
meant to tolerate, checked by running the real gitleaks on data generated for this run.

Why it exists: an UNSCOPED global allowlist for a bare 64-hex value silenced every ethereum-private-key-* rule (their
secret IS a bare 64-hex), and nothing noticed until enclave-53 planted keys by hand (2026-09-25). This check makes that
class of regression fail in CI and at push time, instead of waiting for someone to plant a key again.

Every key-like value here is generated at run time from os.urandom, written only to a temporary directory OUTSIDE the
repository, never printed, and deleted on exit. The one fixed value, a well-known PUBLIC test key, is read at run time
from the config's own value allowlist, so this file carries no key-shaped literal and stays fully scanned itself.

  python3 .githooks/gitleaks-selftest.py [--config PATH] [--gitleaks PATH]
Exit status: 0 every expectation holds; 1 an expectation failed; 2 gitleaks or the config could not be used.
"""
import json, os, re, secrets, shutil, subprocess, sys, tempfile, tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
CRYPTO_RULES = ["bitcoin-wif-private-key", "bip32-extended-private-key", "bip39-mnemonic-labelled", "ethereum-private-key-labelled",
                "ethereum-private-key-env", "ethereum-private-key-constructor", "web3-keystore-json"]
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def arg(name, default=None):
    a = sys.argv[1:]
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else default


def find_gitleaks():
    for c in (arg("--gitleaks"), os.environ.get("GITLEAKS"), shutil.which("gitleaks"), os.path.expanduser("~/.local/bin/gitleaks")):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def hex64():
    return secrets.token_hex(32)


def public_test_key(cfg):
    """The first well-known public test key the labelled rule allowlists by value (read from the config, never typed here)."""
    for r in cfg.get("rules", []):
        if r.get("id") == "ethereum-private-key-labelled":
            for al in r.get("allowlists", []):
                for rx in al.get("regexes", []):
                    m = re.search(r"[0-9a-f]{64}", rx)
                    if m:
                        return m.group(0)
    return None


def cases(cfg):
    """(file name, text, rules that MUST fire (subset), must be clean). Built fresh each run."""
    k = [hex64() for _ in range(6)]
    h = [hex64() for _ in range(8)]
    sig = secrets.token_hex(64)
    addr = secrets.token_hex(20)
    b58 = "5" + "".join(secrets.choice(B58) for _ in range(50))          # the WIF SHAPE (random base58; not a key, a marker)
    pat = "ghp_" + "".join(secrets.choice("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") for _ in range(36))
    known = public_test_key(cfg)
    positive = [
        ("labelled.js", f'const operatorKey = "0x{k[0]}";\n', {"ethereum-private-key-labelled"}),
        ("labelled.yaml", f'signer_key: "{k[1]}"\n', {"ethereum-private-key-labelled"}),
        ("deploy.env", f"DEPLOYER_PRIVATE_KEY={k[2]}\n", {"ethereum-private-key-env"}),
        ("ctor.mjs", f'const acct = privateKeyToAccount("0x{k[3]}");\n', {"ethereum-private-key-constructor"}),
        ("cast.sh", f"cast send --private-key {k[4]} 0x{addr} 'f()'\n", {"ethereum-private-key-constructor"}),
        ("wif.txt", f"backup: {b58}\n", {"bitcoin-wif-private-key"}),
        # assembled at run time, so this source is not itself a keystore to the scanner
        ("keystore.json", json.dumps({"crypto": {"kdf": "scr" + "ypt", "ciphertext": secrets.token_hex(32)}}) + "\n", {"web3-keystore-json"}),
        ("token.txt", f"GITHUB_TOKEN={pat}\n", {"github-pat"}),   # a default provider rule still active
    ]
    negative = [
        ("digests.json", json.dumps({"sha256": h[0], "digest": h[1], "measurement": h[2], "cacheKey": h[3], "txHash": "0x" + h[4]}) + "\n"),
        ("hash-labelled.js", f'const operatorKeyHash = "0x{h[5]}";\nconst signerKeyFingerprint = "{h[6]}";\n'),
        ("hash.env", f"PROOF_KEY_SHA256={h[7]}\n"),
        # signatures under non-key field names; a signature under a KEY-named field (appKeySig) is tolerated only by
        # path-scoped allowlists for the evidence directories that hold them, never by a global 128-hex rule: a 64-byte
        # Ed25519 private key is 128 hex too
        ("signature.json", json.dumps({"signature": "0x" + sig + "1b", "sig": sig}) + "\n"),
        ("address.js", f'const operatorKeyAddress = "0x{addr}";\n'),
        ("spki.txt", "transportKey: 302a300506032b6570032100" + secrets.token_hex(32) + "\n"),
        *([("public-test-key.js", f'const operatorKey = "0x{known}";\n')] if known else []),
        ("token-digest.json", json.dumps({"tokenSha256": secrets.token_hex(32)}) + "\n"),
    ]
    return positive, negative


def structural(cfg_path, failures):
    """No GLOBAL allowlist may match a bare 64-hex secret for a crypto rule: each one that would must name targetRules,
    none of them a crypto rule."""
    with open(cfg_path, "rb") as f:
        cfg = tomllib.load(f)
    probe = [hex64(), "0x" + hex64()]
    for i, al in enumerate(cfg.get("allowlists", [])):
        if al.get("regexTarget", "secret") != "secret":
            continue
        swallows = False
        for rx in al.get("regexes", []):
            try:
                r = re.compile(rx)
            except re.error:
                continue          # Go-only syntax; the behavioural cases below still decide
            if any(r.search(p) for p in probe):
                swallows = True
        if not swallows:
            continue
        targets = al.get("targetRules")
        if not targets:
            failures.append(f"global allowlist #{i} ({al.get('description', '')[:60]!r}) matches a bare 64-hex secret for EVERY rule: give it targetRules")
        elif set(targets) & set(CRYPTO_RULES):
            failures.append(f"global allowlist #{i} matches a bare 64-hex secret for crypto rule(s) {sorted(set(targets) & set(CRYPTO_RULES))}")
    ids = {r.get("id") for r in cfg.get("rules", [])}
    for r in CRYPTO_RULES:
        if r not in ids:
            failures.append(f"crypto rule {r} is missing from the config")


def main():
    cfg = os.path.abspath(arg("--config", os.path.join(HERE, "..", ".gitleaks.toml")))
    gl = find_gitleaks()
    if not gl:
        print("gitleaks-selftest: gitleaks not found (install it, or pass --gitleaks PATH)", file=sys.stderr)
        return 2
    if not os.path.isfile(cfg):
        print(f"gitleaks-selftest: no config at {cfg}", file=sys.stderr)
        return 2
    failures = []
    try:
        with open(cfg, "rb") as f:
            parsed = tomllib.load(f)
        structural(cfg, failures)
    except Exception as e:
        print(f"gitleaks-selftest: the config does not parse: {e}", file=sys.stderr)
        return 2
    positive, negative = cases(parsed)
    tmp = tempfile.mkdtemp(prefix="gitleaks-selftest-")
    try:
        for name, text, *_ in positive + negative:
            with open(os.path.join(tmp, name), "w") as f:
                f.write(text)
        report = os.path.join(tmp, ".report.json")
        p = subprocess.run([gl, "dir", tmp, "--config", cfg, "--no-banner", "--redact=100", "--exit-code", "0",
                            "--report-format", "json", "--report-path", report], capture_output=True, text=True)
        if p.returncode != 0 or not os.path.isfile(report):
            print(f"gitleaks-selftest: gitleaks failed (exit {p.returncode}): {(p.stderr or p.stdout).strip().splitlines()[-1:] }", file=sys.stderr)
            return 2
        with open(report) as f:
            found = json.load(f)
        by_file = {}
        for x in found:
            by_file.setdefault(os.path.basename(x.get("File", "")), set()).add(x.get("RuleID"))
        for name, _text, want in positive:
            got = by_file.get(name, set())
            if not want <= got:
                failures.append(f"MISSED: {name} should be found by {sorted(want)}; gitleaks found {sorted(got) or 'nothing'}")
        for name, _text in negative:
            got = by_file.get(name, set())
            if got:
                failures.append(f"FALSE POSITIVE: {name} (a tolerated look-alike) was flagged by {sorted(got)}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if failures:
        print("gitleaks-selftest: FAILED", file=sys.stderr)
        for m in failures:
            print(f"  {m}", file=sys.stderr)
        return 1
    print(f"gitleaks-selftest: {len(positive)} generated secrets found by their rules, {len(negative)} look-alikes tolerated, "
          f"no global allowlist swallows a bare 64-hex secret ({os.path.relpath(cfg)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
