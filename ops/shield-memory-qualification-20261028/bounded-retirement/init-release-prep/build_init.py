#!/usr/bin/env python3
"""build_init.py -- bounded reproduction gate, then the opt-in candidate guest init (REVIEW.md).

    build_init.py --m2 DIR --musl PREFIX --out DIR [--installed-init FILE]

1. pins: --m2/dominit.c must hash to ORIGINAL_SOURCE_SHA256, the musl specs and libc.a to their pins, --installed-init
   (if given) to BASELINE_INIT_SHA256. --out must not exist and must not lie inside --m2 or --musl.
2. stage: out/baseline gets the original dominit.c and every --m2/*.h, byte for byte; out/candidate gets the same
   headers, this directory's shield-retire-marker.h, and a dominit.c generated from the original by three anchored
   insertions (each anchor exactly once; nothing is removed or reordered).
3. reproduce: compile out/baseline exactly as isolation/m4/app-image-template.sh does (/usr/bin/gcc, the musl specs,
   -static -O2, none of CPATH/C_INCLUDE_PATH/LIBRARY_PATH/GCC_EXEC_PREFIX/COMPILER_PATH). The result must equal
   BASELINE_INIT_SHA256, or the run stops and the candidate is never compiled.
4. build: compile out/candidate the same way. Both must be static musl (no PT_INTERP, no DT_NEEDED, no glibc string);
   the candidate must carry the marker path and the env, the baseline neither.
5. write out/dominit-retire-budget.diff and out/RESULT.json (exclusive).

Never runs app-image-template.sh, runtime-set.sh, go, a release, a VM or a GPU, and writes nothing outside --out.
Exit 0 built, 1 refused, 2 usage.
"""
import argparse, difflib, hashlib, json, os, resource, stat, struct, subprocess, sys

ORIGINAL_SOURCE_SHA256 = "7427144398f3e0405ba035dad996104bbd582a90099463465b9219162cc86576"
MUSL_SPECS_SHA256 = "4b0202b5fc90f78f227c8937f04afa31378b421036ebe68498513a1cf19895bf"
MUSL_LIBC_SHA256 = "4f72e098ed0562e8361f7c1713189c5cd7b3e6672dd8d9311d32c49201260959"
BASELINE_INIT_SHA256 = "dffd093b8458e109c64756c26fe5efd8b8226da712fb03a81f28d50aaa27cb0b"
BASELINE_INIT_SIZE = 116880
GCC = "/usr/bin/gcc"
MARKER = b"/rt/shield-source-retire-budget-1024.enabled"
ENV = b"ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB=1024"
HEADER = "shield-retire-marker.h"
SOURCE_MAX = 1 << 20
BINARY_MAX = 8 << 20
HERE = os.path.dirname(os.path.abspath(__file__))

# (anchor, inserted after it). Every anchor is original text that must occur exactly once.
INSERTIONS = (
    ('#include "shield-config.h"\n',
     '#include "shield-retire-marker.h"   /* the measured bounded-retirement opt-in */\n'),
    ('        const int reclaim_sources = shield_on && shield_load_allowed && shield_large && drop &&\n'
     '            access("/rt/shield-original-source-reclaim.enabled", R_OK) == 0;\n',
     '        /* Bounded retirement of consumed private originals is a measured release choice, read as root\n'
     '         * before the drop and only with source reclaim. Absent = the deferred flush; malformed = no app. */\n'
     '        const int retire_budget = reclaim_sources ? shield_retire_marker_at(SHIELD_RETIRE_MARKER) : 0;\n'
     '        if (retire_budget < 0) {\n'
     '            dprintf(1, "DOM ERROR %s is malformed: not started\\n", SHIELD_RETIRE_MARKER);\n'
     '            _exit(125);\n'
     '        }\n'),
    ('                envp[ei++] = "ENCLAVE_SHIELD_PRIVATE_SOURCE=fd:198";\n',
     '                if (retire_budget == 1) envp[ei++] = SHIELD_RETIRE_ENV;\n'),
)
ENVP_SLOTS = 80


class Refused(Exception):
    pass


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def read_regular(path, limit):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as e:
        raise Refused(f"{path}: {e.strerror} (symlinks are refused)") from None
    with os.fdopen(fd, "rb") as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise Refused(f"{path} is not a regular file")
        b = f.read(limit + 1)
    if len(b) > limit:
        raise Refused(f"{path} is larger than {limit} bytes")
    return b


def make_candidate(original):
    """The original dominit.c bytes plus the three insertions. Refuses unless each anchor occurs exactly once."""
    text = original.decode("utf-8")
    for anchor, add in INSERTIONS:
        n = text.count(anchor)
        if n != 1:
            raise Refused(f"anchor occurs {n} times, not once: {anchor.splitlines()[0].strip()!r}")
        i = text.index(anchor) + len(anchor)
        text = text[:i] + add + text[i:]
    cand = text.encode("utf-8")
    check_candidate(original, cand)
    return cand


def _spawn_body(text):
    start = text.index("static pid_t spawn(char *const argv[], char *extra, int fd3, int flags) {")
    end = text.index("\n}\n", start)
    return text[start:end]


