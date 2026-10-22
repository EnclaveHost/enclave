#!/usr/bin/env python3
# Applies the host-capacity integration edits to a tree (default: the current directory). Each edit anchors on exact
# text and refuses (exit 1, nothing written for that file) when its anchor is missing or not unique, so a moved
# owner file is reported, never half-patched. The *.patch files beside this script are this script's output against
# the tree of 2026-10-19; regenerate them with make-patches.sh once the owners release their files.
#   python3 work/host-capacity-integration/apply-edits.py [ROOT] [--only supervisor|dockerfile|windows|cli|docs|clitest]
import sys, os

SUPERVISOR = [
 ('''         FORWARDER_ADDRESS, PROOF_OF_TIME_ADDRESS } from "./addressbook.js";
''', '''         FORWARDER_ADDRESS, PROOF_OF_TIME_ADDRESS } from "./addressbook.js";
// This host's own signed capacity record for independent readers (docs/network/independent-capacity.md).
import { createHostCapacityProducer, capacityDirectoryOrigins, HOST_CAPACITY_PATH } from "./network/host-capacity-producer.mjs";
'''),
 ('''  } catch (e) {
    return res.json(shape(maxFreeCpu(), maxFreeGpuShare(), "fallback",
      `${PROVISION_BACKEND === "vm" ? "wasm" : "worker"} manager unreachable`));
  }
});
''', '''  } catch (e) {
    return res.json(shape(maxFreeCpu(), maxFreeGpuShare(), "fallback",
      `${PROVISION_BACKEND === "vm" ? "wasm" : "worker"} manager unreachable`));
  }
});

// GET /v1/host/capacity: the /availability document above, byte for byte, signed by the registry operator key for the
// endpoint this host registered, on the registry it registered on (network/host-capacity-producer.mjs), so readers
// with no relay can use it (cli/independent-capacity.mjs). The signature says WHO reported the numbers; it is not
// proof the hardware is free, and readers check the signer against the pinned registry at an agreed block.
// HOST_CAPACITY_DIRECTORIES: optional explicit directory origins (comma list, 1..8) the record is also POSTed to,
// every half lifetime. No default: nothing is published anywhere unless the operator names it.
// It signs only for a CONFIRMED registration on the CURRENT registry, read on every request. _registered alone is not
// that: registerOnChain sets it BEFORE its transaction lands, and it outlives a repoint of the registry by the address
// book. So all of: the once-guard is up; it was sent to the registry REGISTRY_ADDRESS names now; and _enclaveId - set
// only when the register transaction succeeded, cleared by a repoint - is the enclaveId of the endpoint signed for.
// Anything else answers 503 "not registered yet" and signs nothing.
function capacityIdentity() {
  const registry = (REGISTRY_ADDRESS || "").toLowerCase();
  if (!_registered || !registry || _registeredOn !== registry) return null;
  // the landed id names the endpoint: no endpoint, or another one, matches it (registerOnChain never registers "")
  if (_enclaveId !== keccak256(stringToBytes(String(_advertisedEndpoint)))) return null;
  return { endpoint: _advertisedEndpoint, registry };
}
const _capacity = REGISTRY_READY ? createHostCapacityProducer({
  account: privateKeyToAccount(REGISTRY_PK.startsWith("0x") ? REGISTRY_PK : `0x${REGISTRY_PK}`), chainId: CHAIN_ID,
  hostIdOf: (endpoint) => keccak256(stringToBytes(endpoint)),   // the registry's enclaveId of an endpoint
  identity: capacityIdentity,
  availability: async () => {
    const r = await fetch(`http://127.0.0.1:${server.address()?.port ?? PORT}/availability`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`/availability answered ${r.status}`);
    return r.json();
  },
}) : null;
app.get(HOST_CAPACITY_PATH, async (_req, res) => {
  if (!_capacity) return fail(res, 503, "not_advertised", "this host does not advertise in the registry, so it signs no capacity record");
  const f = await _capacity.frame();
  res.status(f.status).set(f.headers).send(f.body);
});
let _capacityDirs = [];
try { const v = envList(process.env.HOST_CAPACITY_DIRECTORIES); _capacityDirs = v.length ? capacityDirectoryOrigins(v) : []; }
catch (e) { console.warn(`[capacity] HOST_CAPACITY_DIRECTORIES ignored: ${e.message}`); }
if (_capacity && _capacityDirs.length) setInterval(() => {
  if (!capacityIdentity()) return;
  _capacity.publish(_capacityDirs).then((all) => { for (const x of all) if (!x.ok) console.warn(`[capacity] ${x.origin}: ${x.error || x.status}`); })
    .catch((e) => console.warn(`[capacity] not published: ${e.message}`));
}, 150_000).unref();
'''),
 ('''server.listen(PORT, () => console.log(`enclave supervisor on :${PORT} · ${IS_GPU''', '''// HOST_CAPACITY_SELFTEST='{"endpoint":"https://…","registered":true,"confirmed":true,"confirmedFor":"https://…","registeredOn":"current"|"0x…"}'
// (work/host-capacity-integration): put the registration state where registerOnChain leaves it (registered = the
// once-guard, confirmed = the register transaction landed (_enclaveId), registeredOn = the registry it was sent to),
// serve on an ephemeral loopback port and print this host's /availability and its /v1/host/capacity answer.
if (process.env.HOST_CAPACITY_SELFTEST) {
  const c = JSON.parse(process.env.HOST_CAPACITY_SELFTEST);
  _advertisedEndpoint = c.endpoint || null; _registered = c.registered === true;
  _registeredOn = c.registeredOn === "current" ? (REGISTRY_ADDRESS || "").toLowerCase() : c.registeredOn || null;
  // confirmedFor: the endpoint the register transaction landed for, when not the one now known (default: that one)
  const landed = c.confirmed === true ? c.confirmedFor || c.endpoint : null;
  _enclaveId = landed ? keccak256(stringToBytes(landed)) : null;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: r.status, body: await r.json() }; };
  console.log(JSON.stringify({ availability: await get("/availability"), capacity: await get(HOST_CAPACITY_PATH) }));
  process.exit(0);
}

server.listen(PORT, () => console.log(`enclave supervisor on :${PORT} · ${IS_GPU'''),
]

