#!/usr/bin/env python3
"""Private pinned runtime bundle for a dynamically linked build-host binary (the M7 Base node), following the existing
native verifier pattern (metal/chain-verifier-image.json glibcRuntime: the build host's own loader + libraries, run
through that loader with --library-path; the binary's bytes and pin unchanged). Read-only on the host; writes only --out.

  abi.py closure BINARY                       -> JSON: interpreter, DT_NEEDED closure, per-library path/sha256/package,
                                                 highest GLIBC_/GLIBCXX_/OPENSSL_/GCC_ symbol versions required
  abi.py bundle BINARY --expect-sha HEX --out DIR [--name base]
                                              -> DIR/{bin/NAME, lib/*, run, openssl.cnf, MANIFEST.json, SHA256SUMS}
  abi.py guard DIR                            -> exit 0 only if `ld.so --list` resolves EVERY library inside DIR/lib
  abi.py report CLOSURE.json --target-glibc 2.39 --target-openssl 3.0.13
                                              -> which requirements exceed the TARGET's system libraries (advice only)
No library is fetched, installed or replaced; nothing outside DIR is written."""
import hashlib, json, os, re, shutil, subprocess, sys
SEARCH = ["/usr/lib", "/usr/lib64", "/lib"]          # the build host's (Arch) library dirs
def sha(p):
    with open(p, "rb") as f: return hashlib.file_digest(f, "sha256").hexdigest()
def run(*a): return subprocess.run(a, capture_output=True, text=True, check=True).stdout
def needed(p): return re.findall(r"\(NEEDED\)\s+Shared library: \[([^\]]+)\]", run("readelf", "-d", p))
LOADERS = {"/lib64/ld-linux-x86-64.so.2", "/usr/lib/ld-linux-x86-64.so.2", "/usr/lib64/ld-linux-x86-64.so.2"}
LOADER = "ld-linux-x86-64.so.2"                        # the loader is bundled once, as lib/LOADER (0555), not as a library
def runpath(p): return re.findall(r"\((?:RPATH|RUNPATH)\)\s+Library (?:rpath|runpath): \[([^\]]+)\]", run("readelf", "-d", p))
def interp(p):
    m = re.search(r"Requesting program interpreter: ([^\]]+)\]", run("readelf", "-l", p)); return m.group(1) if m else None
def versions(p):                                       # symbol versions this object REQUIRES (.gnu.version_r)
    return sorted(set(re.findall(r"Name: ((?:GLIBC|GLIBCXX|CXXABI|OPENSSL|GCC)_[0-9A-Za-z._]+)", run("readelf", "-V", "-W", p))))
def owner(p):
    try: return run("pacman", "-Qo", p).strip().split(" is owned by ")[1]
    except Exception: return None
def resolve(name):
    for d in SEARCH:
        q = os.path.join(d, name)
        if os.path.exists(q): return q
    return None
def vkey(v):
    fam, num = v.split("_", 1); return fam, tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[._]", num))
def highest(vs):
    out = {}
    for v in vs:
        f, n = vkey(v)
        if f not in out or n > vkey(out[f])[1]: out[f] = v
    return out
def closure(binary):
    it = interp(binary); libs = {}; todo = list(needed(binary)); missing = []
    while todo:
        n = todo.pop(0)
        if n in libs or n in missing: continue
        p = resolve(n)
        if not p: missing.append(n); continue
        rp = os.path.realpath(p)
        libs[n] = {"path": p, "realpath": rp, "sha256": sha(rp), "package": owner(rp), "requires": versions(rp)}
        todo += [x for x in needed(rp) if x not in libs]
    req = versions(binary)
    return {"binary": os.path.abspath(binary), "sha256": sha(binary), "interpreter": it,
            "interpreterFile": {"realpath": os.path.realpath(it), "sha256": sha(os.path.realpath(it)), "package": owner(os.path.realpath(it))} if it else None,
            "needed": needed(binary), "runpath": runpath(binary), "libraries": libs, "missing": missing,
            "binaryRequires": req, "binaryHighest": highest(req),
            "closureHighest": highest(req + [v for l in libs.values() for v in l["requires"]])}
