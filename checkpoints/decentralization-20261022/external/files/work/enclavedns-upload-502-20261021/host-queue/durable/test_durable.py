#!/usr/bin/env python3
"""Local checks for the durable SHIELDED_BRIDGE_MAX_CONNS=96 correction (no PowerShell, no Rust build, no network).
1 template preservation: patched = base + exactly the 4 lines, inside the shield-config.cmd here-string, nothing else.
2 cmd semantics: the rendered shield-config.cmd sets SHIELDED_BRIDGE_MAX_CONNS to exactly "96" (cmd keeps trailing
  spaces in `set X=v `, which the bridge's parse would reject); every other set line is unchanged.
3 bridge parse: both bridge sources (live 87ce2b2fd, bundle 45801c22) contain the exact cap expression; a model of it
  (Rust usize::from_str, then 1..=1024, else 64 persistent / 8 timed) over the values that matter.
4 the activation script inserts the SAME 4 lines as the template (so a later release install renders the same text).
"""
import hashlib, pathlib, re, sys

D = pathlib.Path(__file__).resolve().parent
BASE_SHA = "0dc5a8016b499c8a65baae7867f1280bd6175b2c560adaffe2dd7e802b83bd1d"
BRIDGE_SRC = {"src-87ce2b2fd/shielded-bridge.rs": "7be4d7087b7bc40d56b12b60ead0d84009e8dfce38d3b75cff76d3ab0d7fcc8e",
              "src-45801c22/shielded-bridge.rs": "c073adc569decfdcf3826277b8592b25f7c2db8e55f3f12eff2d6f9091d208ee"}
results = []
def check(name, cond, detail=""):
    results.append(("PASS" if cond else "FAIL", name + (f" ({detail})" if detail and not cond else "")))

base_b = (D / "base/install-host.ps1").read_bytes(); new_b = (D / "patched/install-host.ps1").read_bytes()
check("base is the abe86262 bundle template", hashlib.sha256(base_b).hexdigest() == BASE_SHA)
base, new = base_b.decode("ascii"), new_b.decode("ascii")
bl, nl = base.split("\n"), new.split("\n")
anchor = next(i for i, l in enumerate(bl) if l.startswith("set ENCLAVE_EGRESS_BRIDGE_EXE_SHA256="))
inserted = nl[anchor + 1: anchor + 5]
check("1a patched = base with exactly 4 lines inserted after the bridge pin line", nl[:anchor + 1] + nl[anchor + 5:] == bl and len(nl) == len(bl) + 4)
check("1b the last inserted line is exactly `set SHIELDED_BRIDGE_MAX_CONNS=96`", inserted[-1] == "set SHIELDED_BRIDGE_MAX_CONNS=96")
check("1c inserted lines: rem comments + the set, ASCII, no CR, no trailing space",
      all(l.startswith("rem ") for l in inserted[:3]) and all(l == l.rstrip() and "\r" not in l for l in inserted))
check("1d nothing PowerShell would expand or end the here-string with ($, backtick, \"@)",
      all("$" not in l and "`" not in l and not l.startswith('"@') for l in inserted))
# the here-string that renders shield-config.cmd: from the @" before it to the "@ | Set-Content ... shield-config.cmd
end = next(i for i, l in enumerate(nl) if l.startswith('"@') and "shield-config.cmd" in l)
start = max(i for i in range(end) if nl[i].rstrip().endswith('@"'))
check("1e the insertion lies inside the shield-config.cmd here-string", start < anchor + 1 and anchor + 4 < end, f"{start}..{end}")
other_docs = [l for l in nl if 'Set-Content' in l and '"@' in l]
check("1f every other generated file's here-string is byte-identical",
      [l for l in bl if 'Set-Content' in l and '"@' in l] == other_docs and nl[end + 1:] == bl[end - 3:])

def render(lines):
    # cmd semantics of `set NAME=value`: value = everything after the first '=' to end of line, trailing spaces kept;
    # PowerShell substitutions are replaced by a fixed token (they are not under test)
    env = {}
    for l in lines:
        l = re.sub(r"\$\([^)]*\)|\$[A-Za-z_]\w*", "<ps>", l)
        m = re.match(r"(?i)^set ([^=\s]+)=(.*)$", l)
        if m: env.setdefault(m.group(1).upper(), []).append(m.group(2))
    return env