DOCKERFILE = [
 ('''COPY net-guard.mjs ./
''', '''COPY net-guard.mjs ./
# the host's own signed capacity record (GET /v1/host/capacity): the producer and the record core, no packages
COPY network/canonical.mjs network/host-capacity-record.mjs network/host-capacity-producer.mjs ./network/
'''),
]

WINDOWS = [
 ("""import { resolveIdentity } from './host-identity.mjs';
""", """import { resolveIdentity } from './host-identity.mjs';
// this box's own signed capacity record for independent readers (docs/network/independent-capacity.md); no packages
import { createHostCapacityProducer, HOST_CAPACITY_PATH } from '../../network/host-capacity-producer.mjs';
"""),
 ("""import { CONTRACT_PINS, addressBook, addresses as chainAddresses, publicClient } from './chain.mjs';""",
  """import { CONTRACT_PINS, addressBook, addresses as chainAddresses, publicClient, operatorAccount, operatorAddress, enclaveIdOf } from './chain.mjs';"""),
 ("""let shieldSecrets = null;
async function handle(frame) {""", """let shieldSecrets = null;
// GET /v1/host/capacity: the /availability below, signed by this box's registry operator key for the endpoint the
// registry lists it under (network/host-capacity-producer.mjs), so a reader with no relay can use it. It says who
// reported the numbers, not that the card or the cores are free. Made once the operator key is loaded; signs only while
// the registry row read at start (host.registered) is active and this key's.
let capacity = null;
function capacityProducer() {
  if (capacity || !operatorAccount()) return capacity;
  // the registry row this box read for its own endpoint: signed for only while it is active and names this key
  const identity = () => { const e = host.registered;
    return e && e.active === true && e.endpoint && chainAddresses.registry && String(e.operator).toLowerCase() === String(operatorAddress()).toLowerCase()
      ? { endpoint: e.endpoint, registry: chainAddresses.registry } : null; };
  capacity = createHostCapacityProducer({ account: operatorAccount(), hostIdOf: enclaveIdOf, chainId: 8453, identity,
    availability: async () => { const r = await handle({ path: '/availability', method: 'GET' }); if (r.status !== 200) throw new Error(`/availability answered ${r.status}`); return JSON.parse(r.body); } });
  return capacity;
}
async function handle(frame) {"""),
 ("""  // ---- who is asking ---------------------------------------------------------------------
  // The public half of this box's session key.""", """  if (p === HOST_CAPACITY_PATH && method === 'GET') {
    const c = capacityProducer();
    return c ? c.frame() : json(503, { error: 'capacity_not_signed', reason: 'no operator key on this box: it signs no capacity record' });
  }
  // ---- who is asking ---------------------------------------------------------------------
  // The public half of this box's session key."""),
]

