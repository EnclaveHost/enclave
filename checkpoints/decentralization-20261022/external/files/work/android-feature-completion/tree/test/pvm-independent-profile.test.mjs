// Independent pVM hosting: the owner's profile, the hash-bound verifier inputs from several sources, and the configs it
// derives (shielded/anchor/avf/runner/independent.mjs). FIXTURES only (see test/helpers/pvm-independent-world.mjs); every
// network call in this file goes through a guard that refuses enclave.host.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { keccak256, stringToBytes } from "viem";
import { checkIndependentProfile, loadVerifierInputs, verifierInputsBytes, checkVerifierInputs, independentHostConfig, independentNetworkConfig,
         relaySecretsRefusal, leaseGasEnv, platformPolicyEnv, independentSources, learnHostInstance, INDEPENDENT_FORMAT } from "../shielded/anchor/avf/runner/independent.mjs";
import { checkHostConfig, HOST_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/host-agent.mjs";
import { enrollApps, locateIndependentProfile } from "../shielded/anchor/avf/runner/standalone.mjs";
import { createLocalPvmDevice } from "../shielded/anchor/avf/runner/pvm-device-local.mjs";
import { checkRunnerConfig, createRunnerAgent, RUNNER_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/runner-agent.mjs";
import { AGENT_CONFIG_FORMAT } from "../shielded/anchor/avf/runner/proof-agent.mjs";
import { verifyPvmAppEvidence } from "../relay/pvm-app-attest.mjs";
import { fixtureInputs, fixtureVm, serveStatic, networkGuard, tmpdir, haveOpenssl, sha } from "./helpers/pvm-independent-world.mjs";

const skip = !haveOpenssl && "no openssl";
const BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
const LEGACY = "https://api.enclave.host/t/pixel10-pvm-cpu";
const profile = (over = {}) => ({ format: INDEPENDENT_FORMAT, registeredEndpoint: "https://phone.example.org/pixel10", chain: { chainId: "8453", addressBook: BOOK,
  rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org"], quorum: 2 }, directories: ["https://dir-a.example.org", "https://dir-b.example.net"],
  gateways: ["https://gw-a.example.org", "https://gw-b.example.net"], verifierInputs: { sha256: "ab".repeat(32), sources: ["https://pins-a.example.org/pvm.json", "https://pins-b.example.net/pvm.json"] },
  platformPolicy: { mode: "production" }, leaseGas: { file: "/srv/lease-gas.json", digest: "cd".repeat(32), rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org"], relays: ["https://relay-a.example.org"] }, ...over });

test("profile: the owner names every authority and source; none of them may be required to be Enclave's", () => {
  const p = checkIndependentProfile(profile());
  assert.equal(p.enclaveId, keccak256(stringToBytes("https://phone.example.org/pixel10")), "the registry id is keccak256 of the registered endpoint");
  assert.deepEqual(p.capacity, { lifetimeSec: 300 });
  // an existing phone keeps its registration (and its ownership and earnings): the relay-route string is an identifier only
  assert.equal(checkIndependentProfile(profile({ registeredEndpoint: LEGACY, keepRegistration: true })).enclaveId, keccak256(stringToBytes(LEGACY)));
  const refuse = (over, re) => assert.throws(() => checkIndependentProfile(profile(over)), re);
  refuse({ registeredEndpoint: LEGACY }, /allowed only as the existing registration this phone keeps/);
  refuse({ directories: ["https://dir.example.org"] }, /directories: 2\.\.8 sources required/);
  refuse({ directories: ["https://a.enclave.host", "https://b.enclave.host"] }, /at least one source must not be Enclave's/);
  refuse({ gateways: ["https://ipfs.enclave.host", "https://ipfs.enclave.host"] }, /listed twice|must not be Enclave's/);
  refuse({ verifierInputs: { sha256: "ab".repeat(32), sources: ["https://api.enclave.host/pins.json", "https://pins.enclave.host/pins.json"] } }, /must not be Enclave's/);
  refuse({ chain: { chainId: "8453", addressBook: BOOK, rpcs: ["https://base.drpc.org"], quorum: 1 } }, /chain\.rpcs: 2\.\.8/);
  refuse({ chain: { chainId: "8453", addressBook: BOOK, rpcs: ["https://a.example.org", "https://b.example.org"], quorum: 1 } }, /quorum must be 2/);
  refuse({ platformPolicy: { mode: "off" } }, /never off/);
  refuse({ leaseGas: { file: "/srv/x", digest: "cd".repeat(32), rpcs: [], relays: [] } }, /leaseGas/);
  refuse({ directories: ["http://dir.example.org", "https://dir-b.example.net"] }, /must be https/);
  // an Enclave-operated mirror may be LISTED beside an independent one (explicit, never required)
  assert.deepEqual(checkIndependentProfile(profile({ gateways: ["https://ipfs.enclave.host", "http://192.0.2.10:8189"] })).gateways, ["https://ipfs.enclave.host", "http://192.0.2.10:8189"]);
  assert.throws(() => independentSources(["https://x.example.org/a?b"], "t", { min: 1 }), /bare origin/);
});

test("lease gas and platform policy settings: the shared runtimes' own settings, never 'off'", () => {
  const p = checkIndependentProfile(profile());
  assert.deepEqual(leaseGasEnv(p), { ENCLAVE_LEASE_GAS_FILE: "/srv/lease-gas.json", ENCLAVE_LEASE_GAS_DIGEST: "cd".repeat(32),
    ENCLAVE_LEASE_GAS_RPCS: "https://base-rpc.publicnode.com,https://base.drpc.org", ENCLAVE_LEASE_GAS_RELAYS: "https://relay-a.example.org" });
  assert.deepEqual(platformPolicyEnv(p), { ENCLAVE_PLATFORM_HOST_POLICY: "production" });
});

test("verifier inputs: bound to their exact sha256; a source serving other bytes is reported and not used; a verified copy survives a cold start", { skip }, async () => {
  const dir = tmpdir("pvm-ind-inputs-"), fx = fixtureInputs(dir);
  const tampered = Buffer.from(fx.bytes.toString("utf8").replace(fx.doc.codeHashes[0], "ee".repeat(32)));
  const a = await serveStatic({ "/pvm.json": tampered }), b = await serveStatic({ "/pvm.json": fx.bytes });
  const guard = networkGuard([new URL(a.origin).host, new URL(b.origin).host]);
  const cacheFile = path.join(dir, "agent", "verifier-inputs.json");
  try {
    const got = await loadVerifierInputs({ sha256: fx.sha256, sources: [a.url("/pvm.json"), b.url("/pvm.json")], fetch: guard.fetch, cacheFile });
    assert.deepEqual(got.doc, fx.doc);
    assert.equal(got.source, b.url("/pvm.json"));
    assert.match(got.report[0].why, /served other bytes/, "the tampered source is named");
    assert.equal(fs.readFileSync(cacheFile).toString("hex"), fx.bytes.toString("hex"), "the verified bytes are kept");
    // both sources down: the cached, re-verified copy (a cold start with the sources unreachable)
    a.close(); b.close();
    const cold = await loadVerifierInputs({ sha256: fx.sha256, sources: [a.url("/pvm.json"), b.url("/pvm.json")], fetch: guard.fetch, cacheFile });
    assert.equal(cold.source, "cache (verified copy)");
    // a tampered cache is never used
    fs.writeFileSync(cacheFile, tampered);
    await assert.rejects(loadVerifierInputs({ sha256: fx.sha256, sources: [a.url("/pvm.json")], fetch: guard.fetch, cacheFile }), /no source served the verifier inputs/);
    // another pinned digest refuses the right bytes
    const c = await serveStatic({ "/pvm.json": fx.bytes });
    await assert.rejects(loadVerifierInputs({ sha256: "00".repeat(32), sources: [c.url("/pvm.json")], fetch: networkGuard([new URL(c.origin).host]).fetch }), /served other bytes/);
    c.close();
    assert.deepEqual(guard.refused, [], "nothing outside the named sources was asked");
  } finally { a.close(); b.close(); }
  assert.throws(() => checkVerifierInputs({ ...fx.doc, tier: "pvm-gpu" }), /tier must be pvm-cpu/, "no GPU or TEE tier is invented for a phone");
  assert.throws(() => verifierInputsBytes({ ...fx.doc, extra: 1 }), /keys must be exactly/);
});

test("configs: the host serves only an APK build the inputs approve; no relayOrigin, no relay or Nan mirror in the network config", { skip }, () => {
  const dir = tmpdir("pvm-ind-cfg-"), fx = fixtureInputs(dir), p = checkIndependentProfile(profile());
  const files = path.join(dir, "files"), bundleDir = path.join(dir, "bundle"); fs.mkdirSync(bundleDir, { recursive: true }); fs.writeFileSync(path.join(bundleDir, "idle-app.wasm"), "\0asm");
  const build = { maxFeePerGasWei: "500000000", repo: "EnclaveHost/enclave", defaultPriceCpuPerSec6: "2", minWithdraw6: "1000000", dns: [{ address: "1.1.1.1:443", serverName: "cloudflare-dns.com", path: "/dns-query" }],
                  checkers: ["0x57144c9008cff0b3ed94f6e40964a321fbee848a"], relayOrigin: "https://api.enclave.host", rpc: ["https://mainnet.base.org"] };
  const args = { build, setup: {}, operator: "0x" + "11".repeat(20), codeHash: fx.doc.codeHashes[0], instanceIds: [], files, apk: "/data/app/base.apk", controlPort: 18190, bundleDir,
                 profile: p, inputs: fx.doc, poolMemMb: 4096, ports: { agent: 18187, attach: 18188, egress: 18189, router: 17780 } };
  const host = checkHostConfig(independentHostConfig(args));
  assert.equal(host.relayOrigin, null);
  assert.equal(host.endpoint, "https://phone.example.org/pixel10");
  assert.equal(host.enclaveId, p.enclaveId);
  assert.deepEqual(host.ipfs.gateways, p.gateways, "the owner's replicas, not build.json's");
  assert.deepEqual(host.evidence.rootPins, fx.doc.rootPins);
  assert.throws(() => independentHostConfig({ ...args, codeHash: "99".repeat(32) }), /not one the verifier inputs approve/);
  assert.throws(() => checkHostConfig({ ...independentHostConfig(args), relayOrigin: "https://api.enclave.host" }), /has no relayOrigin/);
  assert.throws(() => checkHostConfig({ ...independentHostConfig(args), independent: { endpoint: "http://x" } }), /independent must be exactly/);
  // the legacy config is unchanged
  const legacy = checkHostConfig({ ...independentHostConfig(args), independent: undefined, relayOrigin: "https://api.enclave.host" });
  assert.equal(legacy.endpoint, `https://api.enclave.host/t/${legacy.name}`);
  const net = independentNetworkConfig({ build, host, apps: [], files, lib: "/lib", bundleDir, codeHash: fx.doc.codeHashes[0], nodeBinary: "/node", profile: p, inputs: fx.doc, routerPort: 17780 });
  assert.equal(net.mirror, undefined, "no Nan DNS mirror");
  assert.equal(net.enclaveNetwork.relay, undefined, "no relay");
  assert.deepEqual(net.enclaveNetwork.directories, p.directories);
  assert.deepEqual(net.chain.rpc, p.chain.rpcs);
  assert.ok(!JSON.stringify(net).includes("enclave.host"), "nothing in the network config names enclave.host");
  assert.ok(!JSON.stringify(host).includes("enclave.host"), "nothing in the host config names enclave.host");
});

test("an app whose config takes secrets the relay would release is refused in independent mode, by reason", () => {
  assert.match(relaySecretsRefusal('{"apiKey":"$API_KEY"}'), /only the relay can release to a pVM today/);
  assert.match(relaySecretsRefusal('{"k":"${TOKEN}"}'), /secrets/);
  assert.equal(relaySecretsRefusal('{"price":"$$5"}'), null, "an escaped dollar is not a secret");
  assert.equal(relaySecretsRefusal('{"greeting":"hello"}'), null);
});

test("enrollment: an independent app enrolls once it serves (no relay certificate exists); the legacy rule still needs one", () => {
  const dir = tmpdir("pvm-ind-enroll-"), D = "0x" + "d1".repeat(32);
  const hostState = { slots: { 1: { id: D, phase: "serving", appRef: "catalog://0x" + "ab".repeat(32) + "/1", configCid: "", sha: "aa".repeat(32) } } };
  assert.equal(enrollApps({ hostState, apps: [], appsDir: dir, runtimeId: "d3".repeat(32) }).apps.length, 0, "legacy: no certificate, not enrolled");
  const r = enrollApps({ hostState, apps: [], appsDir: dir, runtimeId: "d3".repeat(32), requireCert: false });
  assert.equal(r.apps.length, 1); assert.equal(r.apps[0].deploymentId, D);
});

test("the device: an independent host VM is launched with the explicit `independent` extra and no relay", async () => {
  const dir = tmpdir("pvm-ind-dev-"), launches = [];
  const app = { launch: async (service, extras) => { launches.push({ service, extras }); }, procs: async () => [], kill: async () => {} };
  const dev = createLocalPvmDevice({ files: dir, control: {}, app, vmName: "pvmhost", relay: null, independent: true, name: "pixel10", agentPort: 18187, attachPort: 18188, slots: 2 });
  await dev.launch({ label: "idle-1" });
  const x = Object.fromEntries(launches[0].extras.map(([k, , v]) => [k, v]));
  assert.equal(x.independent, true); assert.equal(x.relay, undefined); assert.equal(x.app_tls, 2);
  assert.throws(() => createLocalPvmDevice({ files: dir, control: {}, app, vmName: "pvmhost", relay: "wss://api.enclave.host/v1/fleet-tunnel", independent: true, name: "p", agentPort: 1, attachPort: 2 }), /dials no relay/);
  assert.throws(() => createLocalPvmDevice({ files: dir, control: {}, app, vmName: "pvmhost", relay: null, name: "p", agentPort: 1, attachPort: 2 }), /relay must be/);
});

test("the runner: app-funded lease operations need their sender; independent lifecycle sends no heartbeat and revives nothing", async () => {
  const proof = { format: AGENT_CONFIG_FORMAT, chainId: "8453", addressBook: BOOK, deployment: "0x" + "11".repeat(32), endpoint: "https://phone.example.org/pixel10",
    operator: "0x" + "22".repeat(20), carrier: "http://127.0.0.1:17787/", maxFeePerGasWei: "2000000000",
    evidence: { appId: "aa".repeat(32), allowedRuntimeIds: ["bb".repeat(32)], allowedCodeHashes: ["cc".repeat(32)], allowedAuthorityHashes: ["dd".repeat(64)], rootPins: ["ee".repeat(32)], instanceIds: ["ff".repeat(32)] } };
  const c = checkRunnerConfig({ format: RUNNER_CONFIG_FORMAT, proof, lifecycle: { claim: true, heartbeat: false, reactivate: false, leaseGas: true } });
  assert.deepEqual([c.lifecycle.heartbeat, c.lifecycle.reactivate, c.lifecycle.leaseGas], [false, false, true]);
  assert.deepEqual([checkRunnerConfig({ format: RUNNER_CONFIG_FORMAT, proof, lifecycle: {} }).lifecycle.heartbeat], [true], "legacy default unchanged");
  assert.throws(() => checkRunnerConfig({ format: RUNNER_CONFIG_FORMAT, proof, lifecycle: { heartbeat: false, heartbeatSec: 900 } }), /no meaning/);
  await assert.rejects(createRunnerAgent({ config: { format: RUNNER_CONFIG_FORMAT, proof, lifecycle: { claim: true, leaseGas: true } }, publicClient: {}, account: {}, stateDir: tmpdir("r-") }),
    /needs the app-funded lease sender .* no operator-paid fallback/);
});

test("the host VM's instance is learned from a LOCAL attestation over our nonce, under the pinned inputs (no relay attach)", { skip }, async () => {
  const dir = tmpdir("pvm-ind-learn-"), fx = fixtureInputs(dir), vm = fixtureVm(dir, fx.ca), idleSha = sha(Buffer.from("\0asm idle"));
  const pins = { allowedCodeHashes: fx.doc.codeHashes, allowedAuthorityHashes: fx.doc.authorityHashes, allowedRuntimeIds: fx.doc.runtimeIds, rootPins: fx.doc.rootPins };
  let replay = null;
  const exchange = async (line) => { const n = line.split(" ")[1]; const doc = replay || vm.evidence(idleSha, n); return JSON.stringify(doc) + "\n"; };
  assert.equal(await learnHostInstance({ exchange, verify: verifyPvmAppEvidence, pins, idleSha }), vm.instanceId);
  // an answer to ANOTHER nonce (a replay of an earlier attestation) is refused
  replay = vm.evidence(idleSha, "77".repeat(32));
  await assert.rejects(learnHostInstance({ exchange, verify: verifyPvmAppEvidence, pins, idleSha }), /answers another nonce/);
  // another build (not in the inputs) is refused
  const other = fixtureVm(dir, fx.ca, { forge: "other-code" });
  await assert.rejects(learnHostInstance({ exchange: async (l) => JSON.stringify(other.evidence(idleSha, l.split(" ")[1])), verify: verifyPvmAppEvidence, pins, idleSha }), /refused/);
  // a chain rooted elsewhere (Google's roots instead of the fixture's) is refused: the fixture never passes as hardware
  replay = null;
  await assert.rejects(learnHostInstance({ exchange, verify: verifyPvmAppEvidence, pins: { ...pins, rootPins: undefined }, idleSha }), /refused/);
});

test("where the owner's choice comes from: the phone's files first, else the signed release's own assets; none = legacy", () => {
  const dir = tmpdir("pvm-ind-locate-"), files = path.join(dir, "files"), bundleDir = path.join(dir, "bundle");
  fs.mkdirSync(path.join(files, "agent"), { recursive: true }); fs.mkdirSync(bundleDir, { recursive: true });
  assert.equal(locateIndependentProfile({ files, bundleDir }), null, "no profile anywhere: legacy mode, exactly as before");
  fs.writeFileSync(path.join(bundleDir, "independent.json"), JSON.stringify(profile({ leaseGas: { ...profile().leaseGas, file: "lease-gas.json" } })));
  const r = locateIndependentProfile({ files, bundleDir });
  assert.equal(r.from, path.join(bundleDir, "independent.json"));
  assert.equal(r.raw.leaseGas.file, path.join(bundleDir, "lease-gas.json"), "the release's lease record, next to its profile");
  assert.equal(checkIndependentProfile(r.raw).leaseGas.file, path.join(bundleDir, "lease-gas.json"));
  fs.writeFileSync(path.join(files, "agent", "independent.json"), JSON.stringify(profile()));
  assert.equal(locateIndependentProfile({ files, bundleDir }).from, path.join(files, "agent", "independent.json"), "the phone's own file wins");
});
