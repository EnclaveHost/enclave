# The near-routes change (main 1b06202c3) carried onto an INSTALLED network agent bundle that is older than main.
#
#   python3 -I near-routes-bundle.py INSTALLED PARENT NEW OUT
#
# INSTALLED  the host's installed privacy-agent.mjs (an esbuild bundle, unminified)
# PARENT     the same bundle built from main's a640a54b9 (the commit before the change)
# NEW        the same bundle built from main's 1b06202c3
# OUT        INSTALLED with the change and nothing else
#
# It refuses unless every part of the installed bundle that the change touches is the text main's parent has there:
#   wg-manager.mjs            the whole section is replaced; the installed one must equal PARENT's line for line
#   provider-distance.mjs     new section, placed before enclave-network-host.mjs; its top-level names get a near
#                             prefix (the installed bundle numbers its imports differently from a build of main)
#   enclave-network-host.mjs  two insertions, each after one line that must occur exactly once in INSTALLED
#   privacy-agent.mjs         one insertion, likewise
# Everything else in OUT is INSTALLED byte for byte, including what the installed bundle lacks from later main.
import sys, re

inst, parent, new = (open(p, encoding="utf-8", newline="").read().split("\n") for p in sys.argv[1:4])
MARK = re.compile(r"^// (?:[\w.@/-]*/)?((?:network/)?[\w.-]+\.(?:mjs|js|cjs|json))$")


def sections(lines, name):
    """[(start, end)] of the top-level sections whose marker names network/<name> (or <name> in a build rooted there)."""
    marks = [i for i, l in enumerate(lines) if MARK.match(l)]
    out = []
    for k, i in enumerate(marks):
        tail = MARK.match(lines[i]).group(1)
        if tail in (name, "network/" + name) and "host-services" not in lines[i]:
            out.append((i, marks[k + 1] if k + 1 < len(marks) else len(lines)))
    return out


def body(lines, name):
    """The section's largest part (a module's code; its other parts are import stubs), without the marker line."""
    s, e = max(sections(lines, name), key=lambda r: r[1] - r[0])
    return s, e, lines[s + 1:e]


def once(lines, text):
    hits = [i for i, l in enumerate(lines) if l == text]
    if len(hits) != 1:
        sys.exit(f"refused: expected exactly one line {text.strip()[:70]!r}, found {len(hits)}")
    return hits[0]


# 1. wg-manager.mjs
s, e, have = body(inst, "wg-manager.mjs")
_, _, was = body(parent, "wg-manager.mjs")
_, _, now = body(new, "wg-manager.mjs")
if have != was:
    sys.exit("refused: the installed wg-manager.mjs section is not main's parent text")
if "var NEAR_MARGIN_MS = 40;" not in now or any("NEAR_MARGIN" in l for l in inst):
    sys.exit("refused: unexpected NEAR_MARGIN state")
out = inst[:s + 1] + now + inst[e:]

# 2. provider-distance.mjs, before the enclave-network-host.mjs code
_, _, dist = body(new, "provider-distance.mjs")
imp = [l for l in dist if l.startswith("import ")]
if len(imp) != 1 or not re.fullmatch(r'import (net\d*) from "node:net";', imp[0]):
    sys.exit("refused: provider-distance.mjs imports are not the one expected")
netname = re.fullmatch(r'import (net\d*) from "node:net";', imp[0]).group(1)
rename = {netname: "nearNet", "PORT": "NEAR_PORT", "SAMPLES": "NEAR_SAMPLES", "TIMEOUT_MS": "NEAR_TIMEOUT_MS",
          "RETRY_MS": "NEAR_RETRY_MS", "PARALLEL": "NEAR_PARALLEL"}
text = "\n".join(dist)
for a, b in rename.items():
    text, n = re.subn(rf"(?<![\w$.]){re.escape(a)}(?![\w$])", b, text)
    if not n:
        sys.exit(f"refused: {a} not found in provider-distance.mjs")
for name in list(rename.values()) + ["handshakeMs", "createProviderDistance"]:
    if any(re.search(rf"(?<![\w$]){name}(?![\w$])", l) for l in out):
        sys.exit(f"refused: the installed bundle already has a {name}")
hs, he, _ = body(out, "enclave-network-host.mjs")
out = out[:hs] + ["// network/provider-distance.mjs (near routes, main 1b06202c3)"] + text.split("\n") + out[hs:]

# 3. enclave-network-host.mjs: the flag's validation, and the measurer handed to the agent
_, _, enh = body(new, "enclave-network-host.mjs")
check = '  if (c.nearRoutes !== void 0 && typeof c.nearRoutes !== "boolean") throw new Error("Enclave network: nearRoutes must be true or false");'
give = [l for l in enh if "distance: c.nearRoutes === true ? createProviderDistance(" in l]
if check not in enh or len(give) != 1:
    sys.exit("refused: the new enclave-network-host.mjs does not have the two lines expected")
logname = re.search(r"createProviderDistance\(\{ log: (\w+) \}\)", give[0]).group(1)
i = once(out, '''  if (c.apps !== "all" && !Array.isArray(c.apps)) throw new Error('Enclave network: apps must be "all" or a list');''')
out.insert(i + 1, check)
i = once(out, "    localRoutes: c.localRoutes !== false,")
hs, he, _ = body(out, "enclave-network-host.mjs")
if not hs < i < he or not any(re.search(rf"\blog: {logname}\b", l) for l in out[hs:i]):
    sys.exit("refused: the installed enclave-network-host.mjs does not name its log as the new one does")
out[i + 1:i + 1] = ["    // nearRoutes (optional, off unless true): this host measures how far each ingress provider is and builds its circuits",
                    "    // through the nearest (provider-distance.mjs; docs/design/enclave-network.md, \"Near routes\")", give[0]]

# 4. privacy-agent.mjs: the manager gets the measurer
line = "      distance: network.distance || null,"
_, _, pa = body(new, "privacy-agent.mjs")
if pa.count(line) != 1 or pa[pa.index(line) - 1] != "      hostEgress: network.hostEgress || null,":
    sys.exit("refused: the new privacy-agent.mjs does not pass the measurer where expected")
i = once(out, "      hostEgress: network.hostEgress || null,")
ps, pe, _ = body(out, "privacy-agent.mjs")
if not ps < i < pe:
    sys.exit("refused: the manager is not built in the installed privacy-agent.mjs section")
out.insert(i + 1, line)

open(sys.argv[4], "w", encoding="utf-8", newline="").write("\n".join(out))
print(f"written: {len(out)} lines ({len(out) - len(inst):+d})")