WRAPPER = r'''#!/bin/sh
# Pinned private runtime for {name} (abi.py): the bundled loader + libraries, never the target's system copies.
# Refuses unless every library resolves inside this bundle (`--list` guard); scrubs LD_*; pins OpenSSL config/CA lookup.
# `{name} update` (self-update via current_exe) is NOT supported through this wrapper: under an explicit loader
# current_exe() names the loader, and a pinned deployment must not self-update.
set -eu
unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_BIND_NOW LD_DEBUG LD_PROFILE 2>/dev/null || true   # before any helper runs
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
L="$D/lib/ld-linux-x86-64.so.2"
case "${{1:-}}" in update) echo "{name} update is not supported in the pinned runtime bundle" >&2; exit 64;; esac
out=$("$L" --inhibit-cache --library-path "$D/lib" --list "$D/bin/{name}" 2>&1) || {{ echo "runtime guard: loader cannot resolve the closure" >&2; echo "$out" >&2; exit 65; }}
echo "$out" | awk -v d="$D/lib/" '/=>/ {{ if (index($3, d) != 1) bad = bad " " $1 "=>" $3 }} /not found/ {{ bad = bad " " $1 }} END {{ if (bad != "") {{ print "runtime guard: outside the bundle:" bad > "/dev/stderr"; exit 1 }} }}' || exit 65
export OPENSSL_CONF="$D/openssl.cnf"
export SSL_CERT_FILE="${{SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}}" SSL_CERT_DIR="${{SSL_CERT_DIR:-/etc/ssl/certs}}"
exec "$L" --inhibit-cache --library-path "$D/lib" "$D/bin/{name}" "$@"
'''
OPENSSL_CNF = "# Minimal OpenSSL config for the bundled libcrypto (abi.py): no system config, providers or engines are read.\n" \
              "openssl_conf = openssl_init\n[openssl_init]\nproviders = provider_sect\n[provider_sect]\ndefault = default_sect\n[default_sect]\nactivate = 1\n"
