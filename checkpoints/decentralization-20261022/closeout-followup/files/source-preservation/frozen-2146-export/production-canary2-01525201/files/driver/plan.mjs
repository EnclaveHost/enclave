// The canary plan: a FINITE, ordered step list derived only from pins + recorded observations. Pure: no I/O.
//
// Scope (root clarification 2026-10-23): a BASELINE lifecycle canary of the CURRENT production custody state:
// the EXISTING original vault 0xE486 and committee 0x4774 (epoch 1, t 1, one Enclave seat, custodian image
// 9d43e63 / measurement c8663742 as live), exercised through brand-new dedicated hello-world deployments owned by the
// configured agent EOA 0x29479. It certifies nothing about the corrected r2 candidate. Policy 0x4e62 is never touched.
//
// Every step carries a hash over (pins hash, its own definition). The journal binds the pins hash and each entry's
// step hash; mutations additionally need the operator to type back the PREPARED hash. Deployment ids and live facts
// are learned during the run from journaled observations, which change only the steps that use them. A step with an
// unresolved prerequisite is BLOCKED and can never execute (fail closed).
import { hashOf } from "./canonical.mjs";
import { planBudget, spends } from "./budget.mjs";

export const PROTECTED_POLICY_4E62 = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";
export const ORIGINAL_VAULT_V2 = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
export const COMMITTEE_4774 = "0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3";
export const AGENT_EOA_29479 = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
export const CUSTODIAN_ENDPOINT = "https://api.enclave.host/t/custody-metal0";
export const METAL0_ENDPOINT = "https://api.enclave.host/t/metal0";
export const MAX_FEE_PER_GAS_CAP = 100_000_000n;   // 0.1 gwei: no step may pin a higher fee ceiling
// Control images known NOT to sign v2 custody auth for 0xE486 (root provenance 2026-10-23, work/custody-recipient-
// provenance-20261023): metal0 dist-leasegas-deabf8f90 (measurement ed918e4b…) has no measured CUSTODY_VAULT_V2.
export const KNOWN_LACKING_CONTROL_MANIFESTS = Object.freeze(["c7cb436db609f361a07d5f32a8a0d71f4fc399f329d244ff2512da8ca34dfca4"]);
// Optional cases root may disable to fit the aggregate budget (the core create/release/rotate path is not optional).
export const OPTIONAL_CASES = Object.freeze(["wrong-owner", "stale-policy", "nonce-replay", "wrong-image", "wrong-runtime", "wrong-app", "paused", "relay-refusals", "migration"]);
const H32 = /^0x[0-9a-f]{64}$/, A20 = /^0x[0-9a-f]{40}$/, M96 = /^[0-9a-f]{96}$/, R64 = /^[0-9a-f]{64}$/;
const lc = (x) => String(x ?? "").toLowerCase();

