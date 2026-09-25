// The Windows manager's half of the shared contract, tested without a partition - which is the
// point: everything except the launch is finished, and a launch that cannot happen must fail
// closed and say why rather than degrade into something that looks like success.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Manager, policyFor, refuseUnsupported, POLICY_RULE } from "./server.mjs";
import { HyperVPartitionBackend, BACKEND } from "./backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;
const RT = REC.runtimeId;

const mk = (over = {}) => new Manager({ runtimeId: RT, fetchComponent: async () => component, ...over });
const DEP = "0x" + "e6".repeat(32);
// the body the node client actually sends: guestd's contract, name included
const spawnBody = (over = {}) => ({ derive: REC, name: DEP, isPublic: true, hasSecrets: false, ...over });

test("/health states the backend, refuses everything it cannot honour, and admits it cannot start", () => {
  const h = mk().health();
  assert.equal(h.backend, BACKEND);
  assert.equal(h.backend, "hyperv-partition-per-app", "the name agreed with the SNP lane");
  for (const k of ["gpu", "secrets", "egress", "config", "ports", "configCid"])
    assert.equal(h.supports[k], false, `supports.${k} must be false`);
  assert.deepEqual(h.catalog.derivations, ["enclave-catalog-bundle/1"],
                   "the GATE list: only what this backend can actually serve");
  assert.deepEqual(h.catalog.derives, ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2"],
                   "what it can COMPUTE is separate information, and /2 is byte-exact here");
  assert.equal(h.runtime.v2SocketServer, false, "deriving /2 is not serving it, and health says which");
  assert.equal(h.catalog.runtimeId, RT);
  assert.equal(h.policyRule, POLICY_RULE);
  assert.equal(h.canStart, false, "no launch path on this host, and it says so");
  assert.match(h.cannotStart.supportedPath, /Msvm_VirtualSystemSettingData\.FirmwareFile/);
});

test("the pinned policy is the version's memMb with a floor, one vcpu, the whole core", () => {
  assert.deepEqual(policyFor({ memMb: 512 }), { vcpus: 1, memMiB: 512, cpuPercent: 100 });
  assert.deepEqual(policyFor({ memMb: 64 }), { vcpus: 1, memMiB: 128, cpuPercent: 100 }, "floor 128");
  assert.throws(() => policyFor({}), /no memMb/, "a missing declaration is refused, never defaulted");
});

test("a spawn derives the contract's AppID, and it is the shared one", async () => {
  const r = await mk().spawn(spawnBody());
  assert.equal(r.appId, v.ok[0].mapping.appId, "the same AppID Go and Python derive");
  assert.equal(r.recordSha256, v.ok[0].mapping.recordSha256);
  assert.equal(r.policy.vcpus, 1);
});

test("a domain that did not start is failed, says why, and carries NO attestation", async () => {
  const r = await mk().spawn(spawnBody());
  assert.equal(r.status, "failed");
  assert.match(r.reason, /custom IGVM|Hyper-V role|IgvmFilePath/);
  assert.equal("attestation" in r, false, "no evidence is invented for a domain that never ran");
  assert.ok(r.prerequisites, "and the prerequisite is named rather than guessed at");
  assert.equal(r.status === "running", false);
});

test("the seam works when a host can launch, and a booted guest is not a running app", async () => {
  const booted = new HyperVPartitionBackend({ launch: async () => ({ pid: 4242, appReady: false, guest: { booted: true, bytes: 9, head: "hi" }, stop: async () => {} }) });
  const r = await mk({ backend: booted }).spawn(spawnBody());
  assert.equal(r.status, "starting", "console output is not evidence the app is serving, and 'starting' is a word the supervisor knows");
  assert.equal(r.appReady, false);
  // With no readiness rule wired, the record now says so outright rather than leaving a
  // placeholder: a manager that can never promote anything must not read as merely "not yet".
  assert.match(r.reason, /no readiness rule|readiness has not been judged yet/);
  assert.equal("attestation" in r, false, "still none: booted is not attested either");
  // and when a backend CAN prove the app is up, the word is earned
  const ready = new HyperVPartitionBackend({ launch: async () => ({ pid: 1, appReady: true, guest: { booted: true, bytes: 9 }, stop: async () => {} }) });
  const r2 = await mk({ backend: ready }).spawn(spawnBody());
  assert.equal(r2.status, "running");
});

