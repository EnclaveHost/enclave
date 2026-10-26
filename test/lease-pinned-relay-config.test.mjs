// PINNED host-local lease relays (ENCLAVE_LEASE_GAS_PINNED_RELAYS; the metal conduit's `pinnedRelays`): configuration only,
// no chain (the real relay and both hosts' factories are exercised in lease-pinned-relay.test.mjs).
//   1. the endpoint rule: a private IPv4 literal on the host link with an explicit port, as its bare origin, bound to a payee
//      and a registered operator - and nothing else (DNS names, public/loopback/link-local/CGNAT/IPv6 addresses, paths,
//      queries, fragments, credentials, non-canonical forms);
//   2. the shared loader (network/lease-gas-runtime.mjs, the Linux supervisor's and the Windows node's): pinned relays may
//      be the only route; partial or invalid configuration REFUSES; absent, the loaded configuration is exactly as before;
//   3. the conduit: absent, the transit, the guest names and the bound direct-config digest are byte-identical to main's
//      (golden values computed with main's own code); present, the legacy fw_cfg path and the HOST_DATA-bound direct path
//      hand the supervisor the same validated names, and the loader reads them back as the same pinned relays;
//   4. what stays refused: discovery still drops private endpoints; a pinned relay never runs without the platform
//      policy's admission (the client refuses to be built without it; the factory refuses with the policy off);
//   5. who admits a relay ROLE: the platform host policy gate, keyed by the host's registered endpoint - not the host
//      ownership extension (no owner logic in the gate or the role).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { validatePinnedRelay, parsePinnedRelays, pinnedRelaysValue, createLeaseClient, validateRelayUrl, validateLocalRelayUrl } from "../client/lease-executor-client.mjs";
import { loadLeaseGasConfig, configuredLeaseSender } from "../network/lease-gas-runtime.mjs";
import * as LG from "../network/lease-gas-conduit.mjs";
import * as MC from "../metal/guest/measured-control.mjs";
import * as si from "../network/service-index.mjs";
import { hostIdOfEndpoint } from "../network/host-service-gate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-relay-config-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sha = (s) => createHash("sha256").update(s).digest("hex");
// the reviewed public deployment record of the live reserve/executor (the same bytes as metal-lease-gas-conduit.test.mjs)
const RECORD = Buffer.from('{"format":"enclave-lease-gas-deployment/v1","chainId":8453,"reserve":"0x12A3f873041Dec436DaA0085B766a399A6fA3639","executor":"0x8900BACA2167873BA2F8a8bAE8b4876E6396d343","reserveCodeHash":"0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979","executorCodeHash":"0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2","ledger":"0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B","registry":"0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC"}');
const DIGEST = "sha256:" + sha(RECORD);
const RECORD_FILE = path.join(tmp, "deployment.json"); fs.writeFileSync(RECORD_FILE, RECORD);
const read = (f) => fs.readFileSync(f);
const BINDING = { chain: base, ledger: "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B", registry: "0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC" };
const RPCS = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
// the eu-central relay key's payee, now on warden's host role, and metal0's registered operator (public addresses)
const PAYEE = "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a";
const OP = "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab";        // lowercase is valid (no checksum to check)
const LINUX = { origin: "http://10.0.2.2:8549", payee: PAYEE, operator: OP }, WINDOWS = { origin: "http://192.168.8.249:8549", payee: PAYEE, operator: OP };
const checked = (r) => validatePinnedRelay(r);
const ENV = (extra = {}) => ({ ENCLAVE_LEASE_GAS_FILE: RECORD_FILE, ENCLAVE_LEASE_GAS_DIGEST: DIGEST, ENCLAVE_LEASE_GAS_RPCS: RPCS.join(","), ...extra });