// Prerequisites: resolved only by a pinned public value, a recorded observation, or a named root approval. Never by default.
export const PREREQS = {
  "pins.repo": "client code repo + commit + file hashes pinned (repo-r2 ab589bf8 unless root names another)",
  "pins.rpcs": ">= 3 distinct public Base RPCs (agreement of public endpoints; NOT trustless)",
  "owner.scope": "root's written reuse scope for agent EOA 0x29479: ONLY the canary deployments created by this plan; never 0x4e62 or any other id",
  "read.vault": "vault 0xE486 runtime code hash at an agreed block equals the pinned original runtime hash",
  "read.committee": "committee 0x4774 at an agreed block: epoch 1, t 1, W 1, one machine at the custody-metal0 endpoint (as pinned)",
  "read.protected4e62": "policy 0x4e62 snapshot (owner, policyRev, secretRev, bundle keccak, paused) recorded for the end comparison",
  "read.owner": "owner nonce + balance agreed; balance >= the plan's aggregate worst case (each spending step re-checks the aggregate and its own bound)",
  "fees.bounded": "S0.chain read the GasPriceOracle: the L1 fee upper bound for a pinned-size update and the operator fee (isIsthmus/getOperatorFee) are within their pinned allowances, and the base fee fits the fee cap",
  "custodian.info": "public GET <custodian>/v2/custody/info answers the chain machine's encKey and measurement c8663742 (the live production image)",
  "recipient.runner": "a live runner endpoint that advertises snp-guest-per-app, holds an active registry entry, and whose MEASURED supervisor signs v2 custody auth for 0xE486 (CUSTODY_VAULT_V2 in the activated control image, evidence by manifest sha + source overlay). BLOCKED today: metal0 runs dist-leasegas-deabf8f90 (manifest c7cb436d…) which has no measured CUSTODY_VAULT_V2 until root D's restore is activated",
  "recipient.billing": "the canary lease is paid within the owner's USDC, or rate 0 because the owner is ALREADY that runner's declared payout wallet. Never a payout declaration on metal0 (its payout wallet decides the Enclave custody seat). Lease gas: the EXISTING app-funded lease-gas reserve (0x12a3f873…, executor 0x8900baca…, metal0 operator's 7702 delegation unchanged) configured + deposited by the canary owner with the existing `enclave --independent lease-gas` CLI; no direct operator gas, no new contract",
  "image.recipient": "hello-world catalog version pinned with appId, measurement and runtimeId from isolation/m4/expected-measurement.sh --pin for the runner's domain release; minTcb from the real chip",
  "relay.v2aware": "relay CUSTODY_VAULT_V2 = 0xE486 (root R5, public env keys only)",
  "cli.pins": "S0.clipins: the contract-pins file root passes to the EXISTING CLI (--independent --contract-pins) matches its pinned sha256, names ledger rev16d 0xB1783B61… (NOT the CLI's baked retired 0xF9e71385…) and the original vault 0xE486 (NOT the modified 0x56b81b39…), every address has the reviewed runtime code hash, and the book the original vault reads through names the same ledger/registry/factory at one agreed block",
  "hw.oneGuest": "root confirms (S0.root) each recipient boot is ONE new SNP guest (hello-world 1024 MiB, unit cap +768) beside the protected production QEMUs, and the previous canary guest is stopped first",
  "deploy.C1": "C1 created by this plan (D1.create records its id; D1.check reads): ledger owner = canary owner, v2 policyRev 0, no relay record, live lease on the recipient runner",
  "deploy.C2": "C2 created by this plan after C1 is stopped: same conditions as C1",
  "trackN.committee": "root's separately accepted host-owner + NEW r2 committee route, committee id pinned (currently blocked: operator gas, 7702 executor has no payable receive)",
  "trackN.memory": "NEW root memory review for TWO concurrent SNP guests (r2 canary custodian 3072 + recipient 1024); the existing exception covers ONE new guest",
  "outage.sharedConsent": "every consumer of the SHARED committee 0x4774 agreed to an outage window (audit §8.1). Default: never",
};