test("everything this backend cannot honour is refused again on this side of the wire", async () => {
  const cases = [
    [{ gpuMilli: 10 }, /GPU/], [{ config: "{}" }, /app config/], [{ appConfigCid: "bafy" }, /app config/],
    [{ hasSecrets: true }, /staged secrets/], [{ hasSecrets: undefined }, /unverified secret state/],
    [{ firewall: ["tcp:22"] }, /declared ports/], [{ volumes: ["m"] }, /model volumes/],
    [{ isPublic: false }, /private deployment/], [{ waf: { rate: 1 } }, /protection rules/],
  ];
  for (const [over, re] of cases) {
    const body = spawnBody(over);
    if ("hasSecrets" in over && over.hasSecrets === undefined) delete body.hasSecrets;
    await assert.rejects(() => mk().spawn(body), re, JSON.stringify(over));
  }
});

test("a mapping pinned to another runtime, or another derivation, is refused", async () => {
  await assert.rejects(() => mk().spawn(spawnBody({ derive: { ...REC, runtimeId: "aa".repeat(32) } })), /pinned to runtime/);
  // /2 is a KNOWN rule now, so an unknown one has to be a genuinely unknown one
  await assert.rejects(() => mk().spawn(spawnBody({ derive: { ...REC, derivation: "enclave-catalog-bundle/9" } })), /unknown derivation/);
});

test("the lifecycle is readable: list, get, delete", async () => {
  const m = mk();
  const r = await m.spawn(spawnBody({ id: "d1" }));
  assert.equal(m.list().length, 1);
  assert.equal(m.get("d1").appId, r.appId);
  assert.deepEqual(await m.remove("d1"), { removed: true, absent: false });
  assert.equal(m.get("d1"), null);
  assert.deepEqual(await m.remove("d1"), { removed: false, absent: true });
});

test("the backend takes the REAL launcher, and a domain started through it is running", async () => {
  const { WmiHyperVLauncher } = await import("./wmi-launcher.mjs");
  const { TYPE1, PREFLIGHT_OK, defineAnswer, keyOf } = await import("./fake-hyperv.mjs");
  const SHA = "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3";
  // the type-1 definition (New-CustomVM), answered the way a compliant host reads it back
  const answer = (script) => ({ preflight: PREFLIGHT_OK, imageHash: { present: true, sha256: SHA, bytes: 124962164 },
    define: defineAnswer(script), start: { state: "Running" },
    readConsole: { connected: true, bytes: 42, head: "guest output" }, survey: { vms: [] } })[keyOf(script)] ?? { ok: true };
  const launcher = new WmiHyperVLauncher({
    run: async (s) => ({ code: 0, stdout: JSON.stringify(answer(s)), stderr: "" }),
    imagePath: "C:\\img.bin", imageSha256: SHA, prefix: "enclave-app-t-", ...TYPE1 });
  const backend = new HyperVPartitionBackend({ launcher });
  const m = mk({ backend });
  await assert.rejects(m.spawn(spawnBody()), (e) => e.status === 503, "a manager that can launch answers nothing before it has surveyed Hyper-V");
  assert.equal((await m.recover()).state, "ready");
  const r = await m.spawn(spawnBody());
  assert.equal(r.status, "starting", "the guest booted; no app-readiness handshake exists, so not \"running\"");
  assert.equal(r.appReady, false);
  assert.equal("attestation" in r, false, "a VM that started is still not an attested one");
  const pre = await backend.preflight();
  assert.equal(pre.ok, true, "and the backend can ask the host what it has");
});