bstart = max(i for i in range(len(bl)) if bl[i].rstrip().endswith('@"') and i < next(j for j, l in enumerate(bl) if l.startswith('"@') and "shield-config.cmd" in l))
benv = render(bl[bstart + 1: next(j for j, l in enumerate(bl) if l.startswith('"@') and "shield-config.cmd" in l)])
nenv = render(nl[start + 1:end])
check("2a rendered shield-config.cmd sets SHIELDED_BRIDGE_MAX_CONNS exactly once, to the exact value \"96\"", nenv.get("SHIELDED_BRIDGE_MAX_CONNS") == ["96"])
check("2b every other variable is unchanged", {k: v for k, v in nenv.items() if k != "SHIELDED_BRIDGE_MAX_CONNS"} == benv)
check("2c the base sets no bridge cap (so today's bridges run the compiled default)", "SHIELDED_BRIDGE_MAX_CONNS" not in benv)

CAP_EXPR = ('let cap: usize = std::env::var("SHIELDED_BRIDGE_MAX_CONNS")\n        .ok()\n        .and_then(|v| v.parse().ok())\n'
            '        .filter(|&n| n > 0 && n <= 1024)\n        .unwrap_or(if seconds == 0 { 64 } else { 8 });')
for f, h in BRIDGE_SRC.items():
    s = (D / f).read_bytes()
    check(f"3a {f} is the pinned source", hashlib.sha256(s).hexdigest() == h)
    check(f"3b {f} has exactly the modelled cap expression", s.decode().count(CAP_EXPR) == 1)
def rust_usize(v):  # core::num from_str for an unsigned type: optional single '+', then ASCII digits only, no whitespace
    if v is None: return None
    t = v[1:] if v.startswith("+") else v
    if not t or not t.isascii() or not t.isdigit(): return None
    n = int(t); return n if n < 2 ** 64 else None
def cap(v, seconds):
    n = rust_usize(v)
    return n if n is not None and 0 < n <= 1024 else (64 if seconds == 0 else 8)
table = [("96", 0, 96), (None, 0, 64), ("", 0, 64), ("96 ", 0, 64), (" 96", 0, 64), ("96\r", 0, 64), ("+96", 0, 96),
         ("0", 0, 64), ("1024", 0, 1024), ("1025", 0, 64), ("0x60", 0, 64), ("96", 30, 96), (None, 30, 8), ("-1", 0, 64)]
bad = [(v, s, w, cap(v, s)) for v, s, w in table if cap(v, s) != w]
check("3c parse model: '96' -> 96; unset/blank/padded/CR/0/1025/hex/negative -> default 64 (8 timed); '+96' -> 96", not bad, str(bad))
check("3d the template's rendered value parses to 96 for a persistent bridge", cap(nenv["SHIELDED_BRIDGE_MAX_CONNS"][0], 0) == 96)

ps = (D / "activate-bridge-cap.ps1").read_text()
blk = re.search(r"\$Insert = @\((.*?)\)\n\$Out", ps, re.S).group(1)
lits = re.findall(r"'((?:[^']|'')*)'|\"([^\"]*)\"", blk)
script_lines = [a.replace("''", "'") if a or not b else b for a, b in lits]
check("4a the activation script inserts the same 4 lines as the template", script_lines == inserted, str(script_lines))
check("4b the script's double-quoted literal holds nothing PowerShell expands", all("$" not in b and "`" not in b for _, b in lits if b))
check("4c the script restarts nothing (no Stop-/Start-/Restart- cmdlets, no taskkill/Stop-Process)",
      not re.search(r"(?i)\b(Start|Stop|Restart|End)-(ScheduledTask|Service|Process|VM)\b|taskkill", ps))
check("4d braces and parentheses balance in the script", ps.count("{") == ps.count("}") and ps.count("(") == ps.count(")"))

for s, n in results: print(s, n)
f = sum(s == "FAIL" for s, _ in results); print(f"{len(results) - f}/{len(results)} PASS"); sys.exit(1 if f else 0)