def bundle(binary, expect, out, name):
    if os.path.exists(out): sys.exit(f"{out} exists")
    got = sha(binary)
    if got != expect: sys.exit(f"binary sha256 {got} != expected {expect}")
    c = closure(binary)
    if c["missing"]: sys.exit(f"unresolved libraries on the build host: {c['missing']}")
    if c["interpreter"] not in LOADERS: sys.exit(f"unexpected interpreter {c['interpreter']}")
    if c["runpath"]: sys.exit(f"binary carries RPATH/RUNPATH {c['runpath']}: it would bypass --library-path ordering")
    if LOADER in c["libraries"] and c["libraries"][LOADER]["sha256"] != c["interpreterFile"]["sha256"]:
        sys.exit("libc's NEEDED loader differs from the program interpreter")
    libs = {n: l for n, l in c["libraries"].items() if n != LOADER}
    unowned = [n for n, l in libs.items() if not l["package"]] + ([] if c["interpreterFile"]["package"] else [LOADER])
    if unowned: sys.exit(f"libraries not owned by a host package (no provenance): {unowned}")
    os.makedirs(out + "/bin"); os.makedirs(out + "/lib")
    shutil.copyfile(binary, f"{out}/bin/{name}"); os.chmod(f"{out}/bin/{name}", 0o555)
    shutil.copyfile(c["interpreterFile"]["realpath"], f"{out}/lib/ld-linux-x86-64.so.2"); os.chmod(f"{out}/lib/ld-linux-x86-64.so.2", 0o555)
    for n, l in sorted(libs.items()):
        shutil.copyfile(l["realpath"], f"{out}/lib/{n}"); os.chmod(f"{out}/lib/{n}", 0o444)
    open(f"{out}/run", "w").write(WRAPPER.format(name=name)); os.chmod(f"{out}/run", 0o555)
    open(f"{out}/openssl.cnf", "w").write(OPENSSL_CNF); os.chmod(f"{out}/openssl.cnf", 0o444)
    man = {"format": "enclave-pinned-runtime-bundle/v1", "name": name, "binarySha256": got,
           "loader": {"file": "lib/ld-linux-x86-64.so.2", "sha256": c["interpreterFile"]["sha256"], "package": c["interpreterFile"]["package"]},
           "libraries": {n: {"sha256": l["sha256"], "package": l["package"], "hostPath": l["realpath"]} for n, l in sorted(libs.items())},
           "invocation": ["lib/ld-linux-x86-64.so.2", "--inhibit-cache", "--library-path", "lib", f"bin/{name}"],
           "env": {"OPENSSL_CONF": "openssl.cnf", "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt (target default; overridable)"},
           "binaryHighest": c["binaryHighest"], "closureHighest": c["closureHighest"]}
    open(f"{out}/MANIFEST.json", "w").write(json.dumps(man, indent=1, sort_keys=True) + "\n")
    files = sorted(os.path.relpath(os.path.join(r, f), out) for r, _, fs in os.walk(out) for f in fs)
    open(f"{out}/SHA256SUMS", "w").write("".join(f"{sha(os.path.join(out, f))}  {f}\n" for f in files))
    print(json.dumps({"bundle": out, "binarySha256": got, "libraries": sorted(libs), "closureHighest": c["closureHighest"]}, indent=1))
def guard(d):
    d = os.path.realpath(d)
    r = subprocess.run([f"{d}/lib/{LOADER}", "--inhibit-cache", "--library-path", f"{d}/lib", "--list", f"{d}/bin/" + json.load(open(f"{d}/MANIFEST.json"))["name"]], capture_output=True, text=True)
    lines = [l.strip() for l in r.stdout.splitlines() if "=>" in l]
    outside = [l for l in lines if not os.path.realpath(l.split("=>")[1].split(" (0x")[0].strip()).startswith(d + "/lib/")]
    print(json.dumps({"rc": r.returncode, "resolved": lines, "outside": outside, "stderr": r.stderr.strip()[:300]}, indent=1))
    sys.exit(0 if r.returncode == 0 and not outside and lines else 1)
def report(cj, tglibc, tssl):
    c = json.load(open(cj)); h = c["closureHighest"]; b = c["binaryHighest"]
    def gt(v, t): return vkey(v)[1] > tuple(int(x) for x in t.split("."))
    out = {"binaryNeedsGlibc": b.get("GLIBC"), "exceedsTargetGlibc": bool(b.get("GLIBC") and gt(b["GLIBC"], tglibc)),
           "binaryNeedsOpenssl": b.get("OPENSSL"), "exceedsTargetOpenssl": bool(b.get("OPENSSL") and gt(b["OPENSSL"], tssl)),
           "binaryNeedsGlibcxx": b.get("GLIBCXX"), "needed": c["needed"],
           "advice": "a private bundle is required if any 'exceeds' is true; otherwise the system libraries MAY suffice, but only a smoke on the target decides"}
    print(json.dumps(out, indent=1))
if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["closure"]: print(json.dumps(closure(a[1]), indent=1, sort_keys=True))
    elif a[:1] == ["bundle"]:
        kv = dict(zip(a[2::2], a[3::2])); bundle(a[1], kv["--expect-sha"], kv["--out"], kv.get("--name", "base"))
    elif a[:1] == ["guard"]: guard(a[1])
    elif a[:1] == ["report"]:
        kv = dict(zip(a[2::2], a[3::2])); report(a[1], kv["--target-glibc"], kv["--target-openssl"])
    else: sys.exit(__doc__)