test("a /2 app is REFUSED rather than approximated, even though its AppID is right", async () => {
  const { DERIVATION_V2, derive } = await import("./derive.mjs");
  const rec2 = { ...REC, derivation: DERIVATION_V2, http: 8000 };
  // the identity is correct here - that is the point of implementing the rule at all
  assert.equal(derive({ record: rec2, component }).appId.length, 64);
  // and the manager still will not take it, because serving one needs a runtime it does not have
  await assert.rejects(() => mk().spawn(spawnBody({ derive: rec2 })),
                       /derives enclave-catalog-bundle\/2 but cannot serve it yet/);
});

test("a rule we cannot serve is absent from the gate list, not merely refused later", () => {
  const h = mk().health();
  assert.equal(h.catalog.derivations.includes("enclave-catalog-bundle/2"), false,
    "listing it would pass the claim gate: the node takes the lease ON CHAIN, then this process "
    + "refuses, and the deployment churns through claim, fail and release while a box that can "
    + "serve it sits free. Silence is the refusal the gate understands.");
  assert.equal(h.catalog.derives.includes("enclave-catalog-bundle/2"), true,
    "but the capability is still reported, so nobody has to guess whether the identity would match");
});

/** A backend whose guest boots but has no readiness handshake: the ordinary case on this tier. */
const bootedBackend = () => new HyperVPartitionBackend({
  launch: async () => ({ pid: 4242, appReady: false, guest: { booted: true, bytes: 9, head: "hi" }, stop: async () => {} }),
});

/* ---- defects 4, 5 and 6, and guestd's vocabulary ---------------------------------------------- *
 * All found by enclave-99 by reading the sources against supervisor.js and isolation/m4/guestd. */

test("defect 6: a second spawn for a live deployment is a 409 naming the instance to adopt", async () => {
  const m = mk({ backend: bootedBackend() });
  const first = await m.spawn(spawnBody());
  const e = await m.spawn(spawnBody()).then(() => null, (x) => x);
  assert.ok(e, "a live name must not be silently overwritten");
  assert.equal(e.status, 409);
  assert.equal(e.id, first.id, "the 409 names WHICH instance to adopt, or the caller cannot adopt it");
  assert.equal(m.list().length, 1, "and the first handle is not forgotten");
});

test("defect 6: an explicit duplicate id is a 409 too, never an overwrite", async () => {
  const m = mk({ backend: bootedBackend() });
  await m.spawn(spawnBody({ id: "hvdeadbeef" }));
  const e = await m.spawn(spawnBody({ id: "hvdeadbeef", name: "0x" + "ff".repeat(32) })).then(() => null, (x) => x);
  assert.equal(e && e.status, 409);
  assert.equal(m.list().length, 1);
});

test("ids are the manager's own shape, and the record names the deployment", async () => {
  const r = await mk({ backend: bootedBackend() }).spawn(spawnBody());
  assert.match(r.id, /^hv[0-9a-f]{32}$/, "hv + 128 bits, minted here (63's P4); the isolated route validator accepts [A-Za-z0-9-]{1,64}");
  assert.equal(r.name, DEP, "adoption after a restart matches on name");
});

test("defect 4: the record carries what the data plane needs to route, and the boundary word", async () => {
  const withRoute = { supports: {}, backend: "hv", boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
    start: async () => ({ name: "vm", state: "Running", guest: { booted: true, bytes: 12, head: "MON" },
                          appReady: false, boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
                          domainId: 1, guestPort: 40001, tcpPort: 19101, image: "ab".repeat(32) }) };
  const r = await mk({ backend: withRoute }).spawn(spawnBody());
  assert.deepEqual(r.relay, { host: "127.0.0.1", port: 19101 }, "without a relay port nothing can be routed");
  assert.equal(r.domainId, 1);
  assert.equal(r.guestPort, 40001);
  assert.equal(r.image, "ab".repeat(32), "the splice admits on image + transportKeySha256");
  assert.equal(r.boundary.hostExcluded, false, "carried verbatim: this is the word that must never be lost");
  // and /health must carry it too, read through the SAME accessor the real backends expose
  assert.equal(mk({ backend: withRoute }).health().boundary.hostExcluded, false);
  assert.equal(r.hostExcluded, false);
  assert.equal(r.tier, "t0-hv");
});

