# The one-hop change (main f814b020a) carried onto a host's network agent bundle that is older than main.
#
#   python3 -I one-hop-agent-bundle.py BASE PARENT NEW OUT
#
# BASE    the host's privacy-agent.mjs with near routes already carried onto it (ops/near-routes-20261115)
# PARENT  the same entry point built from main's f814b020a^ (the commit before the change)
# NEW     the same entry point built from main's f814b020a
# OUT     BASE with the change and nothing else
#
# Each part of BASE the change touches must be the text this script expects, or it refuses:
#   network-policy-core.mjs   one token of the validator (guard must be a boolean, not true)
#   wg-manager.mjs            the whole section is replaced; BASE's must equal PARENT's line for line
#   wg-circuit-runtime.mjs    BASE's runtime is older than PARENT's (no start-up cancellation, no withdrawal bookkeeping), so
#                             each changed line is placed on its own: a replaced line must be PARENT's line and occur
#                             once in BASE; what replaces it is NEW's line. The exit grant of a one-hop circuit is NEW's
#                             block without the three things BASE's runtime does not have (live(), exitAsked, exitRefused)
#   enclave-network-host.mjs  the operator's setting: one function, one line that reads it, one field handed on
#   privacy-agent.mjs         how a route is probed (one function, one call) and the setting handed to the manager
# Everything else in OUT is BASE byte for byte.
import sys, re

base, parent, new = (open(p, encoding="utf-8", newline="").read().split("\n") for p in sys.argv[1:4])
MARK = re.compile(r"^// (?:[\w.@/-]*/)?((?:network/)?[\w.-]+\.(?:mjs|js|cjs|json))$")


def refuse(why):
    sys.exit("refused: " + why)


def body(lines, name):
    """(start, end, lines) of the largest top-level section named network/<name>, without its marker line."""
    marks = [i for i, l in enumerate(lines) if MARK.match(l)]
    found = [(i, marks[k + 1] if k + 1 < len(marks) else len(lines)) for k, i in enumerate(marks)
             if MARK.match(lines[i]).group(1) in (name, "network/" + name) and "host-services" not in lines[i]]
    if not found:
        refuse(f"no {name} section")
    s, e = max(found, key=lambda r: r[1] - r[0])
    return s, e, lines[s + 1:e]


def once(lines, text, what, prefix=False):
    hits = [i for i, l in enumerate(lines) if (l.startswith(text) if prefix else l == text)]
    if len(hits) != 1:
        refuse(f"{what}: expected exactly one line {text.strip()[:70]!r}, found {len(hits)}")
    return hits[0]


def run(lines, first, last, what):
    """The lines of NEW from the one starting with `first` to the next one equal to `last`."""
    i = once(lines, first, what, prefix=True)
    j = next((k for k in range(i, len(lines)) if lines[k] == last), None)
    if j is None:
        refuse(f"{what}: no end line")
    return lines[i:j + 1]


if any("oneHop" in l for l in base):
    refuse("BASE already mentions oneHop")
out = list(base)

# 1. network-policy-core.mjs: the owner's guard may be false
s, e, sec = body(out, "network-policy-core.mjs")
_, _, want = body(new, "network-policy-core.mjs")
i = [k for k, l in enumerate(sec) if "n.guard !== true" in l]
if len(i) != 1 or sec[i[0]].count("n.guard !== true") != 1:
    refuse("the validator's guard check is not there once")
line = sec[i[0]].replace("n.guard !== true", 'typeof n.guard !== "boolean"')
if want.count(line) != 1:
    refuse("the validator line would not be main's")
out[s + 1 + i[0]] = line

# 2. wg-manager.mjs, whole
s, e, have = body(out, "wg-manager.mjs")
_, _, was = body(parent, "wg-manager.mjs")
_, _, now = body(new, "wg-manager.mjs")
if have != was:
    refuse("BASE's wg-manager.mjs section is not main's parent text")
out = out[:s + 1] + now + out[e:]

# 3. wg-circuit-runtime.mjs, line by line
s, e, sec = body(out, "wg-circuit-runtime.mjs")
_, _, was = body(parent, "wg-circuit-runtime.mjs")
_, _, now = body(new, "wg-circuit-runtime.mjs")
W = "wg-circuit-runtime.mjs"


def swap(old, repl):
    """Replace the one line `old` (PARENT's, gone from NEW) by `repl` (NEW's, in that order)."""
    if was.count(old) != 1 or old in now:
        refuse(f"{W}: {old.strip()[:60]!r} is not a line the change replaces")
    k = once(now, repl[0], W)
    if now[k:k + len(repl)] != repl:
        refuse(f"{W}: the replacement for {old.strip()[:60]!r} is not main's")
    i = once(sec, old, W)
    sec[i:i + 1] = repl