def check_candidate(original, cand):
    """Independent of how make_candidate built it: pure insertion, the expected order, and the envp bound."""
    o, c = original.decode().splitlines(keepends=True), cand.decode().splitlines(keepends=True)
    ops = [op for op in difflib.SequenceMatcher(None, o, c, autojunk=False).get_opcodes() if op[0] != "equal"]
    if any(op[0] != "insert" for op in ops) or len(ops) != len(INSERTIONS):
        raise Refused(f"candidate is not exactly {len(INSERTIONS)} pure insertions: {[op[0] for op in ops]}")
    added = "".join("".join(c[j1:j2]) for _, _, _, j1, j2 in ops)
    if added != "".join(add for _, add in INSERTIONS):
        raise Refused("inserted text is not the reviewed insertion text")
    body = _spawn_body(cand.decode())
    pos = {k: body.find(k) for k in (
        "const int reclaim_sources", "const int retire_budget", "if (retire_budget < 0)", "if (reclaim_sources) {",
        "drop_to_app()", "app_seccomp_install()", '"ENCLAVE_SHIELD_PRIVATE_SOURCE=fd:198";',
        "if (retire_budget == 1) envp[ei++] = SHIELD_RETIRE_ENV;", "envp[ei++] = extra;")}
    if min(pos.values()) < 0:
        raise Refused(f"spawn() lacks {[k for k, v in pos.items() if v < 0]}")
    order = sorted(pos, key=pos.get)
    want = ["const int reclaim_sources", "const int retire_budget", "if (retire_budget < 0)", "if (reclaim_sources) {",
            "drop_to_app()", "app_seccomp_install()", '"ENCLAVE_SHIELD_PRIVATE_SOURCE=fd:198";',
            "if (retire_budget == 1) envp[ei++] = SHIELD_RETIRE_ENV;", "envp[ei++] = extra;"]
    if order != want:
        raise Refused(f"spawn() order is {order}")
    # every envp[ei++] counted as if all were taken (an upper bound), + 2 initial entries + the NULL
    worst = body.count("envp[ei++]") + 2 + 1
    if f"char *envp[{ENVP_SLOTS}]" not in body or worst > ENVP_SLOTS:
        raise Refused(f"envp worst case {worst} exceeds {ENVP_SLOTS} slots")
    if body.count("SHIELD_RETIRE_ENV") != 1 or cand.decode().count("SHIELD_RETIRE_MARKER") != 2:
        raise Refused("the env or marker is referenced outside the reviewed lines")
    return worst


def check_static_musl(path):
    """The template's gate (no PT_INTERP, no DT_NEEDED, no glibc string), without readelf."""
    b = read_regular(path, BINARY_MAX)
    if len(b) < 64 or b[:4] != b"\x7fELF" or b[4] != 2 or b[5] != 1:
        raise Refused(f"{path} is not a little-endian ELF64 file")
    e_type, e_machine = struct.unpack_from("<HH", b, 16)
    if e_machine != 62 or e_type not in (2, 3):
        raise Refused(f"{path} is not an x86-64 executable")
    (e_phoff,) = struct.unpack_from("<Q", b, 32)
    e_phentsize, e_phnum = struct.unpack_from("<HH", b, 54)
    if e_phnum > 64 or e_phentsize != 56 or e_phoff + 56 * e_phnum > len(b):
        raise Refused(f"{path} has an implausible program header table")
    for i in range(e_phnum):
        p_type, _, p_offset, _, _, p_filesz = struct.unpack_from("<IIQQQQ", b, e_phoff + 56 * i)
        if p_type == 3:
            raise Refused(f"{path} has a program interpreter")
        if p_type == 2:
            if p_offset + p_filesz > len(b):
                raise Refused(f"{path} has a truncated dynamic segment")
            for off in range(p_offset, p_offset + p_filesz - 15, 16):
                (tag,) = struct.unpack_from("<q", b, off)
                if tag == 0:
                    break
                if tag == 1:
                    raise Refused(f"{path} needs a shared library")
    if b"glibc" in b.lower():
        raise Refused(f"{path} carries a glibc string")
    return b


def _limits():
    resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_FSIZE, (BINARY_MAX, BINARY_MAX))


def gcc_compile(workdir, specs):
    """The template's command, run in workdir on its own dominit.c. Clean env: nothing of the caller's reaches gcc."""
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "TMPDIR": os.path.join(workdir, ".tmp")}
    os.mkdir(env["TMPDIR"], 0o700)
    cmd = [GCC, "-specs", specs, "-static", "-O2", "-o", os.path.join(workdir, "init"),
           os.path.join(workdir, "dominit.c")]
    with open(os.path.join(workdir, "build.log"), "xb") as log:
        r = subprocess.run(cmd, cwd=workdir, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                           timeout=180, preexec_fn=_limits)
    os.rmdir(env["TMPDIR"])
    if r.returncode != 0:
        raise Refused(f"gcc failed in {workdir} (exit {r.returncode}); see build.log")
    return cmd