test("defect 5: a stop that FAILED is not a removal, and the domain stays listed", async () => {
  const stubborn = { supports: {}, backend: "hv",
    start: async () => ({ name: "vm", state: "Running", guest: { booted: true, bytes: 9 }, appReady: false }),
    stop: async () => { throw new Error("stop_failed"); } };
  const m = mk({ backend: stubborn });
  const r = await m.spawn(spawnBody());
  const e = await m.remove(r.id).then(() => null, (x) => x);
  assert.ok(e, "remove must not answer ok when the domain may still be running");
  assert.match(e.message, /may still be RUNNING/);
  assert.equal(m.list().length, 1, "an orphan the manager stopped listing is one nobody can find");
  assert.equal(m.get(r.id).status, "failed");
});


test("the boundary is read through the accessor the real backends actually expose", async () => {
  // enclave-99 caught this: server.mjs read `backend.BOUNDARY`, the MODULE constant, while
  // backend-hcs exposes `get boundary()`. Both came out null against the real backend, so the
  // record's tier and hostExcluded silently fell back to defaults - the exact loss defect 4 was
  // supposed to fix - and my own test passed because its fake set BOUNDARY as a property. A fake
  // shaped like the code under test rather than like the real collaborator proves nothing.
  const { HcsPartitionBackend } = await import("./backend-hcs.mjs");
  const real = new HcsPartitionBackend({ exe: "C:/nonexistent.exe", kernel: "k", initrd: "i", out: "o" });
  assert.ok(real.boundary, "the real backend exposes `boundary`");
  assert.equal(real.boundary.hostExcluded, false);
  assert.equal(real.BOUNDARY, undefined, "and NOT `BOUNDARY`: reading that gives null forever");
  const h = mk({ backend: real }).health();
  assert.ok(h.boundary, "so /health must carry it");
  assert.equal(h.boundary.hostExcluded, false);
  assert.equal(h.boundary.partition, "hcs-child");
});

/* ---- over the WIRE, because a seam defect cannot be seen from either side ---------------------- *
 *
 * enclave-99 measured this against a running manager: Manager.spawn sets e.id on a 409 and
 * IsolationManagerClient.spawn reads it, but createServer's catch dropped it, so both halves were
 * written for an adoption that could never happen over HTTP. Every test that called manager.spawn()
 * directly passed. This one goes through the server. */
import { createServer } from "./server.mjs";
import { IsolationManagerClient } from "../../node/isolation-client.mjs";

const listenOn = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

test("a 409 carries the id over the wire, so the node client can adopt", async () => {
  const m = mk({ backend: bootedBackend() });
  const srv = createServer(m);
  const port = await listenOn(srv);
  try {
    const client = new IsolationManagerClient({ base: `http://127.0.0.1:${port}` });
    const body = IsolationManagerClient.spawnBody({
      image: "ipfs://x", name: DEP, derive: REC, isPublic: true, hasSecrets: false, appPort: 8080 });
    const first = await client.spawn(body);
    assert.equal(first.adopted, false);
    assert.match(first.view.id, /^hv[0-9a-f]{32}$/);
    assert.equal(first.view.status, "starting");
    // the same deployment again: the client must ADOPT, which needs the id in the 409 body
    const second = await client.spawn(body);
    assert.equal(second.adopted, true, "without id on the wire this throws 'named no instance to adopt'");
    assert.equal(second.view.id, first.view.id);
    assert.equal(second.view.name, DEP);
  } finally { srv.close(); }
});