export function validatePins(p) {
  const errs = [];
  const need = (ok, m) => { if (!ok) errs.push(m); };
  need(p.v === 1, "pins.v must be 1");
  need(p.chainId === 8453, "chainId must be 8453 (Base)");
  need(lc(p.vaultV2) === ORIGINAL_VAULT_V2, "vaultV2 must be the original 0xE486 vault");
  need(lc(p.committee?.id) === COMMITTEE_4774, "track P uses the existing committee 0x4774 only");
  need(A20.test(lc(p.owner?.address)), "owner.address must be an address");
  need(typeof p.owner?.keyEnv === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(p.owner.keyEnv), "owner.keyEnv must be an env var NAME");
  need(Array.isArray(p.rpcs) && p.rpcs.every((u) => /^https:\/\/[^\s]+$/.test(u)) && new Set(p.rpcs.map(lc)).size === p.rpcs.length, "rpcs must be distinct https URLs");
  need(p.deployments === undefined, "deployment ids are learned from the journal (D1/D2.create), never pinned");
  need(typeof p.cli?.pinsFile === "string" && /^[A-Za-z0-9_./-]+$/.test(p.cli.pinsFile) && !p.cli.pinsFile.includes("..") && /^[0-9a-f]{64}$/.test(String(p.cli?.pinsSha256)),
    "cli.pinsFile (repo-relative) and cli.pinsSha256: the contract-pins file the CLI steps must use");
  need(/^[0-9]{8}T[0-9]{6}Z$/.test(String(p.runLabel)), "runLabel: UTC stamp YYYYMMDDTHHMMSSZ");
  need(/^0x[0-9a-f]{64}$/.test(String(p.vaultCodeHash)), "vaultCodeHash: the original runtime keccak");
  need(/^0x[0-9a-f]{64}$/.test(String(p.custodian?.measurementSha256)), "custodian.measurementSha256: the live custodian's chain measurement");
  need(/^https:\/\/[a-z0-9.-]+$/.test(String(p.relay?.api)), "relay.api: https origin");
  need(/^https:\/\/[^\s]{1,190}$/.test(String(p.recipient?.endpoint)) && p.recipient.endpoint !== CUSTODIAN_ENDPOINT, "recipient.endpoint: the runner endpoint that holds the canary lease");
  need(Array.isArray(p.sendRpcs) && p.sendRpcs.length === 2 && p.sendRpcs[0] !== p.sendRpcs[1] && p.sendRpcs.every((u) => (p.rpcs || []).includes(u)), "sendRpcs: exactly two distinct URLs from rpcs (the reviewed sender pattern)");
  const W = /^[0-9]{1,24}$/;
  need(W.test(String(p.fees?.l1FeeWei)) && W.test(String(p.fees?.operatorFeeWei)), "fees.l1FeeWei and fees.operatorFeeWei: pinned per-transaction allowances (wei)");
  const b = p.budget || {};
  need(W.test(String(b.totalWei)) && W.test(String(b.usdcUnits)) && W.test(String(b.usdcFundUnits)) && W.test(String(b.leaseDepositWei)), "budget: totalWei, usdcUnits, usdcFundUnits, leaseDepositWei");
  for (const k of ["create", "stop", "leaseConfigure", "leaseDeposit"]) need(W.test(String(b.cliWei?.[k])), `budget.cliWei.${k}: per-CLI-transaction allowance (wei)`);
  need((p.cases?.disabled || []).every((c) => OPTIONAL_CASES.includes(c)), `cases.disabled: only ${OPTIONAL_CASES.join(", ")}`);
  if (p.image) {
    need(R64.test(p.image.appId || ""), "image.appId: 64 hex");
    need(M96.test(p.image.measurement || ""), "image.measurement: 96 hex");
    need(R64.test(p.image.runtimeId || ""), "image.runtimeId: 64 hex");
    need(p.image.minTcb && typeof p.image.minTcb === "object", "image.minTcb required (no default floor)");
  }
  const fee = BigInt(p.fees?.maxFeePerGasWei ?? 0);
  need(fee > 0n && fee <= MAX_FEE_PER_GAS_CAP, "fees.maxFeePerGasWei: 1..1e8 wei");
  for (const [k, v] of Object.entries(p.gas || {})) need(/^[1-9][0-9]{0,6}$/.test(String(v)), `gas.${k}: positive integer string <= 7 digits`);
  return errs;
}

export function resolvedSet(pins, observations = {}) {
  const r = {};
  const ok = (k, by) => { r[k] = { ok: true, by }; };
  if (pins.repo?.commit && pins.repo?.path && Object.keys(pins.repo?.files || {}).length) ok("pins.repo", "pin");
  if ((pins.rpcs || []).length >= 3) ok("pins.rpcs", "pin");
  const scope = pins.owner?.reuseScope;
  if (scope?.statedBy && scope.at && scope.onlyPlanCreatedDeployments === true) ok("owner.scope", `approval:${scope.statedBy}`);
  if (pins.image && !validatePins(pins).some((e) => e.startsWith("image."))) ok("image.recipient", "pin");
  // track N and a shared outage need a NEW reviewed plan (new pins), never an observation of this run
  for (const k of ["trackN.committee", "trackN.memory", "outage.sharedConsent"])
    if (pins.approvals?.[k]?.by && pins.approvals[k].at && pins.approvals[k].reviewedPlan === true) ok(k, `approval:${pins.approvals[k].by}`);
  const fromObservation = new Set(["read.vault", "read.committee", "read.protected4e62", "read.owner", "fees.bounded", "custodian.info", "recipient.runner",
    "recipient.billing", "relay.v2aware", "hw.oneGuest", "cli.pins", "deploy.C1", "deploy.C2"]);
  for (const [k, v] of Object.entries(observations)) if (fromObservation.has(k) && v?.ok === true && v.stepId) ok(k, `observation:${v.stepId}`);
  return r;
}

