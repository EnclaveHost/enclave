#!/usr/bin/env python3
"""log-values-test.py -- every log line the TPU lane can print is VALUE-FREE (REPORT 18.35, ported to the phone lane).

A fault log is relayed out of the pVM (ggml_backend_tpu_set_logger -> the control channel), so an argument that is an
unmasked activation, a pad, a masked request/reply element or an output value would carry it past the boundary on the
one path nobody reviews: the failure path. The 27B lane shipped exactly that shape (a plaintext diagnostic in a refusal)
and fixed it with a compile-time gate; this lane has no plaintext diagnostic at all, and this test keeps it that way.

Method: parse every TPU_LOG(...) call (balanced parentheses, string literals skipped) in the lane's sources, drop the
format string, and require every identifier in the remaining arguments to be on an allowlist of PUBLIC things: layer and
kind indices, output indices, sizes, timings, bundle metadata, error magnitudes between two masked quantities the worker
can already compute (da/db), errno text. A new argument is a failure until someone adds it here on purpose.

Also self-tests: a mutant that logs y[0] (an output) and one that logs a pad must both be REFUSED, and a file with no
TPU_LOG at all is an error (the parser would otherwise pass vacuously)."""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2] / "payload"
FILES = ["ggml-tpu.cpp", "tpu_corr.h", "tpu_unmask_span.h"]

ALLOW = {
    # public structure: which block / projection / output, and bundle metadata
    "g", "layer", "kind", "j", "i", "e", "mod", "sig_q", "n", "s", "by_name", "size", "node", "src", "name", "path",
    "b", "off", "mo",
    # sizes / timings of the link probe
    "want", "us", "reps", "before", "maxb", "after", "rc",
    # |worker - reference| in digit units: both operands are MASKED values the worker already holds
    "da", "db",
    # compile-time constants
    "kVerifyTolLsb", "kRailBucketCap", "kRailRefill",
    # libc
    "strerror", "errno",
    # casts and keywords
    "unsigned", "long", "int", "const", "char", "size_t", "double", "float", "uint32_t", "uint64_t", "int64_t",
}

def calls(src):
    """Yield (line, argument text after the format) for each TPU_LOG( call; skips the macro definition."""
    for m in re.finditer(r"\bTPU_LOG\(", src):
        line = src.count("\n", 0, m.start()) + 1
        i, depth, args, cur, in_str = m.end(), 1, [], [], None
        while i < len(src) and depth:
            c = src[i]
            if in_str:
                cur.append(c)
                if c == "\\": cur.append(src[i + 1]); i += 2; continue
                if c == in_str: in_str = None
            elif c in "\"'": in_str = c; cur.append(c)
            elif c == "(": depth += 1; cur.append(c)
            elif c == ")":
                depth -= 1
                if depth: cur.append(c)
            elif c == "," and depth == 1: args.append("".join(cur)); cur = []
            else: cur.append(c)
            i += 1
        args.append("".join(cur))
        if args and args[0].strip() == "...": continue          # #define TPU_LOG(...)
        rest = [a for a in args if not re.fullmatch(r'\s*("([^"\\]|\\.)*"\s*)+', a)]
        yield line, rest

def offenders(src):
    bad = []
    for line, rest in calls(src):
        for a in rest:
            a = re.sub(r'"([^"\\]|\\.)*"', "", a)              # string literals inside a ternary
            for ident in re.findall(r"[A-Za-z_]\w*", a):
                if ident not in ALLOW: bad.append((line, ident, a.strip()))
    return bad

def n_calls(src): return sum(1 for _ in calls(src))

fail = 0
def check(name, cond):
    global fail
    print(("ok   " if cond else "FAIL ") + name)
    if not cond: fail += 1

total = 0
for f in FILES:
    src = (ROOT / f).read_text()
    total += n_calls(src)
    for line, ident, a in offenders(src):
        print(f"FAIL {f}:{line}: '{ident}' is not known to be public (argument: {a})"); fail += 1
check(f"lane sources contain TPU_LOG calls ({total})", total >= 10)

base = (ROOT / "ggml-tpu.cpp").read_text()
check("clean source passes", not offenders(base))
check("mutant logging an output is refused",
      any(i == "y" for _, i, _ in offenders(base + '\nvoid m(){ TPU_LOG("%f\\n", (double)y[0]); }\n')))
check("mutant logging a pad is refused",
      any(i == "P" for _, i, _ in offenders(base + '\nvoid m(){ TPU_LOG("blk %d %d\\n", g.layer, P[3]); }\n')))
check("mutant hiding a value in a ternary is refused",
      any(i == "cache" for _, i, _ in offenders(base + '\nvoid m(){ TPU_LOG("%s %f\\n", "x", ok ? 0.0 : cache[0][0]); }\n')))
check("mutant with a string containing a comma and paren still parsed",
      any(i == "rxbuf" for _, i, _ in offenders('TPU_LOG("a, (b) %d\\n", rxbuf[0]);')))
check("a file with no calls is detected", n_calls("int main(){}") == 0)
print("PASS log-values" if not fail else f"{fail} failed"); sys.exit(1 if fail else 0)