test("the endpoint rule: a private IPv4 literal on the host link, explicit port, bare origin, bound payee and operator", () => {
  for (const origin of ["http://10.0.2.2:8549", "http://192.168.8.249:8549", "http://172.16.0.9:9000", "http://172.31.255.254:1", "https://10.1.2.3:8443"]) {
    const r = validatePinnedRelay({ origin, payee: PAYEE, operator: OP });
    assert.equal(r.origin, origin); assert.equal(r.payee, PAYEE); assert.equal(r.operator.toLowerCase(), OP); assert.ok(Object.isFrozen(r));
  }
  const bad = [
    ["http://relay.lan:8549", /private IPv4 literal/], ["http://localhost:8549", /private IPv4 literal/], ["http://warden:8549", /private IPv4 literal/],
    ["http://127.0.0.1:8549", /private IPv4 literal/], ["http://8.8.8.8:8549", /private IPv4 literal/], ["http://134.209.248.172:8549", /private IPv4 literal/],
    ["http://169.254.1.1:8549", /private IPv4 literal/], ["http://100.64.1.1:8549", /private IPv4 literal/], ["http://172.32.0.1:8549", /private IPv4 literal/],
    ["http://172.15.0.1:8549", /private IPv4 literal/], ["http://[fd00::1]:8549", /private IPv4 literal/], ["http://0.0.0.0:8549", /private IPv4 literal/],
    ["http://10.0.2.2", /names its port explicitly/], ["https://10.0.2.2:443", /bare origin/], ["http://10.0.2.2:80", /bare origin/],
    ["http://10.0.2.2:8549/", /bare origin/], ["http://10.0.2.2:8549/v1", /bare origin/], ["http://10.0.2.2:8549?x=1", /bare origin/], ["http://10.0.2.2:8549#f", /bare origin/],
    ["http://u:p@10.0.2.2:8549", /bare origin/], ["http://10.2:8549", /bare origin/], ["http://012.0.2.2:8549", /bare origin/], ["http://0x0a.0.2.2:8549", /bare origin/],
    ["HTTP://10.0.2.2:8549", /bare origin/], ["ftp://10.0.2.2:8549", /http or https/], ["ws://10.0.2.2:8549", /http or https/], ["10.0.2.2:8549", /not a URL|http or https/],
  ];
  for (const [origin, re] of bad) assert.throws(() => validatePinnedRelay({ origin, payee: PAYEE, operator: OP }), re, origin);
  for (const [e, re] of [[{ origin: LINUX.origin, payee: PAYEE }, /operator must be/], [{ origin: LINUX.origin, operator: OP }, /payee must be/],
    [{ ...LINUX, payee: "0x" + "0".repeat(40) }, /payee must be/], [{ ...LINUX, payee: PAYEE.slice(0, 41) }, /payee must be/],
    [{ ...LINUX, payee: "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26A" }, /payee must be/], [{ ...LINUX, extra: 1 }, /unknown field/], [null, /is \{ origin/], ["http://10.0.2.2:8549", /is \{ origin/]])
    assert.throws(() => validatePinnedRelay(e), re, JSON.stringify(e));
  // the other modes are unchanged: public relays https only, the host's own relay loopback only
  assert.throws(() => validateRelayUrl("http://10.0.2.2:8549"), /must be https/);
  assert.throws(() => validateLocalRelayUrl("http://10.0.2.2:8549"), /local relay/);
  assert.equal(validateRelayUrl("https://relay.example.org"), "https://relay.example.org");
});

test("the environment form: origin,payee,operator entries separated by ';' (1 to 4), canonical round trip, refusals", () => {
  const v = `${LINUX.origin},${PAYEE},${OP} ; ${WINDOWS.origin},${PAYEE},${OP}`;
  const list = parsePinnedRelays(v);
  assert.deepEqual(list.map((r) => r.origin), [LINUX.origin, WINDOWS.origin]);
  assert.equal(pinnedRelaysValue(list), `${LINUX.origin},${PAYEE},${checked(LINUX).operator};${WINDOWS.origin},${PAYEE},${checked(LINUX).operator}`);
  assert.deepEqual(parsePinnedRelays(pinnedRelaysValue(list)), list);
  for (const [s, re] of [["", /1 to 4/], [";;", /1 to 4/], [`${LINUX.origin},${PAYEE}`, /exactly "origin,payee,operator"/],
    [`${LINUX.origin},${PAYEE},${OP},x`, /exactly/], [`${LINUX.origin},${PAYEE},${OP};${LINUX.origin},${PAYEE},${OP}`, /repeat an origin/],
    [Array.from({ length: 5 }, (_, i) => `http://10.0.2.${i + 2}:8549,${PAYEE},${OP}`).join(";"), /1 to 4/]])
    assert.throws(() => parsePinnedRelays(s), re, s);
});

test("the shared loader: pinned relays may be the ONLY route; partial or invalid refuses; absent keeps the exact configuration", () => {
  const only = loadLeaseGasConfig({ env: ENV({ ENCLAVE_LEASE_GAS_PINNED_RELAYS: pinnedRelaysValue([checked(LINUX)]) }), ...BINDING });
  assert.deepEqual(only.pinnedRelays, [checked(LINUX)]); assert.deepEqual([...only.relays], []); assert.deepEqual([...only.localRelays], []);
  // the Windows name form (LEASE_GAS_*) is the same setting; both set must agree
  const win = loadLeaseGasConfig({ env: { LEASE_GAS_FILE: RECORD_FILE, LEASE_GAS_DIGEST: DIGEST, LEASE_GAS_RPCS: RPCS.join(","), LEASE_GAS_LOCAL_RELAY: "http://127.0.0.1:8549",
    LEASE_GAS_PINNED_RELAYS: pinnedRelaysValue([checked(WINDOWS)]), LEASE_GAS_RELAYS: "https://134.209.248.172" }, ...BINDING });
  assert.deepEqual([[...win.localRelays], win.pinnedRelays.map((r) => r.origin), [...win.relays]], [["http://127.0.0.1:8549"], [WINDOWS.origin], ["https://134.209.248.172"]]);
  assert.throws(() => loadLeaseGasConfig({ env: ENV({ ENCLAVE_LEASE_GAS_PINNED_RELAYS: "a", LEASE_GAS_PINNED_RELAYS: "b" }), ...BINDING }), /conflicting/);
  for (const [v, re] of [[`${LINUX.origin},${PAYEE}`, /exactly/], ["http://relay.lan:8549," + PAYEE + "," + OP, /private IPv4 literal/], [`${LINUX.origin},${PAYEE},0x12`, /operator must be/]])
    assert.throws(() => loadLeaseGasConfig({ env: ENV({ ENCLAVE_LEASE_GAS_PINNED_RELAYS: v }), ...BINDING }), re, v);
  assert.throws(() => loadLeaseGasConfig({ env: { ENCLAVE_LEASE_GAS_PINNED_RELAYS: pinnedRelaysValue([checked(LINUX)]) }, ...BINDING }), /require ENCLAVE_LEASE_GAS_FILE/, "pinned alone is a PARTIAL configuration");
  assert.throws(() => loadLeaseGasConfig({ env: ENV(), ...BINDING }), /require ENCLAVE_LEASE_GAS_RELAYS/, "no route at all: refused, never operator-paid");
  // absent: the exact fields as before (no pinnedRelays key)
  const plain = loadLeaseGasConfig({ env: ENV({ ENCLAVE_LEASE_GAS_RELAYS: "https://relay.example.org" }), ...BINDING });
  // `authority` joined the exact fields with the chain authority: loadLeaseGasConfig returns authority: peers.authority
  // (network/lease-gas-runtime.mjs); leaseRpcSet's default for a non-verifier client set is "rpc-quorum" (client/lease-executor-authority.mjs)
  assert.deepEqual(Object.keys(plain).sort(), ["allowLoopbackHttp", "authority", "clients", "deployment", "localRelays", "quorum", "relayDiscovery", "relays", "reserve", "rpcTimeoutMs"]);
  assert.equal(plain.authority, "rpc-quorum", "absent chain authority: the legacy RPC quorum, exactly as before");
  assert.equal(plain.clients.length, RPCS.length); assert.equal(plain.quorum, 2);
  // the host's explicit local-verifier selection: ONE verifier client, required 1; the configured RPCs are never built
  const verified = loadLeaseGasConfig({ env: ENV({ ENCLAVE_LEASE_GAS_RELAYS: "https://relay.example.org", ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:28590/" }), ...BINDING });
  assert.deepEqual(Object.keys(verified).sort(), Object.keys(plain).sort());
  assert.equal(verified.authority, "local-verifier");
  assert.equal(verified.clients.length, 1); assert.equal(verified.quorum, 1);
  assert.ok(verified.clients[0][Symbol.for("enclave.chain-authority.local-verifier")], "the verifier client, marked in-process");
  // a verifier URL without the explicit selection is refused, never silently ignored or mixed
  assert.throws(() => loadLeaseGasConfig({ env: ENV({ ENCLAVE_LEASE_GAS_RELAYS: "https://relay.example.org", ENCLAVE_CHAIN_VERIFIER: "http://127.0.0.1:28590/" }), ...BINDING }), /is not verifier/);
});

test("a pinned relay is never usable without the platform policy's admission: the client refuses to be built without it; the factory's policy-off decision refuses", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const config = loadLeaseGasConfig({ env: ENV({ ENCLAVE_LEASE_GAS_PINNED_RELAYS: pinnedRelaysValue([checked(LINUX)]) }), ...BINDING });
  assert.throws(() => createLeaseClient({ clients: config.clients, account, reserve: config.reserve, deployment: config.deployment, pinnedRelays: config.pinnedRelays }), /needs the platform host policy's operator admission/);
  assert.throws(() => createLeaseClient({ clients: config.clients, account, reserve: config.reserve, deployment: config.deployment, relays: [], pinnedRelays: [{ ...LINUX, origin: "http://warden.lan:8549" }], admitPinnedRelay: async () => ({ admit: true }) }), /private IPv4 literal/);
  // the factory with the host's policy OFF (relayPolicy null) still builds - its pinned relays are refused at use, with words
  const off = configuredLeaseSender({ config, account, getBindings: () => BINDING, relayPolicy: null });
  assert.equal(typeof off.claim, "function");
  const src = fs.readFileSync(path.join(REPO, "network/lease-gas-runtime.mjs"), "utf8");
  assert.match(src, /admitPinnedRelay = !config\.pinnedRelays\?\.length \? null : decide \? relayAdmission\(decide\)\s*: async \(\) => \(\{ admit: false, status: "policy-off"/);
});

const HOST = (extra = {}) => ({ recordFile: RECORD_FILE, digest: DIGEST, rpcs: [...RPCS], relays: ["https://134.209.248.172"], quorum: 2, ...extra });
// main's own code, before this change, on the same inputs (golden/compute.mjs in work/pinned-host-relay; values pinned here)
const GOLDEN = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/pinned-relay/absent-golden.json"), "utf8"));

test("conduit ABSENT: the transit, both guest environments and the bound direct-config digest are byte-identical to main's", async () => {
  const r = spawnSync(process.execPath, [path.join(REPO, "test/fixtures/pinned-relay/golden-compute.mjs"), REPO], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const now = JSON.parse(r.stdout);
  for (const k of ["transitSha256", "legacyEnvSha256", "directEnvSha256", "directConfigDigest", "withoutLeaseGasDigest"]) assert.equal(now[k], GOLDEN[k], k);
  assert.deepEqual(Object.keys(now.legacyEnv).sort(), [...LG.ENV_NAMES].sort(), "the six names, no seventh");
});

test("conduit PRESENT: checked form only; the legacy fw_cfg path and the HOST_DATA-bound direct path reach the same validated loader", () => {
  const t = LG.leaseGasTransit(HOST({ pinnedRelays: [checked(LINUX)] }), { readFile: read });
  assert.deepEqual(t.pinnedRelays, [checked(LINUX)]); assert.deepEqual([...t.relays], ["https://134.209.248.172"]);
  // pinned as the ONLY route: relays may be omitted (it is then an empty list in the transit)
  const sole = LG.leaseGasTransit({ recordFile: RECORD_FILE, digest: DIGEST, rpcs: [...RPCS], pinnedRelays: [checked(LINUX)] }, { readFile: read });
  assert.deepEqual([...sole.relays], []);
  const wire = JSON.parse(JSON.stringify(sole));
  // legacy: fw_cfg JSON -> gsup leaseGasGuest
  const legacy = LG.leaseGasGuest(wire, { recordFile: path.join(tmp, "legacy.json") });
  assert.equal(legacy.ok, true, legacy.reason);
  assert.deepEqual(Object.keys(legacy.env).sort(), ["ENCLAVE_LEASE_GAS_DIGEST", "ENCLAVE_LEASE_GAS_FILE", "ENCLAVE_LEASE_GAS_PINNED_RELAYS", "ENCLAVE_LEASE_GAS_RESERVE", "ENCLAVE_LEASE_GAS_RPCS"]);
  assert.equal(legacy.env[LG.PINNED_ENV_NAME], pinnedRelaysValue([checked(LINUX)]));
  assert.match(legacy.summary, /1 pinned host relay\(s\) http:\/\/10\.0\.2\.2:8549/);
  // direct: the owner's bound config (canonical, HOST_DATA) -> measured-control directSupervisorEnv
  const a20 = (n) => "0x" + n.toString(16).padStart(40, "0");
  const RAW = { format: MC.CONFIG_FORMAT, chainId: 8453,
    contracts: { registry: a20(0x11), deployments: a20(0x12), appCatalog: a20(0x13), proofOfTime: a20(0x14), enclavePay: a20(0), verificationFees: a20(0), sessionVaultFactory: a20(0), secretVaultV2: a20(0) },
    profileDigest: null, rpcs: ["https://rpc-a.example/v1", "https://rpc-b.example"], quorum: 2, releaseId: "ab".repeat(32),
    replicas: { gateways: ["http://192.0.2.10:8189", "https://replica.example"], storagePlan: null },
    identity: { publicUrl: "https://host.example.org", repo: "owner/enclave", operator: a20(0x99) },
    selling: { cpuPrice6: 14, payout: null }, isolation: { managerUrl: "http://10.0.2.2:8095", dataAddr: "10.0.2.2:8096" }, hostAdmissionSha256: null, controlPort: 8444 };
  const cfg = MC.canonicalDirectConfig({ ...RAW, leaseGas: wire });
  assert.deepEqual(cfg.leaseGas.pinnedRelays, wire.pinnedRelays, "bound as written");
  const other = MC.canonicalDirectConfig({ ...RAW, leaseGas: { ...wire, pinnedRelays: [checked({ ...LINUX, origin: "http://10.0.2.2:8550" })] } });
  assert.notEqual(MC.configDigest(other), MC.configDigest(cfg), "HOST_DATA binds the pinned origin");
  assert.notEqual(MC.configDigest(MC.canonicalDirectConfig({ ...RAW, leaseGas: { ...wire, pinnedRelays: [checked({ ...LINUX, payee: privateKeyToAccount(generatePrivateKey()).address })] } })), MC.configDigest(cfg), "and the payee");
  const directEnv = MC.directSupervisorEnv(cfg, { paths: { ...MC.GUEST_PATHS, leaseGasRecord: path.join(tmp, "direct.json") } });
  const lgDirect = Object.fromEntries(Object.entries(directEnv).filter(([k]) => LG.isLeaseGasName(k)));
  assert.deepEqual({ ...lgDirect, ENCLAVE_LEASE_GAS_FILE: "x" }, { ...legacy.env, ENCLAVE_LEASE_GAS_FILE: "x" }, "the same names and values on both paths");
  assert.deepEqual(MC.directEnvProblems(directEnv).filter((p) => /LEASE_GAS/.test(p)), []);
  // both reach the SAME validated factory input
  fs.writeFileSync(path.join(tmp, "legacy.json"), RECORD);
  const loaded = loadLeaseGasConfig({ env: legacy.env, ...BINDING });
  assert.deepEqual(loaded.pinnedRelays, [checked(LINUX)]); assert.deepEqual([...loaded.relays], []);
  // a bound member not in its checked form, or tampered, refuses (fail closed: configured, unloadable)
  for (const [bad, re] of [[{ ...wire, pinnedRelays: [{ ...wire.pinnedRelays[0], payee: PAYEE.toLowerCase() }] }, /checked form/],
    [{ ...wire, pinnedRelays: [{ origin: "http://warden.lan:8549", payee: PAYEE, operator: wire.pinnedRelays[0].operator }] }, /private IPv4 literal/],
    [{ ...wire, pinnedRelays: [] }, /1 to 4/], [{ ...wire, pinnedRelays: null }, /either a list or absent/], [{ ...wire, relays: [] , pinnedRelays: undefined }, /1 to 8/],
    [{ ...wire, relays: [wire.pinnedRelays[0].origin] }, /must be https/], [{ ...wire, pinnedRelays: [{ ...wire.pinnedRelays[0], extra: 1 }] }, /unknown field/]]) {
    const g = LG.leaseGasGuest(JSON.parse(JSON.stringify(bad)), { published: true });
    assert.equal(g.ok, false, JSON.stringify(bad.pinnedRelays)); assert.match(g.reason, re); assert.equal(g.env.ENCLAVE_LEASE_GAS_FILE, LG.REFUSED_RECORD_FILE);
  }
  // the host launcher refuses an invalid host form before QEMU (leaseGasTransit throws)
  for (const [h, re] of [[HOST({ pinnedRelays: [{ ...LINUX, origin: "http://127.0.0.1:8549" }] }), /private IPv4 literal/], [HOST({ pinnedRelays: [] }), /1 to 4/],
    [{ recordFile: RECORD_FILE, digest: DIGEST, rpcs: [...RPCS] }, /leaseGas\.relays is required/], [HOST({ pinnedRelays: [checked(LINUX), checked(LINUX)] }), /repeat an origin/]])
    assert.throws(() => LG.leaseGasTransit(h, { readFile: read }), re);
});

test("Windows: the read-only config check reports pinned relays exactly; --expect-pinned refuses anything else", () => {
  const cmd = path.join(tmp, "lease-gas-config.cmd");
  fs.writeFileSync(cmd, [`@set "ENCLAVE_LEASE_GAS_FILE=${RECORD_FILE}"`, `@set "ENCLAVE_LEASE_GAS_DIGEST=${DIGEST}"`, `@set "ENCLAVE_LEASE_GAS_RPCS=${RPCS.join(",")}"`,
    '@set "ENCLAVE_LEASE_GAS_LOCAL_RELAY=http://127.0.0.1:8549"', `@set "ENCLAVE_LEASE_GAS_PINNED_RELAYS=${WINDOWS.origin},${PAYEE},${OP}"`, ""].join("\r\n"));
  const run = (...extra) => { const r = spawnSync(process.execPath, [path.join(REPO, "windows/installer/lease-gas-config-check.mjs"), "--bundle", path.join(REPO, "windows/node/lease-gas-runtime.bundle.mjs"), "--config", cmd, ...extra], { encoding: "utf8", timeout: 60_000 });
    return { code: r.status, out: JSON.parse(r.stdout.trim().split("\n").at(-1)) }; };
  let r = run("--expect-local", "http://127.0.0.1:8549", "--expect-relays", "none", "--expect-pinned", `${WINDOWS.origin},${PAYEE},${OP}`);
  assert.equal(r.code, 0, JSON.stringify(r.out)); assert.deepEqual(r.out.pinnedRelays, [`${WINDOWS.origin},${PAYEE},${checked(WINDOWS).operator}`]);
  r = run("--expect-pinned", `http://192.168.8.250:8549,${PAYEE},${OP}`); assert.equal(r.code, 1); assert.match(r.out.error, /pinned relays/);
  r = run("--expect-pinned", "none"); assert.equal(r.code, 1);
});

test("what stays refused: service-index discovery still drops private endpoints (a remote ad can never name the host link)", () => {
  for (const e of ["http://10.0.2.2:8549/", "http://192.168.8.249:8549/", "http://172.16.0.1:8549/", "http://127.0.0.1:8549/"])
    assert.throws(() => si.validateEndpoint(e), /non-public IPv4/, e);
  assert.throws(() => si.validateAdInput({ slot: 0, kind: "relay", endpoints: ["http://10.0.2.2:8549/"], ttlSec: 86400 }), /non-public IPv4/);
});

test("who admits a relay ROLE: the platform host policy gate, keyed by the host's registered endpoint - never the host ownership extension", () => {
  const gate = fs.readFileSync(path.join(REPO, "network/host-service-gate.mjs"), "utf8"), role = fs.readFileSync(path.join(REPO, "network/host-services/lease-relay-host.mjs"), "utf8");
  for (const [name, src] of [["host-service-gate.mjs", gate], ["lease-relay-host.mjs", role]])
    assert.doesNotMatch(src, /hostOwnership|ownershipContract|pendingOwner|HostOwnership/, `${name} consults no host ownership`);
  assert.match(role, /createHostServiceGate\(\{ env: policyEnv\(view\), chainId: 8453, endpoint: cfg\.host\.endpoint/);
  assert.equal(hostIdOfEndpoint("https://api.enclave.host/t/metal0"), "0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be", "metal0's registry id");
  // the compute host's side: a pinned relay's operator is judged by the same platform-policy admission as a discovered one
  const client = fs.readFileSync(path.join(REPO, "client/lease-executor-client.mjs"), "utf8");
  assert.match(client, /const admit = isPinned \? admitPinnedRelay : admitDiscoveredRelay;/);
  assert.doesNotMatch(client.slice(client.indexOf("export function validatePinnedRelay")), /ownership/i);
});