CLI = [
 ('''async function cmdAvailability() {
  if (INDEPENDENT) throw new Error("free capacity is a host fact that is not on chain; independent mode lists registered hosts and their posted prices instead: enclave hosts");
''', '''async function cmdAvailability(rest = []) {
  if (INDEPENDENT) return cmdAvailabilityIndependent(rest);
'''),
 ('''async function cmdGpu(rest = []) {
  if (INDEPENDENT) return cmdGpuIndependent(rest);''', '''// Independent mode: free capacity is each host's own signed /availability record (cli/independent-capacity.mjs), read
// from capacity directories the user names, from named registered hosts, or from every live registered host (--cold),
// and verified against the reviewed profile's registry at one agreed block of this quorum. Self-reported by each host's
// registry operator, never proof of free hardware, and never a registered price.
async function cmdAvailabilityIndependent(rest) {
  const f = flags(rest, { bool: ["--cold"], val: ["--capacity-directories", "--hosts", "--max-hosts", "--capacity-state"] });
  const { chain, trust } = INDEPENDENT;
  if (!trust.profile) throw new Error("independent availability binds host records to the reviewed registry code: run it with --profile FILE --profile-digest sha256:… (explicit --contract-pins carry no code hash)");
  const list = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
  const directories = list(f["capacity-directories"]), hosts = list(f.hosts);
  if (!directories.length && !hosts.length && !f.cold)
    throw new Error("usage: enclave availability --independent … --capacity-directories URL,… | --hosts ENDPOINT|ID,… | --cold [--max-hosts N] [--capacity-state FILE]   (name a source: there is no default directory)");
  const C = await import("./independent-capacity.mjs");
  const r = await C.readCapacity({ reader: chain, profile: trust.profile, directories, hosts, cold: !!f.cold, maxHosts: f["max-hosts"], state: f["capacity-state"] });
  if (opt.json) return jout({ ...r, profileDigest: trust.digest });
  C.renderCapacity(r, trust.digest, say);
}

async function cmdGpu(rest = []) {
  if (INDEPENDENT) return cmdGpuIndependent(rest);'''),
 ('''  ls [--owner ADDR] · status <id> · hosts [--all] · pricing · apps · whoami
''', '''  ls [--owner ADDR] · status <id> · hosts [--all] · pricing · apps · whoami
  availability --capacity-directories URL,… | --hosts ENDPOINT,… | --cold [--max-hosts N] [--capacity-state FILE]
      (hosts' own signed /availability, checked against the profile's registry; self-reported, not a price)
'''),
]

DOCS = [
 ('''- **`availability`:** free capacity is a host fact that is neither on chain nor in the directories. Use `hosts`.
''', ''''''),
]
DOCS_ADD = '''
**`availability`.** Each host's own signed `/availability` record (`docs/network/independent-capacity.md`). Name a source:
`--capacity-directories URL,…` (anyone's capacity directory, not the management `--directories`), `--hosts ENDPOINT|ID,…`,
or `--cold` (every live registered host). Each record is verified against the reviewed profile's registry at one agreed
block, so `--profile` is required. The figures are self-reported by the host's registry operator and are never a
registered price; `hosts` still lists the posted prices.
'''

CLITEST = [
 ('''  const avail = await cli(["availability"]);
  assert.equal(avail.code, 1); assert.match(avail.err, /not on chain/);
''', '''  // availability reads hosts' signed capacity records, bound to the reviewed registry CODE: explicit pins carry no code hash
  const avail = await cli(["availability"]);
  assert.equal(avail.code, 1); assert.match(avail.err, /reviewed registry code: run it with --profile/);
'''),
]

TARGETS = {"supervisor": ("supervisor.js", SUPERVISOR), "dockerfile": ("Dockerfile", DOCKERFILE), "windows": ("windows/node/agent.mjs", WINDOWS),
           "cli": ("cli/enclave.mjs", CLI), "docs": ("docs/network/independent-cli.md", DOCS), "clitest": ("test/cli-independent.test.mjs", CLITEST)}

def apply(root, name):
    rel, edits = TARGETS[name]
    p = os.path.join(root, rel); s = open(p, encoding="utf-8").read()
    for a, b in edits:
        n = s.count(a)
        if n != 1: print(f"{rel}: anchor found {n} times, not patched: {a[:70]!r}"); return False
        s = s.replace(a, b)
    if name == "docs":
        anchor = "**Refused commands.**"
        if s.count(anchor) != 1: print(f"{rel}: anchor found {s.count(anchor)} times, not patched"); return False
        s = s.replace(anchor, DOCS_ADD.strip() + "\n\n" + anchor)
    open(p, "w", encoding="utf-8").write(s); print(f"{rel}: patched"); return True

if __name__ == "__main__":
    argv = sys.argv[1:]; only = None
    if "--only" in argv: i = argv.index("--only"); only = argv[i + 1]; del argv[i:i + 2]
    root = argv[0] if argv else "."
    ok = all([apply(root, n) for n in ([only] if only else TARGETS)])
    sys.exit(0 if ok else 1)