test("POST /vms answers 201, and /health carries the boundary, over the wire", async () => {
  const m = mk({ backend: bootedBackend() });
  const srv = createServer(m);
  const port = await listenOn(srv);
  try {
    const body = IsolationManagerClient.spawnBody({
      image: "ipfs://x", name: DEP, derive: REC, isPublic: true, hasSecrets: false, appPort: 8080 });
    const res = await fetch(`http://127.0.0.1:${port}/vms`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 201, "guestd answers 201 and the supervisor checks for it");
    const rec = await res.json();
    assert.equal(rec.status, "starting");
    assert.equal(rec.name, DEP);
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.ok("boundary" in h, "a reader must be able to learn what this manager's isolation IS");
  } finally { srv.close(); }
});

/* ---- readiness reaches the record: `running` and the key it was reached on ------------------- *
 *
 * The gap 5d's datapath and enclave-99's record-to-route case both name: every record carried
 * transportKeySha256: null, so a route could never be admitted. judgeRunning produced the value
 * and nothing called it. These drive the injected rule. */

const relayBackend = () => ({ supports: {}, backend: "hv",
  boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
  start: async () => ({ name: "vm", state: "Running", guest: { booted: true, bytes: 9 }, appReady: false,
                        boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
                        domainId: 1, guestPort: 40001, tcpPort: 19101, image: "ab".repeat(32),
                        launcherKey: "LKEY" }),
  stop: async () => {} });

test("a domain that passes the rule becomes running AND carries the verified key", async () => {
  const KEY = "cd".repeat(32);
  const seen = [];
  const m = mk({ backend: relayBackend(),
    judgeReady: async (a) => { seen.push(a); return { status: "running", transportKeySha256: KEY,
      checks: { document: { ok: true, verdict: "monitor-signed" }, ready: { ok: true } } }; } });
  const r = await m.spawn(spawnBody());
  assert.equal(r.status, "starting", "spawn answers at once; readiness is judged behind it");
  await m.judging.get(r.id);
  const after = m.get(r.id);
  assert.equal(after.status, "running");
  assert.equal(after.transportKeySha256, KEY, "the route is admitted on exactly this");
  assert.equal(after.verdict, "monitor-signed", "and never anything stronger: no chain is verified here");
  assert.equal(after.hostExcluded, false, "still not host-excluded, however ready it is");
  // the rule was asked about the right domain, on the relay port, with the launcher's key
  assert.equal(seen[0].port, 19101);
  assert.equal(seen[0].appId, after.appId);
  assert.equal(seen[0].launcherKey, "LKEY");
});

test("a domain that fails the rule is failed, and never running without the key", async () => {
  const m = mk({ backend: relayBackend(),
    judgeReady: async () => ({ status: "failed", reason: "the document was not accepted", transportKeySha256: null,
                               checks: { document: { ok: false, verdict: "unsigned" } } }) });
  const r = await m.spawn(spawnBody());
  await m.judging.get(r.id);
  const after = m.get(r.id);
  assert.equal(after.status, "failed");
  assert.equal(after.transportKeySha256, null);
  assert.match(after.reason, /not accepted/);
});

test("a backend with no relay port cannot be judged, and says so instead of claiming running", async () => {
  const noRelay = { ...relayBackend(),
    start: async () => ({ name: "vm", state: "Running", guest: { booted: true }, appReady: false }) };
  const m = mk({ backend: noRelay, judgeReady: async () => ({ status: "running", transportKeySha256: "x" }) });
  const r = await m.spawn(spawnBody());
  await m.judging.get(r.id);
  const after = m.get(r.id);
  assert.equal(after.status, "starting", "no port, no verdict: it must not become running");
  assert.equal(after.transportKeySha256, null);
  assert.match(after.reason, /no relay port/);
});

