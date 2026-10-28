#!/usr/bin/env python3
"""BENCHMARK-ONLY client derivation (never production). Mechanical and pinned:

  input   the reviewed isolation/m2/client.mjs, sha256 ORIGINAL_SHA256; any other bytes are refused
  change  exactly one expression: request()'s socket idle timeout `r.setTimeout(60000, ...)` becomes
          `r.setTimeout(app ? 840000 : 60000, ...)`. Attestation requests pass { app: false } and keep 60 s
  rebase  the three local imports become file: URLs of the UNCHANGED original modules, so the generated file runs
          from another directory. Those modules, and every module they import relatively, are hashed into the manifest
  else    every other line is byte-identical; the line diff is checked against exactly that allowlist

  derive_client.py derive --out-dir DIR    writes DIR/client-bench-timeout.mjs and DIR/derivation-manifest.json (both new)
  derive_client.py verify --manifest FILE  re-derives from the pinned original, re-hashes dependencies, compares
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse

ORIGINAL = ("/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init/"
            "isolation/m2/client.mjs")
ORIGINAL_SHA256 = "1c6b2df07bff0fb22985e2fda55d8616f77710109ee29f835cc03d8640fa03df"
GENERATED, MANIFEST = "client-bench-timeout.mjs", "derivation-manifest.json"
APP_IDLE_MS, ATTEST_IDLE_MS = 840000, 60000

TIMEOUT_OLD = "    r.setTimeout(60000, () => r.destroy(new Error('timeout')));"
TIMEOUT_NEW = f"    r.setTimeout(app ? {APP_IDLE_MS} : {ATTEST_IDLE_MS}, () => r.destroy(new Error('timeout')));"
IMPORTS = (("import { judge } from ", "./judge.mjs"),
           ("import { startConnector, parseBindings } from ", "./port-connector.mjs"),
           ("import { seedCertChain } from ", "../../relay/snp-verify.mjs"))
# What makes `app` in TIMEOUT_NEW mean "application request": request()'s own option, true by default and false
# only on the attestation GET. The application GET passes no option. Each must appear exactly once.
REQUIRED_ONCE = ("function request(agent, method, path, body, { app = true } = {}) {",
                 "`/.well-known/enclave-attestation?nonce=${nonce.toString('hex')}`, null, { app: false });",
                 "    app = await request(agent, 'GET', appPath);")
SAFE_URL = re.compile(r"file:///[A-Za-z0-9._~/%-]+")
SPECIFIER = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"\n]+)['"]""")


class DerivationError(Exception):
    pass


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def module_url(path):
    """file: URL of an absolute path. Every byte outside [A-Za-z0-9._~/-] is percent-encoded, so no quote,
    backslash, newline or `${` from the path can reach the JS string literal the URL is written into."""
    url = "file://" + urllib.parse.quote(os.fsencode(path), safe="/")
    if not os.path.isabs(path) or not SAFE_URL.fullmatch(url):
        raise DerivationError(f"unsafe module URL {url!r}")
    return url


def import_line(prefix, spec):
    return f"{prefix}'{spec}';"


def check_allowlist(old_text, new_text, edits):
    """The diff is exactly: the timeout line to TIMEOUT_NEW, each local import to the same import of a safe file: URL."""
    a, b = old_text.split("\n"), new_text.split("\n")
    if len(a) != len(b):
        raise DerivationError("line count changed")
    allowed = {e["line"] - 1: e for e in edits}
    if len(allowed) != len(edits) or len(edits) != 1 + len(IMPORTS):
        raise DerivationError(f"expected {1 + len(IMPORTS)} distinct edited lines, got {len(edits)}")
    olds = {TIMEOUT_OLD: re.escape(TIMEOUT_NEW)}
    for prefix, spec in IMPORTS:
        olds[import_line(prefix, spec)] = re.escape(prefix) + "'" + SAFE_URL.pattern + "';"
    if {e["old"] for e in edits} != set(olds):
        raise DerivationError("edited lines are not the allowlisted ones")
    for i, (x, y) in enumerate(zip(a, b)):
        e = allowed.get(i)
        if e is None:
            if x != y:
                raise DerivationError(f"line {i + 1} changed outside the allowlist")
        elif x != e["old"] or y != e["new"] or not re.fullmatch(olds[x], y):
            raise DerivationError(f"line {i + 1} is not the allowlisted edit")


def local_closure(paths):
    """sha256 of every file reachable by relative import from `paths`. Bare specifiers are listed, not followed.
    Specifiers are found by pattern, so one named only in a comment is hashed too (over-pinning, never under)."""
    files, bare, todo = {}, set(), list(paths)
    while todo:
        p = os.path.realpath(os.path.normpath(todo.pop()))
        if p in files:
            continue
        try:
            data = read_bytes(p)
        except OSError as e:
            raise DerivationError(f"dependency {p}: {e.strerror}") from None
        files[p] = sha256(data)
        for spec in SPECIFIER.findall(data.decode("utf-8", "replace")):
            if spec.startswith(("./", "../")):
                todo.append(os.path.join(os.path.dirname(p), spec))
            else:
                bare.add(spec)
    return dict(sorted(files.items())), sorted(bare)