def after(anchor, add, prefix=False):
    """Insert `add` (consecutive lines of NEW that follow `anchor` there) after the one line `anchor`."""
    k = once(now, anchor, W, prefix)
    if now[k + 1:k + 1 + len(add)] != add:
        refuse(f"{W}: {add[0].strip()[:60]!r} does not follow {anchor.strip()[:40]!r} in main")
    i = once(sec, anchor, W, prefix)
    sec[i + 1:i + 1] = add


START = '  async start({ deploymentId, names, kind = "network", guard, exit, byo,'
k = once(now, START, W, prefix=True)
note = now[k - 3:k]
if not (note[0].startswith("  // guard null (one hop") and all(l.startswith("  // ") for l in note)):
    refuse(f"{W}: the note on a null guard is not where expected")
i = once(sec, START, W, prefix=True)
sec[i:i] = note
swap('    if (kind === "network" && (!guard || !exit || guard.address === exit.address)) throw new Error("a guard and a different exit are required");',
     ['    const oneHop = kind === "network" && !guard;',
      '    if (oneHop && (service || exitRole !== "exit")) throw new Error("only an app\'s circuit may be one hop");',
      '    if (kind === "network" && (!exit || !oneHop && guard.address === exit.address)) throw new Error("a guard and a different exit are required");'])
after("      kind,", ["      oneHop,"])
swap("      providers: kind === \"network\" ? { guard, exit, public: { address: exit.address, fallback: fallback2 } } : { byo: { address: byo.endpoint.address } }",
     ["      providers: kind === \"network\" ? { guard: guard || null, exit, public: { address: exit.address, fallback: fallback2 } } : { byo: { address: byo.endpoint.address } }"])
OLD, NEWL = '      if (kind === "network") {', '      if (kind === "network" && !oneHop) {'
if sec.count(OLD) != 2 or was.count(OLD) != 2 or now.count(OLD) != 0 or now.count(NEWL) != 2:
    refuse(f"{W}: the two guarded blocks are not as expected")
sec[:] = [NEWL if l == OLD else l for l in sec]
swap("      const udpPeer = kind === \"network\" ? `${guard.address}:${guard.ports.guard}` : `${byo.endpoint.address}:${byo.endpoint.port}`;",
     ["      const udpPeer = oneHop ? `${exit.address}:${exit.ports.exit}` : kind === \"network\" ? `${guard.address}:${guard.ports.guard}` : `${byo.endpoint.address}:${byo.endpoint.port}`;"])
# the exit's grant of a one-hop circuit: asked at the exit's listed control port, from this host's own address
grant = run(now, "      if (oneHop) {", "      }", W)
ASK = "        exitGrant = await this.grants.request({ provider: exit, url: `http://${exit.address}:${exit.ports.control}`, role: exitRole, deploymentId, wgPublicKey: keys3.exit.publicKey, ingress, egress })"
if grant != ["      if (oneHop) {", "        exitAsked = true;", ASK + ".catch((e) => {", "          exitRefused = e.refused === true;",
             "          throw e;", "        });",
             '        if (exitGrant.endpoint !== udpPeer) throw Object.assign(new Error("the exit granted another endpoint than its listed one"), { providerRole: "public" });',
             "        live();", "      }"]:
    refuse(f"{W}: main's one-hop grant is not the block expected")
if any(re.search(r"\b(live\(\)|exitAsked|exitRefused)", l) for l in sec) or not any(re.search(r"\blet guardGrant, exitGrant, keys3 = ", l) for l in sec):
    refuse(f"{W}: BASE's runtime is not the older one this was written for")
i = once(sec, '        if (service && !sameNames(exitGrant.names, service.granted)) throw Object.assign(new Error("the exit granted other names than this host\'s service names"), { providerRole: "public" });', W)
if sec[i + 1] != "      }" or sec[i + 2] != "      if (ingress) {":
    refuse(f"{W}: the guarded exit grant does not end where expected")
sec[i + 2:i + 2] = [grant[0], ASK + ";", grant[6], grant[8]]
swap("        ...kind !== \"network\" && this.paceMbps ? { paceMbps: this.paceMbps } : {},",
     ["        ...(kind !== \"network\" || oneHop) && this.paceMbps ? { paceMbps: this.paceMbps } : {},"])
swap("        until: Math.min(guardGrant.expiresAt, exitGrant.expiresAt),",
     ["        until: oneHop ? exitGrant.expiresAt : Math.min(guardGrant.expiresAt, exitGrant.expiresAt),"])
renew = run(now, "          if (oneHop) {", "          }", W)
if len(renew) != 5 or any("live()" in l or "rpc:" in l for l in renew):
    refuse(f"{W}: main's one-hop renewal is not the block expected")
after("        renew: async () => {", renew)
swap("        isolation: { platform: this.platform, directory: dir, wgDirectory: wgDir, guardAddress: kind === \"network\" ? outer.guardSocks : null },",
     ["        isolation: { platform: this.platform, directory: dir, wgDirectory: wgDir, guardAddress: kind === \"network\" && !oneHop ? outer.guardSocks : null },"])
