// Per-app isolation claim gate (supervisor.js isolationClaimVerdict, parseDepOptions' `isolation` namespace,
// envelopeEditVerdict), driven through the ISOLATION_SELFTEST seam, same contract as INSTANCE_SELFTEST.
//
// What must hold (isolation/DEPLOYMENT-PATH.md, the scheduling row):
//   - with ISOLATION_BACKEND UNSET, nothing changes: every other envelope parses exactly as before, the list of
//     known namespaces is the same, and a deployment that REQUIRES isolation is refused with a message saying so;
//   - with it SET, the box takes only deployments that ask for it, only while its manager IS the per-app guest
//     manager, and refuses - never drops - every feature the guest cannot honour;
//   - an owner changing the requirement of a running deployment is surfaced, never swapped in silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supervisor.js");

async function seam(c, backend = "") {
  const { stdout } = await pexec(process.execPath, [SUPERVISOR], {
    env: { ...process.env, SECRET: "test-secret", ISOLATION_BACKEND: backend,
           ISOLATION_SELFTEST: JSON.stringify(c),
           INSTANCE_SELFTEST: "", POOL_SELFTEST: "", SWEEP_SELFTEST: "", REACH_SELFTEST: "", ACME_SELFTEST: "",
           CFG_EDIT_SELFTEST: "", ADDRESS_BOOK_ADDRESS: "", REGISTRY_ENABLED: "", CLAIM_ENABLED: "",
           ACME_EAB_KID: "", ACME_EAB_HMAC: "", APP_CERT_DOMAIN: "", DNS_API: "" } });
  const lines = stdout.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

const TIER = "snp-guest-per-app";
const REQ = JSON.stringify({ isolation: { require: TIER } });
const GUESTD = { backend: TIER, supports: { gpu: false, secrets: false, egress: false, config: false, ports: false } };
const clean = { require: TIER, manager: GUESTD, gpuMilli: 0, config: "", appConfigCid: "", hasSecrets: false,
                firewall: [], volumes: [], isPublic: true, waf: null };

test("flag UNSET: a deployment that requires isolation is refused, and saying so", async () => {
  const r = await seam({ parse: [REQ] });
  assert.equal(r.parse[0].ok, false);
  assert.match(r.parse[0].error, /requires per-app hardware isolation .* which this runner does not provide/);
});

test("flag UNSET: every other envelope parses exactly as before", async () => {
  const r = await seam({ parse: ['{"waf":{"blockScanners":true}}', '{"nope":{}}', "", '{"gpu":{"optional":false}}'] });
  assert.equal(r.parse[0].ok, true);
  // the unknown-namespace message lists exactly the namespaces it always did
  assert.equal(r.parse[1].error, 'unknown option namespace "nope" (this runner knows: waf, config, configCid, gpu, network)');
  assert.deepEqual(r.parse[2], { ok: true, opts: {} });
  assert.equal(r.parse[3].ok, true);
});

test("flag UNSET: the verdict never refuses on its own", async () => {
  const r = await seam({ verdicts: [clean, { ...clean, require: undefined }, { ...clean, manager: null }] });
  assert.deepEqual(r.verdicts, [null, null, null]);
});

test("flag SET: the namespace parses, strictly", async () => {
  const r = await seam({ parse: [REQ, '{"isolation":[]}', '{"isolation":{"require":"vbs"}}',
                                 '{"isolation":{"require":"snp-guest-per-app","x":1}}', '{"nope":{}}'] }, TIER);
  assert.deepEqual(r.parse[0], { ok: true, opts: { isolation: TIER } });
  assert.match(r.parse[1].error, /must be a JSON object/);
  assert.match(r.parse[2].error, /isolation.require must be one of: snp-guest-per-app, hyperv-partition-per-app/);
  assert.match(r.parse[3].error, /unknown isolation option "x"/);
  assert.match(r.parse[4].error, /this runner knows: waf, config, configCid, gpu, network, isolation/);
});

test("flag SET: a clean isolated deployment is claimable, and only while the manager IS guestd", async () => {
  const r = await seam({ verdicts: [clean, { ...clean, manager: null },
                                    { ...clean, manager: { backend: undefined, gpuVramGb: 0 } }] }, TIER);
  assert.equal(r.verdicts[0], null);
  assert.match(r.verdicts[1], /is not the snp-guest-per-app manager .* unreachable/);
  // the in-CVM wasm-manager answers /health with no backend field: it must NOT pass for guestd
  assert.match(r.verdicts[2], /is not the snp-guest-per-app manager .* backend=null/);
});

test("flag SET: the box takes nothing that does not ask for it", async () => {
  const r = await seam({ verdicts: [{ ...clean, require: undefined }] }, TIER);
  assert.match(r.verdicts[0], /serves only deployments that require per-app isolation/);
});

test("flag SET: every feature the guest cannot honour is REFUSED", async () => {
  const cases = [
    [{ gpuMilli: 250 }, /GPU share/],
    [{ config: '{"k":1}' }, /app config/],
    [{ appConfigCid: "bafyexample" }, /app config/],
    [{ hasSecrets: true }, /staged secrets, and they would cross this host in plaintext/],
    [{ hasSecrets: null }, /cannot verify the deployment has no staged secrets/],
    [{ firewall: ["tcp:5432"] }, /ports \(tcp:5432\)/],
    [{ volumes: ["gemma"] }, /model volumes/],
    // enforced on the plaintext everywhere else; on this backend the plaintext exists only in the guest
    [{ isPublic: false }, /private, and its owner gate needs the request's plaintext/],
    [{ isPublic: undefined }, /private/],
    [{ waf: { blockScanners: true } }, /protection rules \(waf\)/],
  ];
  const r = await seam({ verdicts: cases.map(([over]) => ({ ...clean, ...over })) }, TIER);
  cases.forEach(([over, re], i) => assert.match(String(r.verdicts[i]), re, JSON.stringify(over)));
});

test("an unknown ISOLATION_BACKEND takes no tenant work", async () => {
  // the envelope itself is well-formed; what a misconfigured box must not do is CLAIM it
  const r = await seam({ verdicts: [clean, { ...clean, require: undefined }] }, "vbs-someday");
  assert.match(r.verdicts[0], /is not a backend this build knows/);
  assert.match(r.verdicts[1], /is not a backend this build knows/);
});

test("changing the requirement of a RUNNING deployment is surfaced, never swapped in silently", async () => {
  const rec = { _onchain: true, status: "running", _envelope: REQ };
  const r = await seam({ edits: [{ rec, chainCid: "" }, { rec, chainCid: '{"isolation":{"require":"snp-guest-per-app"},"waf":{"blockScanners":true}}' },
                                 { rec: { ...rec, _envelope: "" }, chainCid: REQ }] }, TIER);
  // the middle edit adds protection rules: on this tier they could never be applied, so it is surfaced too
  assert.deepEqual(r.edits, ["error", "error", "error"]);
  const wafOnly = await seam({ edits: [{ rec, chainCid: '{"isolation":{"require":"snp-guest-per-app"},"waf":{"blockScanners":true}}' }] });
  assert.deepEqual(wafOnly.edits, ["error"], "without the flag the namespace does not parse at all, as before");
  // and on a box without the backend, adding the requirement to a running app is an error, as for any
  // namespace this runner cannot honour - not a live swap
  const off = await seam({ edits: [{ rec: { ...rec, _envelope: "" }, chainCid: REQ }] });
  assert.deepEqual(off.edits, ["error"]);
});

test("the tier's view of a version: _media is not app config, anything else is", async () => {
  const r = await seam({ appConfig: ['{"_media":{"thumbnail":"bafk"}}', "", '{"_media":{},"model":"x"}', "not json", '{"a":1}'] }, TIER);
  assert.deepEqual(r.appConfig, ["", "", '{"model":"x"}', "not json", '{"a":1}']);
});

test("the derivation record a spawn sends: the version's catalog ref, CID, pinned policy and the host's runtime", async () => {
  const app = "0x" + "ab".repeat(32), rt = "7e".repeat(32);
  const r = await seam({ derive: [
    { catalogRef: `catalog://${app}/4`, wasmRef: "ipfs://bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza", memMb: 128, runtimeId: rt },
    { catalogRef: `catalog://${app}/4`, wasmRef: "ipfs://bafkreiexample", memMb: 900, runtimeId: rt },
    { catalogRef: `catalog://${app}/4`, wasmRef: "ipfs://bafkreiexample", memMb: 0, runtimeId: rt },
    { catalogRef: "ipfs://bafkreiexample", wasmRef: "ipfs://bafkreiexample", memMb: 128, runtimeId: rt },
    { catalogRef: `catalog://${app}/4`, wasmRef: "ipfs://bafkreiexample", memMb: 128, runtimeId: "" },
  ] }, TIER);
  assert.deepEqual(r.derive[0], { derivation: "enclave-catalog-bundle/1", catalog: { app, version: 4 },
    cid: "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza", policy: { cpuPercent: 100, memMiB: 128, vcpus: 1 }, runtimeId: rt });
  assert.deepEqual(r.derive[1].policy, { cpuPercent: 100, memMiB: 900, vcpus: 1 });
  assert.deepEqual(r.derive[2].policy, { cpuPercent: 100, memMiB: 128, vcpus: 1 }, "an on-chain 0 takes the floor");
  assert.match(r.derive[3].error, /needs a catalog version/);
  assert.match(r.derive[4].error, /states no runtime identity/);
});

test("the prefetch a tier box asks for carries the same derivation record as its spawn", async () => {
  const app = "0x" + "ab".repeat(32), rt = "7e".repeat(32);
  const g = { ref: `catalog://${app}/4`, wasmRef: "ipfs://bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza", min: { memMb: 128 } };
  const r = await seam({ prefetch: [{ g, runtimeId: rt }, { g: { ...g, ref: "ipfs://x" }, runtimeId: rt }],
                         derive: [{ catalogRef: g.ref, wasmRef: g.wasmRef, memMb: 128, runtimeId: rt }] }, TIER);
  assert.deepEqual(r.prefetch[0], { image: g.wasmRef, derive: r.derive[0] });
  assert.match(r.prefetch[1].error, /needs a catalog version/);
});

test("the record digest a tier spawn compares is guestd's recordSha256 for the same record", async () => {
  // the production canary's record, and the recordSha256 guestd and the independent reference both reported for it
  const rec = { derivation: "enclave-catalog-bundle/1",
    catalog: { app: "0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed", version: 4 },
    cid: "bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza",
    policy: { cpuPercent: 100, memMiB: 128, vcpus: 1 },
    runtimeId: "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8" };
  const r = await seam({ recordDigest: [rec, { ...rec, policy: { ...rec.policy, memMiB: 256 } }] }, TIER);
  assert.equal(r.recordDigest[0], "bff33b951aade0a921edea4b0aca89712005d20cbb2c074c0f885d079e059d6c");
  assert.notEqual(r.recordDigest[1], r.recordDigest[0]);
});

test("one declared HTTP port is served (enclave-catalog-bundle/2) when the manager derives it; nothing else is", async () => {
  const v2 = { ...GUESTD, catalog: { derivations: ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2"] } };
  const v1only = { ...GUESTD, catalog: { derivations: ["enclave-catalog-bundle/1"] } };
  const r = await seam({ verdicts: [
    { ...clean, manager: v2, firewall: ["http:8000"] },
    { ...clean, manager: v1only, firewall: ["http:8000"] },
    { ...clean, manager: v2, firewall: ["http:8000", "http:8001"] },
    { ...clean, manager: v2, firewall: ["http:8000", "tcp:5432"] },
    { ...clean, manager: v2, firewall: ["udp:5353"] },
  ] }, TIER);
  assert.equal(r.verdicts[0], null);
  assert.match(r.verdicts[1], /cannot derive such a bundle \(enclave-catalog-bundle\/2\)/);
  for (const v of r.verdicts.slice(2)) assert.match(v, /beyond one HTTP port/);
});

test("a command's derivation and prefetch carry its HTTP port; tcp/udp never derive", async () => {
  const app = "0x" + "ab".repeat(32), rt = "7e".repeat(32);
  const g = { ref: `catalog://${app}/4`, wasmRef: "ipfs://bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee",
              min: { memMb: 256 }, ports: "http:8000" };
  const r = await seam({
    derive: [{ catalogRef: g.ref, wasmRef: g.wasmRef, memMb: 256, runtimeId: rt, ports: ["http:8000"] },
             { catalogRef: g.ref, wasmRef: g.wasmRef, memMb: 256, runtimeId: rt, ports: ["tcp:5432"] },
             { catalogRef: g.ref, wasmRef: g.wasmRef, memMb: 256, runtimeId: rt, ports: [] }],
    prefetch: [{ g, runtimeId: rt }] }, TIER);
  assert.deepEqual(r.derive[0], { derivation: "enclave-catalog-bundle/2", catalog: { app, version: 4 },
    cid: "bafkreidocbixnql7lroykdtwx4r2fmi5n6sra4lj7b7vhscsfqn4gctlee", policy: { cpuPercent: 100, memMiB: 256, vcpus: 1 },
    runtimeId: rt, http: 8000 });
  assert.match(r.derive[1].error, /at most one declared HTTP port/);
  assert.equal(r.derive[2].derivation, "enclave-catalog-bundle/1");
  assert.equal(r.derive[2].http, undefined);
  assert.deepEqual(r.prefetch[0].derive, r.derive[0]);
});