test("a rule that throws fails the domain rather than leaving it starting forever", async () => {
  const m = mk({ backend: relayBackend(), judgeReady: async () => { throw new Error("boom"); } });
  const r = await m.spawn(spawnBody());
  await m.judging.get(r.id);
  assert.equal(m.get(r.id).status, "failed");
  assert.match(m.get(r.id).reason, /could not be judged: boom/);
});

test("with NO rule wired the record stays starting and never invents a key", async () => {
  const m = mk({ backend: relayBackend() });          // judgeReady null
  const r = await m.spawn(spawnBody());
  assert.equal(r.status, "starting");
  assert.equal(r.transportKeySha256, null, "a manager that cannot judge must not produce a routable record");
});

/* ---- defect 11: expectRuntime is an IDENTITY, not a hash --------------------------------------- *
 *
 * enclave-99, measured through the real join: judge-hv hands expectRuntime to the shared
 * checkRuntime as `want.runtime`, which DIFFS IT FIELD BY FIELD against the identity the document
 * states. Passing rec.runtimeId - a 64-hex hash with none of those fields - made every real
 * document "differ in name, version, execution, targetIsa, hostIsa, cpuFeatures, wx, cache", so a
 * manager with a rule wired could never say running. Both halves correct; the join carried the
 * wrong kind of thing. */
import { runtimeId as contractRuntimeId } from "../../../isolation/contract/runtime.mjs";

const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64",
                  hostIsa: "x86_64", cpuFeatures: "baseline", wx: "enforced", cache: "none" };

test("the rule is given the runtime IDENTITY, and the id is derived from it", async () => {
  let got = null;
  const m = new Manager({ backend: relayBackend(), fetchComponent: async () => component,
    runtime: RUNTIME,
    judgeReady: async (a) => { got = a; return { status: "running", transportKeySha256: "ee".repeat(32),
      checks: { document: { ok: true, verdict: "monitor-signed" } } }; } });
  const expected = Buffer.from(contractRuntimeId(RUNTIME)).toString("hex");
  assert.equal(m.runtimeId, expected, "the hash is DERIVED from the identity, not configured beside it");
  const r = await m.spawn({ derive: { ...REC, runtimeId: expected }, name: DEP, isPublic: true, hasSecrets: false });
  await m.judging.get(r.id);
  assert.ok(got, "the rule was called");
  assert.deepEqual(got.expectRuntime, RUNTIME,
    "checkRuntime diffs this field by field: a hash here rejects every real document");
  assert.notEqual(typeof got.expectRuntime, "string", "never the hash");
  assert.equal(m.get(r.id).status, "running");
});

test("with no runtime identity configured, nothing is asserted about the runtime", async () => {
  let got = null;
  const m = mk({ backend: relayBackend(),
    judgeReady: async (a) => { got = a; return { status: "running", transportKeySha256: "ff".repeat(32) }; } });
  const r = await m.spawn(spawnBody());
  await m.judging.get(r.id);
  assert.equal(got.expectRuntime, undefined,
    "undefined means ABI/1 is judged as before; a hash would have been a guaranteed rejection");
});

/* ---- onReclaim: a stop that does not stop the traffic is not a stop ------------------------- *
 *
 * enclave-5d found this by grepping the whole tree: main.mjs SET manager.onReclaim to the data
 * plane's closeInstance, and server.mjs never CALLED it - the identifier appeared only at the three
 * lines that assign it. So a removed domain's established sessions were never closed and kept
 * carrying traffic to something that no longer existed. Both of their local runs showed the data
 * plane counting closed:reclaimed 0; the old session ended only because their KVM relay happened to
 * close when the monitor destroyed the domain. */

