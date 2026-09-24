// Tenant-compute eligibility is derived from VERIFIED evidence, never from what a
// machine says about itself and never from the operating system it runs.
//
// The rule (relay/api-relay.js computeEligible, mirrored client-side in
// site/js/core/pricing.js computeEligibleOf, and on the runner in supervisor.js
// teeOk and metal/guest/gsup.mjs SELLING): a box is offered as a deploy target,
// counted as sellable capacity, routed a deployment, or allowed to claim one only
// when there is hardware evidence for the isolation contract it would be sold
// under. Today only a confidential CPU proves that contract. Verified evidence
// for a DIFFERENT contract (a phone's protected-VM chain, a VBS enclave report
// whose app-zone key and traffic still run through the host) is real evidence
// and still not eligibility. A token-attached tunnel proved nothing. An ordinary
// Linux machine with no TEE is never a host, whatever it reports.
//
// Three of the four gates are pinned in source (the pattern test/claim-open-for-us
// uses): the defect each guards is an ABSENCE, one deleted `&&` away.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teeCpuOf, computeEligibleOf, pickEnclaveFor, rankEnclavesFor, moveBlockReason } from "../site/js/core/pricing.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const between = (src, from, to, where) => {
  const i = src.indexOf(from); assert.ok(i > 0, `could not find ${from} in ${where}`);
  const j = src.indexOf(to, i); assert.ok(j > i, `could not find ${to} after ${from} in ${where}`);
  return src.slice(i, j);
};

const BOX = { gpu: false, nodeVcpus: 16, nodeRamGb: 64, nodeGflops: 1000, gpuShareFree: 0, cpuShareFree: 0.9, claimEnabled: true };
const row = (name, availability, extra = {}) => ({ id: "0x" + name.padEnd(64, "0"), endpoint: `https://${name}.example`, name, availability, ...extra });
const APP = { vramMb: 0, gpuGflops: 0, memMb: 512, cpuGflops: 10 };

test("a tunnel box's own teeCpu is a self-report, never evidence: only the hub's verified mode counts", () => {
  // token-attached (mode ""), SAYS it is SEV-SNP: known claim, unverified, not real
  let t = teeCpuOf({ tunnel: true, mode: "", availability: { teeCpu: "amd-sev-snp" } });
  assert.equal(t.real, false); assert.equal(t.known, true); assert.equal(t.unverified, true); assert.equal(t.source, "self-reported");
  assert.equal(t.label, "AMD SEV-SNP", "the claim is named, so the row can say what was claimed and not verified");
  // the hub verified a quote: real, from the relay's side
  t = teeCpuOf({ tunnel: true, mode: "snp", availability: { teeCpu: "amd-sev-snp" } });
  assert.equal(t.real, true); assert.equal(t.source, "relay");
  // a dialed first-party box may present its technology itself (its measured image read its RAD)
  t = teeCpuOf({ availability: { teeCpu: "amd-sev-snp" } });
  assert.equal(t.real, true); assert.equal(t.source, "attestation");
  // a tunnel that says "vbs" in availability but attached on a token is not a VBS node either
  t = teeCpuOf({ tunnel: true, mode: "", availability: { teeCpu: "windows-vbs-enclave", tier: "vbs" } });
  assert.equal(t.real, false); assert.equal(t.unverified, true);
});