def _write_new(path, data, mode=0o644):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def _under(p, root):
    return p == root or p.startswith(root + os.sep)


def build(m2, musl, out, installed=None, pins=None, compile_fn=gcc_compile, header_dir=HERE):
    pins = dict(dict(source=ORIGINAL_SOURCE_SHA256, specs=MUSL_SPECS_SHA256, libc=MUSL_LIBC_SHA256,
                     init=BASELINE_INIT_SHA256), **(pins or {}))
    m2, musl, out = (os.path.realpath(m2), os.path.realpath(musl), os.path.abspath(out))
    if os.path.lexists(out):
        raise Refused(f"--out {out} exists; refusing to overwrite")
    rout = os.path.join(os.path.realpath(os.path.dirname(out)), os.path.basename(out))
    for root, what in ((m2, "--m2"), (musl, "--musl")):
        if _under(rout, root):
            raise Refused(f"--out lies inside {what}")
    original = read_regular(os.path.join(m2, "dominit.c"), SOURCE_MAX)
    if sha256(original) != pins["source"]:
        raise Refused(f"dominit.c sha256 {sha256(original)} is not the reproduced original {pins['source']}")
    specs = os.path.join(musl, "lib", "musl-gcc.specs")
    for p, pin in ((specs, pins["specs"]), (os.path.join(musl, "lib", "libc.a"), pins["libc"])):
        got = sha256(read_regular(p, 64 << 20))
        if got != pin:
            raise Refused(f"{p} sha256 {got} is not the pinned {pin}")
    if installed is not None:
        got = sha256(read_regular(installed, BINARY_MAX))
        if got != pins["init"]:
            raise Refused(f"installed init {installed} sha256 {got} is not the pinned {pins['init']}")
    headers = {n: read_regular(os.path.join(m2, n), SOURCE_MAX) for n in sorted(os.listdir(m2)) if n.endswith(".h")}
    if HEADER in headers:
        raise Refused(f"{m2} already has {HEADER}")
    marker_h = read_regular(os.path.join(header_dir, HEADER), SOURCE_MAX)
    cand = make_candidate(original)
    worst = check_candidate(original, cand)

    os.mkdir(out, 0o755)
    res = {"kind": "shield-init-retire-budget-build/1", "out": out, "pins": pins, "headers": {
        n: sha256(b) for n, b in headers.items()}, HEADER: sha256(marker_h), "envpWorstCase": worst,
        "originalSourceSha256": sha256(original), "candidateSourceSha256": sha256(cand)}
    try:
        for side, src in (("baseline", original), ("candidate", cand)):
            d = os.path.join(out, side)
            os.mkdir(d, 0o755)
            for n, b in headers.items():
                _write_new(os.path.join(d, n), b)
            _write_new(os.path.join(d, "dominit.c"), src)
        _write_new(os.path.join(d, HEADER), marker_h)
        diff = "".join(difflib.unified_diff(original.decode().splitlines(keepends=True),
                                            cand.decode().splitlines(keepends=True),
                                            "a/isolation/m2/dominit.c", "b/isolation/m2/dominit.c"))
        _write_new(os.path.join(out, "dominit-retire-budget.diff"), diff.encode())

        res["command"] = compile_fn(os.path.join(out, "baseline"), specs)
        base = check_static_musl(os.path.join(out, "baseline", "init"))
        res["baselineBuiltSha256"] = sha256(base)
        if sha256(base) != pins["init"]:
            raise Refused(f"baseline init rebuilt as {sha256(base)}, not {pins['init']}: reproduction not "
                          "established in this layout, candidate NOT compiled")
        if MARKER in base or ENV in base:
            raise Refused("the baseline init already carries the marker or env")
        compile_fn(os.path.join(out, "candidate"), specs)
        cbin = check_static_musl(os.path.join(out, "candidate", "init"))
        if cbin.count(MARKER) != 1 or cbin.count(ENV) != 1:
            raise Refused("the candidate init does not carry the marker path and env exactly once")
        if cbin == base:
            raise Refused("the candidate init is identical to the baseline")
        res.update(candidateInitSha256=sha256(cbin), candidateInitSize=len(cbin), reproduced=True)
        res["notDone"] = ["not composed into a release", "measurement not predicted", "not admitted", "not run"]
    except (Refused, OSError, subprocess.SubprocessError) as e:
        res["refused"] = str(e)
        _write_new(os.path.join(out, "RESULT.json"), (json.dumps(res, indent=2, sort_keys=True) + "\n").encode())
        raise Refused(f"{e}; partial output kept at {out}") from e
    _write_new(os.path.join(out, "RESULT.json"), (json.dumps(res, indent=2, sort_keys=True) + "\n").encode())
    return res


def main(argv=None):
    p = argparse.ArgumentParser(prog="build_init.py", allow_abbrev=False)
    p.add_argument("--m2", required=True)
    p.add_argument("--musl", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--installed-init")
    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 2
    try:
        res = build(a.m2, a.musl, a.out, a.installed_init)
    except (Refused, OSError) as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 1
    print(json.dumps(res, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