function cases(p, ids) {
  const C1 = ids.C1 ?? null, C2 = ids.C2 ?? null;
  const g = { create: "900000", rotate: "300000", rules: "250000", ...(p.gas || {}) };
  const mut = (id, gasKey, extra) => ({ chainId: 8453, target: ORIGINAL_VAULT_V2, from: lc(p.owner.address), fn: "update", ids: [id],
    gasCap: g[gasKey], maxFeePerGasWei: String(p.fees.maxFeePerGasWei), ...extra });
  const base = ["pins.repo", "pins.rpcs", "owner.scope"];
  const reads = [...base, "read.vault", "read.committee", "read.protected4e62", "read.owner", "fees.bounded", "custodian.info"];
  const pre = [...reads, "recipient.runner", "recipient.billing", "image.recipient", "relay.v2aware"];
  const c1 = [...pre, "deploy.C1"], c2 = [...pre, "deploy.C2"];
  const hw = ["hw.oneGuest"];
  return [
    // ---- S0: read-only inventory ----
    { id: "S0.chain", case: "inventory", kind: "read", after: [], requires: base,
      resolves: ["read.vault", "read.committee", "read.protected4e62", "read.owner", "fees.bounded"],
      title: "agreed-block reads: vault code hash, committee 0x4774, policy 0x4e62 snapshot, owner balance + nonce, GasPriceOracle L1/operator fee bounds" },
    { id: "S0.custodian", case: "inventory", kind: "probe", after: [], requires: base, resolves: ["custodian.info"],
      title: "GET custody-metal0 /v2/custody/info: encKey = chain machine encKey; measurement sha = 0x2530eda0 (c8663742, the live image)" },
    { id: "S0.root", case: "inventory", kind: "operator", after: [], requires: base, resolves: ["recipient.runner", "recipient.billing", "relay.v2aware", "hw.oneGuest"],
      title: "root's live inventory: recipient runner (snp-guest-per-app, active entry, supervisor CUSTODY_VAULT_V2), billing mode, relay CUSTODY_VAULT_V2, one-guest confirmation; public facts only" },
    { id: "S0.clipins", case: "inventory", kind: "read", after: [], requires: base, resolves: ["cli.pins"],
      title: "the CLI contract-pins file: sha256 = pins.cli.pinsSha256; reviewed addresses + runtime code hashes; the original vault's book names the same ledger/registry/factory (agreed block)" },
    { id: "S1.markers", case: "inventory", kind: "local", after: ["S0.chain"], requires: base,
      title: "marker sets c1-rev1, c1-rev2, c2-legacy, c2-rev2 created (0600 in private/); journal keeps commitments only" },
    // ---- C1: brand-new dedicated deployment (existing CLI; ledger owner = canary owner) ----
    { id: "D1.create", case: "create", kind: "operator", after: ["S0.chain", "S0.custodian", "S0.root", "S0.clipins"], requires: [...pre, "cli.pins"],
      command: "enclave --independent --rpc <A,B> --contract-pins cli-pins/canary-contract-pins.json --max-fee-gwei 0.012 --signer-mode handoff --from <owner> deploy <hello-world version> --cpu 0.1 --gpu 0 --max-rate <runner rate> --isolation snp-guest-per-app --public [--fund <usd>]",
      title: "root creates C1 with the existing CLI from the canary owner (Sep-24 recipe: public, cpuMilli 100, envelope {isolation:{require:snp-guest-per-app}}; create gasUsed was 411747); records the id and tx hashes",
      learns: "C1", spend: { txs: ["create"], usdc: true } },
    { id: "D1.leasegas", case: "create", kind: "operator", after: ["D1.create"], requires: [...pre, "cli.pins"], spend: { txs: ["leaseConfigure", "leaseDeposit"], depositWei: true },
      command: "enclave --independent --rpc <A,B> --contract-pins cli-pins/canary-contract-pins.json --max-fee-gwei 0.012 --signer-mode handoff --from <owner> lease-gas configure <C1> [policy flags] --lease-gas RECORD --lease-gas-digest sha256:… ; … lease-gas deposit <C1> --wei <budget.leaseDepositWei> …",
      title: "the canary owner configures + funds C1's app-funded lease-gas reserve with the existing CLI (journaled independent signer); records the tx hashes" },
    { id: "D1.check", case: "create", kind: "read", after: ["D1.leasegas"], requires: pre, resolves: ["deploy.C1"], deployment: "C1",
      title: "C1: ledger owner = canary owner, v2 policyRev 0, relay /exists false, live lease held by the recipient runner" },
    // ---- C1 create + attestation-gated release ----
    { id: "C1.create", case: "create", kind: "mutation", after: ["D1.check", "S1.markers"], requires: c1,
      mutation: mut(C1, "create", { policy: { rules: "image", paused: false }, bundle: "c1-rev1" }),
      title: "update(C1, policy{0x4774, paused:false, rules(image)}, bundle(c1-rev1)), expectPolicyRev 0: pins the owner" },
    { id: "C1.create.check", case: "create", kind: "read", after: ["C1.create"], requires: c1,
      title: "policyRev 1, secretRev 1, owner = canary owner, bundle keccak = prepared; relay /exists custody:true" },
    { id: "C1.release.1", case: "release", kind: "hardware", after: ["C1.create.check"], requires: [...c1, ...hw], expectRelease: { secretRev: 1 },
      title: "root (re)starts C1's guest: front 'secrets revision 1 from a v2 threshold of 1 over 1', custodian 'release <C1> ... OK' (no SYNTHETIC), app answers" },
    { id: "C1.markers.1", case: "release", kind: "operator", after: ["C1.release.1"], requires: c1, markerSets: ["c1-rev1"],
      title: "root marker search (counts only) on relay + custodian host; control (the id) found" },
    // ---- rotation ----
    { id: "C1.rotate", case: "rotate", kind: "mutation", after: ["C1.markers.1"], requires: c1,
      mutation: mut(C1, "rotate", { policy: { rules: "image", paused: false }, bundle: "c1-rev2" }),
      title: "update(C1, same policy, bundle(c1-rev2)), expectPolicyRev 1" },
    { id: "C1.rotate.check", case: "rotate", kind: "read", after: ["C1.rotate"], requires: c1, title: "policyRev 2, secretRev 2, bundle keccak = prepared" },
    { id: "C1.release.2", case: "rotate", kind: "hardware", after: ["C1.rotate.check"], requires: [...c1, ...hw], expectRelease: { secretRev: 2 },
      title: "root restarts C1: front 'secrets revision 2', custodian OK" },
    { id: "C1.markers.2", case: "rotate", kind: "operator", after: ["C1.release.2"], requires: c1, markerSets: ["c1-rev1", "c1-rev2"],
      title: "marker search: c1-rev1 and c1-rev2 absent; control found" },
    // ---- chain-side refusals (eth_call only; nothing is sent) ----
    { id: "N.sim.notOwner", case: "wrong-owner", kind: "simulate", after: ["C1.rotate.check"], requires: c1,
      simulate: { id: C1, from: "decoy", expectRevert: "NotOwner" }, title: "eth_call update(C1) from a non-owner address reverts NotOwner" },
    { id: "N.sim.staleRev", case: "stale-policy", kind: "simulate", after: ["C1.rotate.check"], requires: c1,
      simulate: { id: C1, from: "owner", expectPolicyRev: "current-1", expectRevert: "StaleRevision" }, title: "eth_call update(C1) naming expectPolicyRev = current-1 reverts StaleRevision" },
    // ---- pre-attestation refusals on the REAL custodian (no attestation is sent or claimed) ----
    { id: "N.probe.nonce", case: "nonce-replay", kind: "probe", after: ["C1.rotate.check"], requires: c1,
      title: "challenge; one release POST with a non-evidence body (refused, no partial); the SAME nonce again: bad_challenge; a nonce left 125 s: bad_challenge" },
    { id: "N.probe.stale", case: "stale-policy", kind: "probe", after: ["N.probe.nonce"], requires: c1,
      title: "fresh nonces: request naming policyRev-1/secretRev-1: stale_revision; another committee: wrong_committee; epoch 2: stale_epoch; no partial in any answer" },
    // ---- attestation-gated refusals on REAL SNP: policy-only update, then one real boot ----
    { id: "N.image.rules", case: "wrong-image", kind: "mutation", after: ["C1.markers.2", "N.sim.notOwner", "N.sim.staleRev", "N.probe.stale"], requires: c1,
      mutation: mut(C1, "rules", { policy: { rules: "decoy-measurement", paused: false } }), title: "rules admit ONLY a decoy measurement (real runtimeId and appId)" },
    { id: "N.image.boot", case: "wrong-image", kind: "hardware", after: ["N.image.rules"], requires: [...c1, ...hw],
      expectRefusal: { codes: ["evidence_refused"], message: "measurement" }, title: "restart C1: REFUSED evidence_refused (measurement not admitted); front custody error; app not started" },
    { id: "N.runtime.rules", case: "wrong-runtime", kind: "mutation", after: ["N.image.boot"], requires: c1,
      mutation: mut(C1, "rules", { policy: { rules: "decoy-runtime", paused: false } }), title: "rules admit the real measurement with a decoy runtimeId" },
    { id: "N.runtime.boot", case: "wrong-runtime", kind: "hardware", after: ["N.runtime.rules"], requires: [...c1, ...hw],
      expectRefusal: { codes: ["runtime_not_admitted"] }, title: "restart C1: REFUSED runtime_not_admitted; app not started" },
    { id: "N.app.rules", case: "wrong-app", kind: "mutation", after: ["N.runtime.boot"], requires: c1,
      mutation: mut(C1, "rules", { policy: { rules: "decoy-app", paused: false } }), title: "rules with a decoy appId (real image and runtime)" },
    { id: "N.app.boot", case: "wrong-app", kind: "hardware", after: ["N.app.rules"], requires: [...c1, ...hw],
      expectRefusal: { codes: ["evidence_refused"] }, title: "restart C1: REFUSED evidence_refused (app id); app not started" },
    { id: "N.pause", case: "paused", kind: "mutation", after: ["N.app.boot"], requires: c1,
      mutation: mut(C1, "rules", { policy: { rules: "image", paused: true } }), title: "real rules, paused:true" },
    { id: "N.pause.boot", case: "paused", kind: "hardware", after: ["N.pause"], requires: [...c1, ...hw],
      expectRefusal: { codes: ["paused"] }, title: "restart C1: REFUSED paused; app not started" },
    { id: "C1.restore", case: "paused", kind: "mutation", after: ["N.pause.boot"], requires: c1,
      mutation: mut(C1, "rules", { policy: { rules: "image", paused: false } }), title: "real rules, paused:false; the bundle is untouched (secretRev stays 2)" },
    { id: "C1.release.3", case: "paused", kind: "hardware", after: ["C1.restore"], requires: [...c1, ...hw], expectRelease: { secretRev: 2 },
      title: "restart C1: secrets revision 2 released again" },
    // ---- relay refusals for a custody-held id (owner signature only; no gas) ----
    { id: "N.relay", case: "relay-refusals", kind: "relay", after: ["C1.release.3"], requires: c1,
      title: "owner-signed legacy set for C1: 409 custody_held; /get signed by a throwaway in-memory key: refused; /exists: custody:true" },
    { id: "D1.stop", case: "inventory", kind: "operator", after: ["N.relay"], requires: [...c1, "cli.pins"], spend: { txs: ["stop"], cleanup: true },
      command: "enclave --independent --rpc <A,B> --contract-pins cli-pins/canary-contract-pins.json --max-fee-gwei 0.012 --signer-mode handoff --from <owner> stop <C1>", title: "root stops C1 with the existing CLI (setActive false) so the next canary guest is the only one" },
    // ---- migration: dedicated legacy relay-held canary C2 -> v2 ----
    { id: "D2.create", case: "migration", kind: "operator", after: ["D1.stop"], requires: [...pre, "cli.pins"], learns: "C2", spend: { txs: ["create"], usdc: true },
      command: "enclave deploy <same version> --chain-only ... (as D1.create)", title: "root creates C2 exactly like C1; records the id and tx hashes" },
    { id: "D2.leasegas", case: "migration", kind: "operator", after: ["D2.create"], requires: [...pre, "cli.pins"], spend: { txs: ["leaseConfigure", "leaseDeposit"], depositWei: true },
      command: "as D1.leasegas, for C2", title: "configure + fund C2's lease-gas reserve (existing CLI)" },
    { id: "D2.check", case: "migration", kind: "read", after: ["D2.leasegas"], requires: pre, resolves: ["deploy.C2"], deployment: "C2",
      title: "C2: as D1.check, and the relay holds no record yet" },
    { id: "M.legacy.set", case: "migration", kind: "relay", after: ["D2.check"], requires: c2, markerSets: ["c2-legacy"],
      title: "owner-signed relay put {set: c2-legacy} for C2 (the legacy relay-held path, canary markers only)" },
    { id: "M.legacy.check", case: "migration", kind: "relay", after: ["M.legacy.set"], requires: c2,
      title: "owner /get: names = c2-legacy names and value commitments equal (compared in memory); /exists: exists, no custody" },
    { id: "M.migrate", case: "migration", kind: "mutation", after: ["M.legacy.check"], requires: c2,
      mutation: mut(C2, "create", { policy: { rules: "image", paused: false }, bundle: "relay:c2-legacy" }),
      title: "update(C2, policy{0x4774, rules(image)}, bundle(the values the relay returned, proven equal to c2-legacy))" },
    { id: "M.clear", case: "migration", kind: "relay", after: ["M.migrate"], requires: c2,
      title: "only once /exists answers custody:true: owner-signed put {\"clear\":true}" },
    { id: "M.clear.proof", case: "migration", kind: "operator", after: ["M.clear"], requires: c2, markerSets: ["c2-legacy"],
      title: "old-copy clear proof: owner /get names [] ; root has(C2)=false; marker search 0 with control; R6 backups/snapshots LISTED (not cleared by this)" },
    { id: "M.release", case: "migration", kind: "hardware", after: ["M.clear.proof"], requires: [...c2, ...hw], expectRelease: { secretRev: 1 },
      title: "start C2's guest: v2 secrets revision 1" },
    { id: "M.rotate", case: "migration", kind: "mutation", after: ["M.release"], requires: c2,
      mutation: mut(C2, "rotate", { policy: { rules: "image", paused: false }, bundle: "c2-rev2" }),
      title: "rotate C2: its old values were relay plaintext" },
    { id: "M.release.2", case: "migration", kind: "hardware", after: ["M.rotate"], requires: [...c2, ...hw], expectRelease: { secretRev: 2 },
      title: "restart C2: revision 2" },
    { id: "M.markers", case: "migration", kind: "operator", after: ["M.release.2"], requires: c2, markerSets: ["c2-legacy", "c2-rev2"],
      title: "marker search: c2-legacy and c2-rev2 absent from every searched location; control found" },
    { id: "D2.stop", case: "migration", kind: "operator", after: ["M.markers"], requires: [...c2, "cli.pins"], spend: { txs: ["stop"], cleanup: true }, command: "enclave --independent --rpc <A,B> --contract-pins cli-pins/canary-contract-pins.json --max-fee-gwei 0.012 --signer-mode handoff --from <owner> stop <C2>", title: "root stops C2" },
    // ---- track N: dedicated r2 committee (blocked until root routes it) ----
    { id: "O.stopped", case: "outage", kind: "hardware", after: ["D2.stop"], requires: ["trackN.committee", "trackN.memory"],
      title: "canary custodian stopped; boot C3: front 'insufficient custodian quorum ... (need 1)'; app not started" },
    { id: "O.timeout", case: "timeout", kind: "hardware", after: ["O.stopped"], requires: ["trackN.committee", "trackN.memory"],
      title: "canary custodian state store 503 (recovery harness fault copy): never ready; C3 refused; restore -> same encKey" },
    { id: "O.restart", case: "restart", kind: "hardware", after: ["O.timeout"], requires: ["trackN.committee", "trackN.memory"],
      title: "restart canary custodian: same encKey; boot C3: released" },
    { id: "O.rollback", case: "rollback", kind: "hardware", after: ["O.restart"], requires: ["trackN.committee", "trackN.memory"], limitation: "rollback",
      title: "host hands the canary custodian an OLDER valid state.bin: EXPECTED FAIL (no monotonic anchor); recorded as a limitation, never as anti-replay" },
    { id: "O.shared", case: "outage-shared", kind: "hardware", after: ["D2.stop"], requires: ["outage.sharedConsent"],
      title: "outage of the SHARED custodian: only with every consumer's consent; never a rollback on it" },
    // ---- end ----
    { id: "Z.final", case: "inventory", kind: "read", after: ["D2.stop"], requires: reads,
      title: "re-read 0x4e62 (unchanged), committee 0x4774 (unchanged), owner nonce delta = transactions this journal sent; C1/C2 stay stopped (any clear/claim is a separate owner decision)" },
  ];
}