test("removing a domain tells the data plane to close its sessions", async () => {
  const seen = [];
  const m = mk({ backend: bootedBackend() });
  m.onReclaim = (id, why) => seen.push({ id, why });
  const r = await m.spawn(spawnBody());
  assert.deepEqual(seen, [], "nothing is reclaimed while it is serving");
  await m.remove(r.id);
  assert.equal(seen.length, 1, "a removed domain must be reclaimed, or its sessions outlive it");
  assert.equal(seen[0].id, r.id);
});

test("a stop that FAILED does not reclaim: the domain may still be serving", async () => {
  const seen = [];
  const stubborn = { supports: {}, backend: "hv",
    start: async () => ({ name: "vm", state: "Running", guest: { booted: true }, appReady: false }),
    stop: async () => { throw new Error("stop_failed"); } };
  const m = mk({ backend: stubborn });
  m.onReclaim = (id, why) => seen.push({ id, why });
  const r = await m.spawn(spawnBody());
  await m.remove(r.id).catch(() => {});
  assert.deepEqual(seen, [], "closing sessions for a domain that is still running would cut live traffic");
});

test("a domain that fails readiness is reclaimed too", async () => {
  const seen = [];
  const m = mk({ backend: relayBackend(),
    judgeReady: async () => ({ status: "failed", reason: "document rejected", transportKeySha256: null }) });
  m.onReclaim = (id, why) => seen.push({ id, why });
  const r = await m.spawn(spawnBody());
  await m.judging.get(r.id);
  assert.equal(seen.length, 1, "a domain that never became ready must not keep serving sessions");
  assert.match(seen[0].why, /readiness/);
});

test("an onReclaim that throws does not break the removal", async () => {
  const m = mk({ backend: bootedBackend() });
  m.onReclaim = () => { throw new Error("data plane is down"); };
  const r = await m.spawn(spawnBody());
  assert.deepEqual(await m.remove(r.id), { removed: true, absent: false }, "the domain is gone either way");
});

// The launcher's (partition, guestImageKind) statement travels to the readiness rule WITH the image, so judge-hv
// compares the pair before the image (enclave-d1 + enclave-99, main ae6e9147); a record with no statement (the HCS lab)
// passes neither, and its image is not compared.
test("a linux-direct domain is judged on its (partition, kind) statement AND its image; the HCS lab's on neither", async () => {
  const IGVM = "7c".repeat(32);
  const ld = { tier: "t0-hv", partition: "wmi-openhcl-gen2-igvm-linux", hostExcluded: false, attested: false };
  const wmi = { supports: {}, backend: "hv", boundary: ld,
    start: async () => ({ name: "vm", state: "Running", guest: { booted: true, bytes: 9 }, appReady: false, boundary: ld,
                          domainId: 1, guestPort: 40001, tcpPort: 19102, image: IGVM, launcherKey: "LKEY",
                          guestIdentity: { partition: ld.partition, guestImageKind: "igvm-linux-direct", igvmSha256: IGVM, igvmPath: "x" } }),
    stop: async () => {} };
  for (const [backend, expectPair] of [[wmi, true], [relayBackend(), false]]) {
    const seen = [];
    const m = mk({ backend, judgeReady: async (a) => { seen.push(a); return { status: "running", transportKeySha256: "cd".repeat(32),
      checks: { document: { ok: true, verdict: "monitor-signed" }, ready: { ok: true } } }; } });
    const r = await m.spawn(spawnBody());
    await m.judging.get(r.id);
    if (expectPair) {
      assert.deepEqual(seen[0].expectedStatement, { partition: ld.partition, guestImageKind: "igvm-linux-direct" });
      assert.equal(seen[0].expectedImageSha256, IGVM);
      assert.deepEqual(m.get(r.id).guestIdentity, { partition: ld.partition, guestImageKind: "igvm-linux-direct" }, "the view states the pair");
    } else {
      assert.equal(seen[0].expectedStatement, undefined); assert.equal(seen[0].expectedImageSha256, undefined);
    }
  }
});