test("computeEligibleOf: confidential evidence only; other verified contracts, self-reports and silence are all NO", () => {
  assert.equal(computeEligibleOf(row("snp-tunnel", BOX, { tunnel: true, mode: "snp" })), true);
  assert.equal(computeEligibleOf(row("dialed-snp", { ...BOX, teeCpu: "amd-sev-snp" })), true);
  assert.equal(computeEligibleOf(row("dialed-tdx", { ...BOX, teeCpu: "intel-tdx" })), true);
  // verified, but for a different contract than tenant app hosting
  assert.equal(computeEligibleOf(row("phone", BOX, { tunnel: true, mode: "avf" })), false);
  assert.equal(computeEligibleOf(row("pc", BOX, { tunnel: true, mode: "vbs", tier: "vbs" })), false);
  assert.equal(computeEligibleOf(row("pc-dev", BOX, { tunnel: true, mode: "vbs", tier: "vbs-dev" })), false);
  // self-reports
  assert.equal(computeEligibleOf(row("token", { ...BOX, teeCpu: "amd-sev-snp" }, { tunnel: true, mode: "" })), false);
  assert.equal(computeEligibleOf(row("liar", { ...BOX, teeCpu: "amd-sev-snp", tier: "vbs", claimEnabled: true }, { tunnel: true, mode: "" })), false);
  // an ordinary Linux machine: a metal dev box says so, an old build says nothing - both NO
  assert.equal(computeEligibleOf(row("dev", { ...BOX, teeCpu: "dev-unattested-metal-v1" })), false);
  assert.equal(computeEligibleOf(row("old", BOX)), false);
  assert.equal(computeEligibleOf(row("relay", BOX, { relay: true })), false);
  // the relay's explicit verdict outranks the local rule, both ways
  assert.equal(computeEligibleOf(row("said-yes", BOX, { eligible: true })), true);
  assert.equal(computeEligibleOf(row("said-no", { ...BOX, teeCpu: "amd-sev-snp" }, { eligible: false })), false);
});

test("placement never lands on a box without confidential evidence, however loudly it claims", () => {
  const dev = row("dev", { ...BOX, teeCpu: "dev-unattested-metal-v1" });
  const old = row("old", BOX);
  const token = row("token", { ...BOX, teeCpu: "amd-sev-snp" }, { tunnel: true, mode: "" });
  const vbs = row("pc", { ...BOX, teeCpu: "windows-vbs-enclave", fullService: false }, { tunnel: true, mode: "vbs", tier: "vbs" });
  const good = row("snp", { ...BOX, teeCpu: "amd-sev-snp" });
  assert.ok(pickEnclaveFor(APP, [dev, old, token, vbs]).none, "nothing eligible: no target, not a queued placement on a no-TEE box");
  assert.equal(rankEnclavesFor(APP, [dev, old, token, vbs]).length, 0);
  assert.equal(pickEnclaveFor(APP, [dev, old, token, vbs, good]).name, "snp");
  assert.deepEqual(rankEnclavesFor(APP, [dev, token, good]).map((c) => c.name), ["snp"]);
  // a relay-marked serving:true does not rescue a box the client can see has no evidence
  assert.ok(pickEnclaveFor(APP, [row("served", BOX, { serving: true })]).none);
  // ...and moving a deployment never proposes one either
  // (moveBlockReason always names a reason; the caller decides there were no targets)
  assert.match(moveBlockReason(APP, [dev, token, vbs], "0xcurrent"), /no other enclave is taking work/, "no eligible box: the reason is eligibility, not hardware");
  assert.doesNotMatch(moveBlockReason(APP, [good], "0xcurrent"), /no other enclave is taking work/, "an eligible box is considered");
});