swap("        tunnel: kind === \"network\" ? { guard: guardGrant.clientAddress, exit: exitGrant.clientAddress } : { byo: byo.addresses[0] },",
     ["        tunnel: kind === \"network\" ? { guard: oneHop ? null : guardGrant.clientAddress, exit: exitGrant.clientAddress } : { byo: byo.addresses[0] },"])
# every remaining use of the guard's grant or the outer tunnel is inside a guarded block, after the one-hop return, or a host service's
for k, l in enumerate(sec):
    if re.search(r"\bguardGrant\.|\bouter\.", l) and "oneHop" not in l:
        inside = any(sec[j] == NEWL for j in range(max(0, k - 12), k)) or "const x2 = " in l or "g2.clientAddress" in l or l.lstrip().startswith("...service ?")
        if not inside:
            refuse(f"{W}: line {k + 1} uses the guard outside a guarded block: {l.strip()[:70]!r}")
if sum("oneHop" in l for l in sec) != sum("oneHop" in l for l in now):
    refuse(f"{W}: the carried lines are not all of main's")
out = out[:s + 1] + sec + out[e:]

# 4. enclave-network-host.mjs: the operator's oneHop
s, e, sec = body(out, "enclave-network-host.mjs")
_, _, now = body(new, "enclave-network-host.mjs")
W = "enclave-network-host.mjs"
offer = run(now, "function oneHopOffer(v) {", "}", W)
k = once(now, "function oneHopOffer(v) {", W)
while now[k - 1].startswith("//"):
    k -= 1
    offer.insert(0, now[k])
i = once(sec, "async function createNetworkHost(", W, prefix=True)
sec[i:i] = offer
NEAR = '  if (c.nearRoutes !== void 0 && typeof c.nearRoutes !== "boolean") throw new Error("Enclave network: nearRoutes must be true or false");'
READ = "  const oneHop = oneHopOffer(c.oneHop);"
if now[once(now, NEAR, W) + 1] != READ:
    refuse(f"{W}: main does not read the setting where expected")
sec.insert(once(sec, NEAR, W) + 1, READ)
GIVE = "    distance: c.nearRoutes === true ? createProviderDistance("
k = once(now, GIVE, W, prefix=True)
if not now[k + 1].startswith("    // ") or now[k + 2] != "    oneHop,":
    refuse(f"{W}: main does not hand the setting on where expected")
i = once(sec, GIVE, W, prefix=True)
sec[i + 1:i + 1] = now[k + 1:k + 3]
if sum("oneHop" in l for l in sec) != sum("oneHop" in l for l in now):
    refuse(f"{W}: the carried lines are not all of main's")
out = out[:s + 1] + sec + out[e:]

# 5. privacy-agent.mjs: the probe of a route without a guard, and the setting handed to the manager
s, e, sec = body(out, "privacy-agent.mjs")
_, _, was = body(parent, "privacy-agent.mjs")
_, _, now = body(new, "privacy-agent.mjs")
W = "privacy-agent.mjs"
probe = run(now, "function routeProbeTransport(circuit, startupEgress = false) {", "}", W)
if len(probe) != 4:
    refuse(f"{W}: main's routeProbeTransport is not the four lines expected")
i = once(sec, "var PrivacyAgent = class {", W)
sec[i:i] = probe
DIST, ONE = "      distance: network.distance || null,", "      oneHop: network.oneHop || null,"
if now[once(now, DIST, W) + 1] != ONE:
    refuse(f"{W}: main does not hand the setting to the manager where expected")
sec.insert(once(sec, DIST, W) + 1, ONE)
HOW = '{ address: circuit.address, direct: circuit.transport === "direct", proxy: circuit.transport === "direct" ? void 0 : circuit.isolation.guardAddress, domainIndependent: circuit.transport !== "direct" && apps.find((a) => a.deploymentId === id)?.startupEgress === true }'
CALL = "routeProbeTransport(circuit, apps.find((a) => a.deploymentId === id)?.startupEgress === true)"
if sum(l.count(HOW) for l in was) != 1 or sum(l.count(HOW) for l in now) != 0 or sum(l.count(CALL) for l in now) != 1 or sum(l.count(HOW) for l in sec) != 1:
    refuse(f"{W}: the route probe's transport is not written as expected")
sec[:] = [l.replace(HOW, CALL) for l in sec]
if any("guardAddress" in l for k, l in enumerate(sec) if "function routeProbeTransport" not in sec[max(0, k - 2)]):
    refuse(f"{W}: something else reads a circuit's guard address")
out = out[:s + 1] + sec + out[e:]

# nothing else in the bundle reads the guard of an app's circuit: the control circuit and host services keep theirs
for name in ("wg-control.mjs", "host-service-transport.mjs"):
    if body(parent, name)[2] != body(new, name)[2]:
        refuse(f"main changed {name} too")
open(sys.argv[4], "w", encoding="utf-8", newline="").write("\n".join(out))
print(f"written: {len(out)} lines ({len(out) - len(base):+d})")