// ids: { C1, C2 } learned from the journal (D1.create / D2.create evidence), never typed into pins.
export function buildPlan(pins, observations = {}, ids = {}) {
  const errs = validatePins(pins);
  if (errs.length) throw new Error(`pins: ${errs.join("; ")}`);
  for (const k of ["C1", "C2"]) {
    if (ids[k] !== undefined && ids[k] !== null && !H32.test(String(ids[k]))) throw new Error(`ids.${k}: lowercase bytes32`);
    if (lc(ids[k]) === PROTECTED_POLICY_4E62) throw new Error(`ids.${k} is the protected policy 0x4e62`);
  }
  if (ids.C1 && ids.C1 === ids.C2) throw new Error("C1 and C2 must be different deployments");
  const resolved = resolvedSet(pins, observations);
  const pinsHash = hashOf("custody-canary-pins-v1", pins);
  const disabled = new Set(pins.cases?.disabled || []);
  const all = cases(pins, ids);
  const kept = new Map(all.filter((s) => !disabled.has(s.case)).map((s) => [s.id, s]));
  const byIdAll = new Map(all.map((s) => [s.id, s]));
  // a disabled step's successors inherit its predecessors (transitively), so the order of the kept steps is unchanged
  const afterOf = (id) => (kept.has(id) ? [id] : byIdAll.get(id).after.flatMap(afterOf));
  // each deployment's policy revision advances by one per kept update, in plan order
  const rev = {};
  const steps = [], byId = new Map();
  for (const s0 of all) {
    if (!kept.has(s0.id)) continue;
    const s = { ...s0, after: [...new Set(s0.after.flatMap(afterOf))] };
    if (s.mutation) { const key = s.id.startsWith("M.") ? "C2" : "C1"; rev[key] = rev[key] ?? 0; s.mutation = { ...s.mutation, expectPolicyRev: rev[key]++ }; }
    const blockedBy = s.requires.filter((r) => !resolved[r]?.ok).map((r) => `${r}: ${PREREQS[r]}`);
    for (const a of s.after) if (byId.get(a).status === "blocked") blockedBy.push(`after ${a} (blocked)`);
    if (s.mutation) {
      if (!s.mutation.ids.every((i) => H32.test(String(i)))) blockedBy.push("target deployment not created yet");
      if (s.mutation.ids.some((i) => lc(i) === PROTECTED_POLICY_4E62)) throw new Error(`${s.id}: would touch the protected policy 0x4e62`);
    }
    if (s.simulate && !H32.test(String(s.simulate.id))) blockedBy.push("target deployment not created yet");
    const stepHash = hashOf("custody-canary-step-v1", { pinsHash, step: s });
    const step = { ...s, stepHash, status: blockedBy.length ? "blocked" : "ready", blockedBy };
    byId.set(s.id, step);
    steps.push(step);
  }
  // the AGGREGATE budget: if the enabled plan's worst case does not fit, every spending step is blocked
  const budget = planBudget(steps, pins);
  if (!budget.fits) for (const st of steps) if (spends(st)) { st.status = "blocked"; st.blockedBy = [...st.blockedBy, ...budget.reasons.map((r) => `budget: ${r}`)]; }
  return { v: 1, pinsHash, resolved, steps, budget, disabledCases: [...disabled],
    statement: "Baseline of the CURRENT production custody state (vault 0xE486, committee 0x4774, custodian c8663742); not the corrected r2 candidate. "
      + "Public-RPC reads are agreement of public endpoints, not trustless. No admin or book-owner function is used. Synthetic attestation is never hardware evidence. "
      + "hello-world does not read its env: release evidence is the guest front's revision/name-count/config-hash lines, NOT proof the app consumed a value." };
}