test("the relay's serving set requires hardware evidence (pinned in source)", () => {
  const src = read("relay/api-relay.js");
  const fn = between(src, "function servingEnclaves()", "\n}\n", "relay/api-relay.js");
  assert.match(fn, /computeEligible\(e\)/, "servingEnclaves must AND in computeEligible: claimEnabled alone is the box's own word");
  const elig = between(src, "function computeEligible(e)", "\n}\n", "relay/api-relay.js");
  assert.match(elig, /e\.tunnel\) return TENANT_COMPUTE_MODES\.has/, "a tunnel row is judged by the hub's verified mode");
  assert.match(elig, /CONFIDENTIAL_CPU\.has\(String\(e\.availability\?\.teeCpu/, "a dialed row by its attestation document's technology");
  assert.match(between(src, "const TENANT_COMPUTE_MODES", "\n", "relay/api-relay.js"), /\["snp"\]/,
    "only the confidential attach mode sells tenant compute; avf and vbs are verified for other contracts");
  assert.doesNotMatch(elig, /tier|windows|linux/i, "eligibility never reads a tier string or an operating system");
  const rows = between(src, 'if (u.pathname === "/enclaves")', "return json(res, 200, { updatedAt, aggregate", "relay/api-relay.js");
  assert.match(rows, /eligible: computeEligible\(e\)/, "/enclaves rows carry the explicit verdict for display surfaces");
});

test("the hub never lets a hello frame set the attach mode (pinned in source)", () => {
  const src = read("relay/tunnel.js");
  const hello = between(src, 'if (f.t === "hello") {', "return;\n      }", "relay/tunnel.js")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");   // code only: the comment names the old defect
  assert.doesNotMatch(hello, /t\.mode\s*=/, "the hello handler must not assign t.mode: mode is the hub's verdict from bind()");
  assert.match(hello, /t\.declaredMode\s*=/, "what the box declares is kept as a declaration, nothing more");
});

test("a runner claims only from a confidential CPU it can see in its own attestation document (pinned in source)", () => {
  const src = read("supervisor.js");
  assert.match(src, /const teeOk = \(\) => CONFIDENTIAL_CPU_TECH\.has\(vmTech\(\) \|\| ""\);/, "teeOk is DETECTED from vmTech(), never a config flag");
  assert.match(between(src, "const CONFIDENTIAL_CPU_TECH", "\n", "supervisor.js"), /"amd-sev-snp", "intel-tdx"/);
  const avail = between(src, "claimEnabled: CLAIM_READY", "\n", "supervisor.js");
  assert.match(avail, /&& teeOk\(\)/, "claimEnabled in /availability must carry the TEE term");
  const consider = between(src, "async function considerClaim(", "const ex = deployments.get(d.id);", "supervisor.js");
  assert.match(consider, /if \(!teeOk\(\)\) return/, "considerClaim refuses first, before any ledger read, hinted or forced or swept");
  const hint = between(src, 'return fail(res, 503, "not_claiming", "This enclave is not claiming on-chain deployments right now.");', "const ex = deployments.get(id);", "supervisor.js");
  assert.match(hint, /if \(!teeOk\(\)\)/, "the claim-hint endpoint refuses too");
});

test("a metal dev launch never sells, whatever its config says (pinned in source)", () => {
  const src = read("metal/guest/gsup.mjs");
  assert.match(src, /const SELLING\s*=\s*!!\(REGISTRY_KEY && PUBLIC_URL\) && MODE !== 'dev';/,
    "SELLING must carry the MODE term: a registryKey on a plain-KVM launch used to register and claim");
  const env = between(src, "REGISTRY_ENABLED: SELLING", "} : {}),", "metal/guest/gsup.mjs");
  assert.match(env, /CLAIM_ENABLED: SELLING \? '1' : '0'/);
});

test("the consumer node's market scope and claimEnabled are gated on the isolation contract it does not yet meet (pinned in source)", () => {
  const src = read("windows/node/host.mjs");
  assert.match(src, /appTrafficInsideEnclave\(\) \{ return false; \}/, "app traffic runs through VTL0 today, and the code says so rather than a config flag");
  const gate = between(src, "meetsIsolationContract() {", "\n  }", "windows/node/host.mjs");
  assert.match(gate, /this\.appsInTee\(\) && this\.appTrafficInsideEnclave\(\) && String\(this\.relayTier \|\| ""\) === "vbs"/,
    "every property, and the tier is the RELAY's verdict (relayTier), never the box's own");
  assert.match(src, /scope\(\) \{ return this\.meetsIsolationContract\(\) && this\.cfg\.claimScope === "market"/, "market scope needs the contract; otherwise owner-only");
  assert.match(src, /claimEnabled: this\.meetsIsolationContract\(\) && ready,/, "claimEnabled needs the contract");
  assert.match(read("windows/node/agent.mjs"), /host\.relayTier = tier;/, "the agent hands the relay's verdict to the host");
});