def derive(original=ORIGINAL, pinned=ORIGINAL_SHA256):
    """(generated bytes, manifest). Raises DerivationError on any deviation from the pinned input or the allowlist."""
    real = os.path.realpath(original)
    raw = read_bytes(real)
    if sha256(raw) != pinned:
        raise DerivationError(f"{original}: sha256 {sha256(raw)} is not the pinned {pinned}")
    text = raw.decode("utf-8")
    for s in REQUIRED_ONCE:
        if text.count(s) != 1:
            raise DerivationError(f"expected exactly one {s!r}, found {text.count(s)}")
    if "import(" in text:
        raise DerivationError("dynamic import present; its specifier would not be rebased")
    base, deps = os.path.dirname(real), []
    swaps = [(TIMEOUT_OLD, TIMEOUT_NEW)]
    for prefix, spec in IMPORTS:
        path = os.path.normpath(os.path.join(base, spec))       # lexical, as Node resolves a relative specifier
        deps.append(path)
        swaps.append((import_line(prefix, spec), import_line(prefix, module_url(path))))
    lines, edits = text.split("\n"), []
    for old, new in swaps:
        at = [i for i, l in enumerate(lines) if l == old]
        if len(at) != 1 or text.count(old.strip()) != 1:
            raise DerivationError(f"expected exactly one {old.strip()!r}, found {text.count(old.strip())}")
        lines[at[0]] = new
        edits.append({"line": at[0] + 1, "old": old, "new": new})
    out = "\n".join(lines)
    check_allowlist(text, out, edits)
    stray = [s for s in SPECIFIER.findall(out) if not s.startswith(("node:", "file:///"))]
    if stray:
        raise DerivationError(f"specifiers that would resolve differently from another directory: {stray}")
    if out.count(str(APP_IDLE_MS)) != 1:
        raise DerivationError("the application timeout must appear exactly once")
    files, bare = local_closure(deps)
    gen = out.encode("utf-8")
    me = os.path.realpath(__file__)
    manifest = {
        "kind": "shield-bench-client-derivation/1",
        "benchmark_only": True,
        "purpose": "full-model bench: let one attested, pinned application GET stay idle up to 840 s while the model "
                   "loads and decodes; not for production, not a replacement for client.mjs",
        "original": {"path": original, "realpath": real, "sha256": pinned},
        "generated": {"file": GENERATED, "sha256": sha256(gen), "bytes": len(gen)},
        "edits": edits,
        "timeouts_ms": {"application_request_idle": APP_IDLE_MS, "attestation_request_idle": ATTEST_IDLE_MS},
        "unchanged": "judge, verdict gate, TLS key pin on every handshake, second-nonce freshness, replay check, "
                     "runtime pin, min-TCB, --answer-within, the 60 s 502-retry window, tunnel timeouts, exit codes",
        "dependencies_sha256": files,
        "dependency_bare_specifiers": bare,
        "deriver": {"path": me, "sha256": sha256(read_bytes(me))},
    }
    return gen, manifest


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def write_outputs(out_dir, gen, manifest):
    out_dir = os.path.realpath(out_dir)
    if out_dir == os.path.dirname(manifest["original"]["realpath"]):
        raise DerivationError("refusing to write next to the original client")
    targets = [os.path.join(out_dir, GENERATED), os.path.join(out_dir, MANIFEST)]
    for t in targets:
        if os.path.lexists(t):
            raise DerivationError(f"{t} exists; derive into a new directory")
    write_new(targets[0], gen)
    write_new(targets[1], (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())
    return targets


def verify(manifest_path):
    """Problems, or [] when the original is still the pin, re-derivation reproduces the generated bytes on disk,
    and every dependency still hashes as recorded. The pin comes from this file, never from the manifest."""
    with open(manifest_path) as f:
        m = json.load(f)
    problems = []
    if m.get("kind") != "shield-bench-client-derivation/1" or m.get("original", {}).get("sha256") != ORIGINAL_SHA256:
        problems.append("manifest kind or original pin differs from this deriver")
    try:
        gen, fresh = derive(m["original"]["path"], ORIGINAL_SHA256)
    except (DerivationError, OSError, KeyError) as e:
        return problems + [f"re-derivation failed: {e}"]
    if sha256(gen) != m["generated"]["sha256"]:
        problems.append("re-derived client differs from the manifest")
    try:
        if read_bytes(os.path.join(os.path.dirname(manifest_path), m["generated"]["file"])) != gen:
            problems.append("generated file on disk differs from the re-derivation")
    except OSError as e:
        problems.append(f"generated file: {e.strerror}")
    if fresh["dependencies_sha256"] != m["dependencies_sha256"]:
        changed = sorted(set(fresh["dependencies_sha256"].items()) ^ set(m["dependencies_sha256"].items()))
        problems.append(f"dependencies changed: {sorted({p for p, _ in changed})}")
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("derive")
    d.add_argument("--out-dir", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--manifest", required=True)
    a = ap.parse_args(argv)
    try:
        if a.cmd == "derive":
            gen, manifest = derive()
            for t in write_outputs(a.out_dir, gen, manifest):
                print(t)
            print(f"generated sha256 {manifest['generated']['sha256']}")
            return 0
        problems = verify(a.manifest)
    except (DerivationError, OSError) as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 1
    for p in problems:
        print(f"PROBLEM: {p}", file=sys.stderr)
    print("verified" if not problems else "NOT verified")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
