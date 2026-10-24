// The r2 canary plan: a FINITE, ordered step list derived only from pins + recorded observations. Pure: no I/O.
//
// Scope (ROOT-R2-CLOSURE, 2026-10-24): a NEW single-seat committee in the ORIGINAL vault 0xE486, created at genesis by the
// corrected custodian (repo-r2 ab589bf8, measurement 70aadff5 / chain hash 0xfbe2f581, transport direct) on metal0, so its
// genesis code set makes r2 active from block one; then the lifecycle matrix on brand-new canary deployments owned by the
// agent EOA 0x29479, released to the hash-only proof app (work/custody-proof-app-20261023 ad81dd5). NEVER the code-frozen
// committee 0x4774 as a lifecycle target (only as the SOURCE of the committee-migration case) and NEVER policy 0x4e62.
// Forked from the reviewed baseline driver (work/custody-v2-production-canary-20261023 0152520, plan.mjs): same step
// schema, hashing, prerequisite and budget rules; see FORK.md for every difference.
//
// The new committee id is never typed: G.verify derives it from the genesis receipt's CommitteeCreated log (agreed RPC
// reads) and journals it as a learned id (journal.mjs, unchanged, stores learned ids under evidence.deploymentId), like the
// canary deployment ids. A step that needs the committee before that is BLOCKED.
import { hashOf } from "./canonical.mjs";
import { planBudget, spends } from "./budget.mjs";

export const PROTECTED_POLICY_4E62 = "0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e";
export const ORIGINAL_VAULT_V2 = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
export const OLD_COMMITTEE_4774 = "0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3";
export const OLD_CUSTODIAN_ENDPOINT = "https://api.enclave.host/t/custody-metal0";
export const OLD_CUSTODIAN_MEASUREMENT_SHA = "0x2530eda0796a9d16eac8e2bb3b1f02abb58a816d4a54ebbbcbfb738a9cf966cf";
export const AGENT_EOA_29479 = "0x29479bf04ed889d46a7afb7f292b9bb26e12647c";
export const METAL0_ENDPOINT = "https://api.enclave.host/t/metal0";
export const METAL0_REGISTRY_ID = "0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be";
export const METAL0_OPERATOR = "0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab";
export const MAX_FEE_PER_GAS_CAP = 100_000_000n;   // 0.1 gwei: no step may pin a higher fee ceiling
// the corrected custodian image (root-verified: work/custody-snp-recovery-harness-20261023 evidence 20261023T201449Z)
export const R2 = Object.freeze({
  commit: "ab589bf80b669c9671b53573d489b6c6c45779ea",
  measurement: "70aadff5455fd65f752c1dcec2d6f1ac4984bebf6c63b284d15fcf47851fb96def231af40c39a3bca6fbf9748f01c429",
  measurementSha256: "0xfbe2f581cd8da409856adcff75a149c3797111cb0c7030b824f015867b9cb8d7",
  manifestSha256: "60bde3e90a9d9984def551c21c8815108272d57d2d37bf2e1eb9f2d209e1ad5b",
  hostSha256: "c2923901a78f6253aa405ef051246211f97e63d8e9ea0267b00e9a836b80090f",
  outageCopySha256: "93c4030573aad84d826f8f5b62c0cc575d0266f65e8c59a9ee040b95b41893d1",   // GET /state 503 fault copy (harness e9b9709a)
  hostOwnership: "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7", transport: "direct",
});
// the hash-only proof app (ad81dd5 / component 7ce32918): appId, measurement, runtimeId of catalog://0x85c5…/0 (memMb 128)
export const PROOF_APP = Object.freeze({
  commit: "ad81dd59f1559dfea74629d4133d75b168047c55",
  catalogAppId: "0x85c5ed4ce282f8c1f434dd600d902d8738a6d8a54b71497dfaa95a1f635813a0", catalogVersion: 0,
  componentSha256: "7ce32918490b91b87c7ffa4cf69769c676b5b835ca11d55904b1511ef93ee883",
  appId: "4f700c921576c417da0e1c7b98a6ef0ae5726f86d096c7f25ea278d4e4116a17",
  measurement: "e5febd103f8cabbad0a439e4daac47aa1caef213867026c442d04976df0a350777d198668c8f0add4f8f141b024cff12",
  runtimeId: "297b6c2c0aee68c38ed612972afd11b12865e21ee39c01f4336e8721b3ef02f8",
});
// root's resource exception (ROOT-R2-CLOSURE): at most TWO new VMs, the r2 custodian and ONE recipient guest at a time,
// each with its measured overhead, and only while the 16 GiB host floor is preserved
export const RESOURCES = Object.freeze({ custodianMiB: 3072, recipientMiB: 1024, floorMiB: 16384 });
export const KNOWN_LACKING_CONTROL_MANIFESTS = Object.freeze(["c7cb436db609f361a07d5f32a8a0d71f4fc399f329d244ff2512da8ca34dfca4"]);
export const OPTIONAL_CASES = Object.freeze(["wrong-owner", "stale-policy", "nonce-replay", "wrong-image", "wrong-runtime", "wrong-app", "paused",
  "relay-refusals", "outage", "timeout", "restart", "rollback", "migration", "migrate-committee"]);
const H32 = /^0x[0-9a-f]{64}$/, A20 = /^0x[0-9a-f]{40}$/, M96 = /^[0-9a-f]{96}$/, R64 = /^[0-9a-f]{64}$/;
const lc = (x) => String(x ?? "").toLowerCase();
// a typed value that only LOOKS like a pin: zero, one repeated nybble, or a fill-in word. Refused everywhere.
export const isPlaceholder = (v) => { const s = lc(v); return !s || /root|fill|todo|tbd|xxx|placeholder|example/.test(s) || /^(0x)?([0-9a-f])\2*$/.test(s); };

export const PREREQS = {
  "pins.repo": "client code repo + commit + file hashes pinned (repo-r2 ab589bf8)",
  "pins.rpcs": ">= 3 distinct public Base RPCs (agreement of public endpoints; NOT trustless)",
  "owner.scope": "root's written reuse scope for agent EOA 0x29479: ONLY the canary deployments created by this plan; never 0x4e62 or any other id",
  "read.vault": "vault 0xE486 runtime code hash at an agreed block equals the pinned original runtime hash",
  "read.old4774": "committee 0x4774 snapshot at an agreed block (epoch, t, W, machines) for the end comparison: it must be unchanged",
  "read.protected4e62": "policy 0x4e62 snapshot recorded for the end comparison",
  "read.owner": "owner nonce + balance agreed; balance >= the plan's aggregate worst case",
  "fees.bounded": "S0.chain read the GasPriceOracle: L1 fee bound and operator fee (Isthmus) within the pinned allowances; 2 x base + tip within the fee cap",
  "host.accepted": "G.host: metal0's registry entry (0x4dde6d1b…) active, operator 0xC9D0…, ACCEPTED owner non-zero through hostOwnership 0xbbd885d3 (the r2 host binding refuses a zero owner: payout is not ownership), payout = the vault's enclaveOwner (createCommittee _admit: the Enclave seat), no owner conflict. Blocked today: enrollment proposeOwner (operator gas) + acceptOwner (admin) not done",
  "custodian.ingress": "root's exact public HTTPS origin for the new custodian (pins.custodian.endpoint: control-VM Caddy -> SSH -R -> forwarder 35d73c68+b1c1feee exact raw-target allowlist -> mgmtPort), recorded in G.launch",
  "resources.twoVm": "G.launch: the r2 custodian (3072 MiB) + ONE recipient guest (1024 MiB) + their measured overhead leave >= 16 GiB host MemAvailable; original custodian and every tenant VM untouched",
  "custodian.launched": "G.launch: a separately hashed capture-only copy of reviewed host.mjs (sha c2923901), without a submitter key, launched out-r2/A-custodian (manifest 60bde3e9, measurement 70aadff5, transport direct, hostOwnership 0xbbd8) with genesis:true, endpoint = pins.custodian.endpoint, registryEndpoint = metal0",
  "committee.genesis": "G.genesis: bounded sender journaled and confirmed the exact captured createCommittee request; no automatic host wallet submission",
  "committee.verified": "G.verify: the genesis receipt (status 1, to 0xE486, CommitteeCreated + EpochActivated) agreed by both send RPCs; committee(cid) epoch 1, t 1, W 1, ONE Enclave machine at pins.custodian.endpoint with measurement 0xfbe2f581 and metal0's registry id; codeActiveAt(cid, 0xfbe2f581) = the genesis block time (r2 active at genesis); codeActiveAt(cid, old 0x2530eda0) = 0",
  "custodian.info": "public GET <pins.custodian.endpoint>/v2/custody/info: encKey = the chain machine's, vault 0xE486 (the r2 image, not custody-metal0)",
  "oldcustodian.info": "public GET custody-metal0 /v2/custody/info: encKey = committee 0x4774's machine (the committee-migration source only)",
  "recipient.runner": "metal0's ACTIVATED control image signs v2 custody auth for 0xE486 (measured CUSTODY_VAULT_V2; manifest sha not known-lacking; evidence ref). BLOCKED today: the running ed918e4b (deabf8f90) lacks it and the 23:36 5db2 activation was rolled back",
  "recipient.billing": "the canary lease is paid within the owner's USDC or rate 0 on a runner whose payout is ALREADY the owner; never a payout declaration on metal0. Lease gas: the EXISTING app-funded reserve (0x12a3f873…), configured + deposited by the canary owner with the existing CLI",
  "image.recipient": "the proof app pinned with appId 4f700c92…, measurement e5febd10…, runtimeId 297b6c2c… (re-derived by root with expected-measurement.sh --pin) and minTcb from the real chip; published at catalog://0x85c5ed4c…/0 (admin publish pending the human)",
  "relay.v2aware": "relay CUSTODY_VAULT_V2 = 0xE486 (public env keys only)",
  "cli.pins": "S0.clipins: the reconciled CLI contract-pins file (ledger rev16d 0xB1783B61…, original vault)",
  "hw.oneGuest": "root confirms each recipient boot is ONE proof-app guest beside the r2 canary custodian and the protected production QEMUs; the previous canary guest is stopped first",
  "deploy.C1": "C1 created by this plan: ledger owner = canary owner, v2 policyRev 0, no relay record, live lease on the recipient runner",
  "deploy.C2": "C2 created by this plan after C1 is stopped: as C1",
  "deploy.C3": "C3 created by this plan after C2 is stopped: as C1",
};

export function validatePins(p) {
  const errs = [];
  const need = (ok, m) => { if (!ok) errs.push(m); };
  need(p.v === 1, "pins.v must be 1");
  need(p.chainId === 8453, "chainId must be 8453 (Base)");
  need(lc(p.vaultV2) === ORIGINAL_VAULT_V2, "vaultV2 must be the original 0xE486 vault");
  need(p.committee === undefined, "the new committee id is LEARNED from the genesis receipt (G.verify), never pinned");
  need(p.deployments === undefined, "deployment ids are learned from the journal (D*.create), never pinned");
  need(A20.test(lc(p.owner?.address)) && lc(p.owner.address) === AGENT_EOA_29479, "owner.address must be the agent EOA 0x29479");
  need(typeof p.owner?.keyEnv === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(p.owner.keyEnv), "owner.keyEnv must be an env var NAME");
  need(Array.isArray(p.rpcs) && p.rpcs.every((u) => /^https:\/\/[^\s]+$/.test(u)) && new Set(p.rpcs.map(lc)).size === p.rpcs.length, "rpcs must be distinct https URLs");
  need(Array.isArray(p.sendRpcs) && p.sendRpcs.length === 2 && p.sendRpcs[0] !== p.sendRpcs[1] && p.sendRpcs.every((u) => (p.rpcs || []).includes(u)), "sendRpcs: exactly two distinct URLs from rpcs");
  need(typeof p.cli?.pinsFile === "string" && /^[A-Za-z0-9_./-]+$/.test(p.cli.pinsFile) && !p.cli.pinsFile.includes("..") && /^[0-9a-f]{64}$/.test(String(p.cli?.pinsSha256)), "cli.pinsFile + cli.pinsSha256");
  need(/^[0-9]{8}T[0-9]{6}Z$/.test(String(p.runLabel)), "runLabel: UTC stamp YYYYMMDDTHHMMSSZ");
  need(/^0x[0-9a-f]{64}$/.test(String(p.vaultCodeHash)), "vaultCodeHash: the original runtime keccak");
  need(/^https:\/\/[a-z0-9.-]+$/.test(String(p.relay?.api)), "relay.api: https origin");
  need(lc(p.recipient?.endpoint) === METAL0_ENDPOINT, "recipient.endpoint: metal0 (the only runner whose control image can carry CUSTODY_VAULT_V2)");
  // the NEW custodian's public origin: exact https, port 443, no path/query/credentials, never the old custodian or a relay tunnel path
  let ep = null; try { ep = new URL(String(p.custodian?.endpoint)); } catch {}
  need(!!ep && ep.protocol === "https:" && !ep.username && !ep.password && !ep.search && !ep.hash && (!ep.port || ep.port === "443") && ep.pathname === "/"
    && String(p.custodian.endpoint) === ep.origin && !isPlaceholder(ep.hostname.split(".")[0]) && lc(p.custodian.endpoint) !== lc(OLD_CUSTODIAN_ENDPOINT)
    && !/\/t\//.test(p.custodian.endpoint), "custodian.endpoint: the new custodian's exact public https origin (no path), not custody-metal0, no placeholder");
  need(p.genesis?.submitter === "owner", "genesis.submitter must be owner: every creation fee is inside the canary budget");
  const W = /^[0-9]{1,24}$/;
  need(W.test(String(p.fees?.l1FeeWei)) && W.test(String(p.fees?.operatorFeeWei)) && W.test(String(p.fees?.referenceUnsignedSize)), "fees.l1FeeWei, fees.operatorFeeWei, fees.referenceUnsignedSize");
  const b = p.budget || {};
  need(W.test(String(b.totalWei)) && W.test(String(b.usdcUnits)) && W.test(String(b.usdcFundUnits)) && W.test(String(b.leaseDepositWei)), "budget: totalWei, usdcUnits, usdcFundUnits, leaseDepositWei");
  for (const k of ["create", "stop", "leaseConfigure", "leaseDeposit", "genesis"]) need(W.test(String(b.cliWei?.[k])), `budget.cliWei.${k}: per-operation allowance (wei)`);
  need((p.cases?.disabled || []).every((c) => OPTIONAL_CASES.includes(c)), `cases.disabled: only ${OPTIONAL_CASES.join(", ")}`);
  if (p.image) {
    need(p.image.appId === PROOF_APP.appId && p.image.measurement === PROOF_APP.measurement && p.image.runtimeId === PROOF_APP.runtimeId,
      "image: exactly the proof app's appId/measurement/runtimeId (ad81dd5); re-derive with expected-measurement.sh --pin and refuse a mismatch");
    need(p.image.minTcb && typeof p.image.minTcb === "object" && Object.keys(p.image.minTcb).length > 0, "image.minTcb required (no default floor)");
  }
  const fee = BigInt(/^[0-9]+$/.test(String(p.fees?.maxFeePerGasWei)) ? p.fees.maxFeePerGasWei : 0);
  need(fee > 0n && fee <= MAX_FEE_PER_GAS_CAP, "fees.maxFeePerGasWei: 1..1e8 wei");
  for (const [k, v] of Object.entries(p.gas || {})) need(/^[1-9][0-9]{0,6}$/.test(String(v)), `gas.${k}: positive integer string <= 7 digits`);
  return errs;
}

export function resolvedSet(pins, observations = {}) {
  const r = {};
  const ok = (k, by) => { r[k] = { ok: true, by }; };
  if (pins.repo?.commit === R2.commit && pins.repo?.path && Object.keys(pins.repo?.files || {}).length) ok("pins.repo", "pin");
  if ((pins.rpcs || []).length >= 3) ok("pins.rpcs", "pin");
  const scope = pins.owner?.reuseScope;
  if (scope?.statedBy && scope.at && !isPlaceholder(scope.statedBy) && !isPlaceholder(scope.at) && scope.onlyPlanCreatedDeployments === true) ok("owner.scope", `approval:${scope.statedBy}`);
  if (pins.image && !validatePins(pins).some((e) => e.startsWith("image"))) ok("image.recipient", "pin");
  const fromObservation = new Set(["read.vault", "read.old4774", "read.protected4e62", "read.owner", "fees.bounded", "host.accepted", "custodian.ingress", "resources.twoVm",
    "custodian.launched", "committee.genesis", "committee.verified", "custodian.info", "oldcustodian.info", "recipient.runner", "recipient.billing", "relay.v2aware",
    "hw.oneGuest", "cli.pins", "deploy.C1", "deploy.C2", "deploy.C3"]);
  for (const [k, v] of Object.entries(observations)) if (fromObservation.has(k) && v?.ok === true && v.stepId) ok(k, `observation:${v.stepId}`);
  return r;
}

function cases(p, ids) {
  const C1 = ids.C1 ?? null, C2 = ids.C2 ?? null, C3 = ids.C3 ?? null, NEW = ids.COMMITTEE ?? null;
  const g = { create: "900000", rotate: "300000", rules: "250000", ...(p.gas || {}) };
  const mut = (dep, id, committee, gasKey, extra) => ({ chainId: 8453, target: ORIGINAL_VAULT_V2, from: lc(p.owner.address), fn: "update", deployment: dep, ids: [id],
    committee, gasCap: g[gasKey], maxFeePerGasWei: String(p.fees.maxFeePerGasWei), ...extra });
  const base = ["pins.repo", "pins.rpcs", "owner.scope"];
  const reads = [...base, "read.vault", "read.old4774", "read.protected4e62", "read.owner", "fees.bounded"];
  const committee = [...reads, "host.accepted", "custodian.ingress", "resources.twoVm", "custodian.launched", "committee.genesis", "committee.verified", "custodian.info"];
  const pre = [...committee, "recipient.runner", "recipient.billing", "image.recipient", "relay.v2aware"];
  const c1 = [...pre, "deploy.C1"], c2 = [...pre, "deploy.C2"], c3 = [...pre, "oldcustodian.info", "deploy.C3"];
  const hw = ["hw.oneGuest"];
  const cli = (verb, dep) => `enclave --independent --rpc <A,B> --contract-pins cli-pins/canary-contract-pins.json --max-fee-gwei <pinned cap> --signer-mode handoff --from <owner> ${verb} ${dep}`;
  const deploy = (n, after) => [
    { id: `D${n}.create`, case: n === 1 ? "create" : n === 2 ? "migration" : "migrate-committee", kind: "operator", after, requires: [...pre, "cli.pins"], learns: `C${n}`, spend: { txs: ["create"], usdc: true },
      command: `${cli("deploy", `catalog://${PROOF_APP.catalogAppId}/${PROOF_APP.catalogVersion}`)} --cpu 0.1 --gpu 0 --mem 128 --max-rate <runner rate> --isolation snp-guest-per-app --public [--fund <usd>]`,
      title: `root creates C${n} (the proof app, memMb 128: the CLI default 256 would change the AppID) with the existing CLI from the canary owner; records the id and tx hashes` },
    { id: `D${n}.leasegas`, case: n === 1 ? "create" : n === 2 ? "migration" : "migrate-committee", kind: "operator", after: [`D${n}.create`], requires: [...pre, "cli.pins"], spend: { txs: ["leaseConfigure", "leaseDeposit"], depositWei: true },
      command: `${cli("lease-gas configure", `<C${n}>`)} … ; ${cli("lease-gas deposit", `<C${n}>`)} --wei <budget.leaseDepositWei>`, title: `configure + fund C${n}'s app-funded lease-gas reserve (existing CLI)` },
    { id: `D${n}.check`, case: n === 1 ? "create" : n === 2 ? "migration" : "migrate-committee", kind: "read", after: [`D${n}.leasegas`], requires: pre, resolves: [`deploy.C${n}`], deployment: `C${n}`,
      title: `C${n}: ledger owner = canary owner, v2 policyRev 0, relay /exists false, live lease held by metal0` }];
  const proofStep = (id, c, dep, sets, after, req, extra = {}) => ({ id, case: c, kind: "proof", after, requires: [...req, ...hw], deployment: dep, proof: { sets, ...extra },
    title: `challenge c (32 fresh bytes) -> root GETs https://<${dep} app>/canary/proof?c=<c>; every proof must equal HMAC-SHA256(marker, "enclave-custody-canary-proof-v1\\n" || NAME || "\\n" || c) for ${sets.join("+")}` + (extra.notSets ? `; NO proof may match ${extra.notSets.join("+")}` : "") });
  return [
    // ---- S0: read-only inventory (the old committee and 0x4e62 are snapshots only) ----
    { id: "S0.chain", case: "inventory", kind: "read", after: [], requires: base, resolves: ["read.vault", "read.old4774", "read.protected4e62", "read.owner", "fees.bounded"],
      title: "agreed-block reads: vault code hash, committee 0x4774 snapshot, policy 0x4e62 snapshot, owner balance + nonce, GasPriceOracle L1/operator fee bounds" },
    { id: "S0.clipins", case: "inventory", kind: "read", after: [], requires: base, resolves: ["cli.pins"], title: "the CLI contract-pins file reconciled with the book (unchanged from the baseline driver)" },
    // ---- G: the NEW committee (r2 active at genesis) ----
    { id: "G.host", case: "genesis", kind: "read", after: ["S0.chain"], requires: reads, resolves: ["host.accepted"],
      title: "metal0 registry entry at an agreed block: active, operator 0xC9D0, accepted owner (hostOwnership 0xbbd8) non-zero, payout = enclaveOwner (Enclave seat), no conflict" },
    { id: "G.launch", case: "genesis", kind: "hardware", after: ["G.host"], requires: [...reads, "host.accepted"], resolves: ["custodian.ingress", "resources.twoVm", "custodian.launched"],
      title: "root launches the r2 custodian ONCE (hashed capture-only copy of host.mjs c2923901, no submitter key, out-r2/A-custodian 60bde3e9 / 70aadff5, 3072 MiB, genesis:true) behind the exact HTTPS origin; records memory before/after and the origin" },
    { id: "G.genesis", case: "genesis", kind: "operator", after: ["G.launch"], requires: [...reads, "host.accepted", "custodian.launched"], resolves: ["committee.genesis"],
      spend: { txs: ["genesis"] },
      title: "guest persists and signs one genesis intent; capture-only host stores it privately; bounded sender checks a fresh SNP quote and accepted host authority, journals before broadcast and verifies the receipt" },
    { id: "G.verify", case: "genesis", kind: "read", after: ["G.genesis"], requires: [...reads, "host.accepted", "committee.genesis"], resolves: ["committee.verified"], learns: "COMMITTEE",
      title: "receipt + committee + code set verified on chain (agreed reads); the committee id is DERIVED from the receipt's CommitteeCreated log and learned" },
    { id: "S0.custodian", case: "genesis", kind: "probe", after: ["G.verify"], requires: [...reads, "committee.verified"], resolves: ["custodian.info"],
      title: "GET <new origin>/v2/custody/info: encKey = the new committee's machine; vault 0xE486" },
    { id: "S0.oldcustodian", case: "migrate-committee", kind: "probe", after: ["S0.chain"], requires: reads, resolves: ["oldcustodian.info"],
      title: "Verify the original custodian's public encKey against its unchanged committee; no mutation" },
    { id: "S0.root", case: "inventory", kind: "operator", after: ["S0.custodian"], requires: committee, resolves: ["recipient.runner", "recipient.billing", "relay.v2aware", "hw.oneGuest"],
      title: "root's live inventory: recipient runner (activated control with CUSTODY_VAULT_V2), billing, relay CUSTODY_VAULT_V2, one recipient guest at a time beside the canary custodian" },
    { id: "S1.markers", case: "inventory", kind: "local", after: ["S0.chain"], requires: base, title: "marker sets c1-rev1, c1-rev2, c2-legacy, c2-rev2, c3-rev1 (0600 in private/)" },
    // ---- C1 on the NEW committee ----
    ...deploy(1, ["S0.root", "S0.clipins"]),
    { id: "C1.create", case: "create", kind: "mutation", after: ["D1.check", "S1.markers"], requires: c1,
      mutation: mut("C1", C1, NEW, "create", { policy: { rules: "image", paused: false }, bundle: "c1-rev1" }),
      title: "update(C1, policy{NEW committee, rules(proof app)}, bundle(c1-rev1)), expectPolicyRev 0: pins the owner" },
    { id: "C1.create.check", case: "create", kind: "read", after: ["C1.create"], requires: c1, deployment: "C1", title: "policyRev 1, secretRev 1, committee = NEW, bundle/rules keccak = prepared; relay /exists custody:true" },
    { id: "C1.release.1", case: "release", kind: "hardware", after: ["C1.create.check"], requires: [...c1, ...hw], deployment: "C1", expectRelease: { secretRev: 1 },
      title: "root (re)starts C1's guest: front 'secrets revision 1 from a v2 threshold of 1 over 1'; the NEW custodian 'release <C1> … OK' (r2 log, no SYNTHETIC)" },
    proofStep("C1.proof.1", "release", "C1", ["c1-rev1"], ["C1.release.1"], c1),
    { id: "C1.markers.1", case: "release", kind: "operator", after: ["C1.proof.1"], requires: c1, deployment: "C1", markerSets: ["c1-rev1"],
      title: "relay never holds v2 plaintext: marker search (counts only) on the relay host + the canary custodian host = 0, control found" },
    { id: "C1.rotate", case: "rotate", kind: "mutation", after: ["C1.markers.1"], requires: c1, mutation: mut("C1", C1, NEW, "rotate", { policy: { rules: "image", paused: false }, bundle: "c1-rev2" }), title: "rotate C1 (bundle c1-rev2)" },
    { id: "C1.rotate.check", case: "rotate", kind: "read", after: ["C1.rotate"], requires: c1, deployment: "C1", title: "policyRev 2, secretRev 2" },
    { id: "C1.release.2", case: "rotate", kind: "hardware", after: ["C1.rotate.check"], requires: [...c1, ...hw], deployment: "C1", expectRelease: { secretRev: 2 }, title: "restart C1: revision 2" },
    proofStep("C1.proof.2", "rotate", "C1", ["c1-rev2"], ["C1.release.2"], c1, { notSets: ["c1-rev1"] }),
    { id: "C1.markers.2", case: "rotate", kind: "operator", after: ["C1.proof.2"], requires: c1, deployment: "C1", markerSets: ["c1-rev1", "c1-rev2"], title: "marker search: rev1 + rev2 absent; control found" },
    // ---- refusals: chain (eth_call), relay, pre-attestation probes, attestation on REAL SNP ----
    { id: "N.sim.notOwner", case: "wrong-owner", kind: "simulate", after: ["C1.rotate.check"], requires: c1, deployment: "C1", simulate: { id: C1, committee: NEW, from: "decoy", expectRevert: "NotOwner" }, title: "eth_call update(C1) from a non-owner reverts NotOwner" },
    { id: "N.sim.staleRev", case: "stale-policy", kind: "simulate", after: ["C1.rotate.check"], requires: c1, deployment: "C1", simulate: { id: C1, committee: NEW, from: "owner", expectPolicyRev: "current-1", expectRevert: "StaleRevision" }, title: "eth_call with expectPolicyRev current-1 reverts StaleRevision" },
    { id: "N.probe.nonce", case: "nonce-replay", kind: "probe", after: ["C1.rotate.check"], requires: c1, deployment: "C1", custodian: "new", title: "NEW custodian: burnt nonce / expired nonce -> bad_challenge; no partial (no attestation claimed)" },
    { id: "N.probe.stale", case: "stale-policy", kind: "probe", after: ["N.probe.nonce"], requires: c1, deployment: "C1", custodian: "new", title: "NEW custodian: stale_revision / wrong_committee / stale_epoch; no partial" },
    { id: "N.image.rules", case: "wrong-image", kind: "mutation", after: ["C1.markers.2", "N.sim.notOwner", "N.sim.staleRev", "N.probe.stale"], requires: c1, mutation: mut("C1", C1, NEW, "rules", { policy: { rules: "decoy-measurement", paused: false } }), title: "rules admit only a decoy measurement" },
    { id: "N.image.boot", case: "wrong-image", kind: "hardware", after: ["N.image.rules"], requires: [...c1, ...hw], deployment: "C1", expectRefusal: { codes: ["evidence_refused"], message: "measurement" }, title: "restart C1: REFUSED evidence_refused (measurement); app not started" },
    { id: "N.runtime.rules", case: "wrong-runtime", kind: "mutation", after: ["N.image.boot"], requires: c1, mutation: mut("C1", C1, NEW, "rules", { policy: { rules: "decoy-runtime", paused: false } }), title: "rules with a decoy runtimeId" },
    { id: "N.runtime.boot", case: "wrong-runtime", kind: "hardware", after: ["N.runtime.rules"], requires: [...c1, ...hw], deployment: "C1", expectRefusal: { codes: ["runtime_not_admitted"] }, title: "restart C1: REFUSED runtime_not_admitted" },
    { id: "N.app.rules", case: "wrong-app", kind: "mutation", after: ["N.runtime.boot"], requires: c1, mutation: mut("C1", C1, NEW, "rules", { policy: { rules: "decoy-app", paused: false } }), title: "rules with a decoy appId" },
    { id: "N.app.boot", case: "wrong-app", kind: "hardware", after: ["N.app.rules"], requires: [...c1, ...hw], deployment: "C1", expectRefusal: { codes: ["evidence_refused"] }, title: "restart C1: REFUSED evidence_refused (app id)" },
    { id: "N.pause", case: "paused", kind: "mutation", after: ["N.app.boot"], requires: c1, mutation: mut("C1", C1, NEW, "rules", { policy: { rules: "image", paused: true } }), title: "real rules, paused:true" },
    { id: "N.pause.boot", case: "paused", kind: "hardware", after: ["N.pause"], requires: [...c1, ...hw], deployment: "C1", expectRefusal: { codes: ["paused"] }, title: "restart C1: REFUSED paused" },
    { id: "C1.restore", case: "paused", kind: "mutation", after: ["N.pause.boot"], requires: c1, mutation: mut("C1", C1, NEW, "rules", { policy: { rules: "image", paused: false } }), title: "real rules, paused:false (secretRev stays 2)" },
    { id: "C1.release.3", case: "paused", kind: "hardware", after: ["C1.restore"], requires: [...c1, ...hw], deployment: "C1", expectRelease: { secretRev: 2 }, title: "restart C1: revision 2 again" },
    { id: "N.relay", case: "relay-refusals", kind: "relay", after: ["C1.release.3"], requires: c1, deployment: "C1", title: "owner-signed legacy set: 409 custody_held; stranger /get refused; /exists custody:true" },
    // ---- outage / timeout / restart / rollback on the DEDICATED canary custodian (never the shared 0x4774 one) ----
    { id: "O.stopped", case: "outage", kind: "hardware", after: ["N.relay"], requires: [...c1, ...hw], deployment: "C1", expectOutage: { custodian: "stopped" },
      title: "root stops the canary custodian; restart C1: front custody error / insufficient quorum, NO release line, app not started" },
    { id: "O.timeout", case: "timeout", kind: "hardware", after: ["O.stopped"], requires: [...c1, ...hw], deployment: "C1", expectOutage: { custodian: "state-503" },
      title: `root starts the canary custodian through the GET /state 503 fault copy (sha ${R2.outageCopySha256.slice(0, 8)}): never ready, no state PUT; C1 refused` },
    { id: "O.restart", case: "restart", kind: "hardware", after: ["O.timeout"], requires: [...c1, ...hw], deployment: "C1", expectRelease: { secretRev: 2 }, expectRestart: true,
      title: "root restarts the canary custodian normally from its sealed state: same encKey (public /info); restart C1: revision 2 released" },
    proofStep("O.restart.proof", "restart", "C1", ["c1-rev2"], ["O.restart"], c1, { notSets: ["c1-rev1"] }),
    { id: "O.rollback", case: "rollback", kind: "hardware", after: ["O.restart.proof"], requires: [...c1, ...hw], deployment: "C1", limitation: "rollback",
      title: "host hands the canary custodian an OLDER valid state.bin: EXPECTED FAIL (no monotonic anchor); recorded as a limitation, never as anti-replay" },
    { id: "D1.stop", case: "inventory", kind: "operator", after: ["O.rollback"], requires: [...c1, "cli.pins"], spend: { txs: ["stop"], cleanup: true }, command: cli("stop", "<C1>"), title: "root stops C1 (existing CLI)" },
    // ---- migration: legacy relay-held C2 -> v2 on the NEW committee, with the old-copy clear proof ----
    ...deploy(2, ["D1.stop"]),
    { id: "M.legacy.set", case: "migration", kind: "relay", after: ["D2.check"], requires: c2, deployment: "C2", markerSets: ["c2-legacy"], title: "owner-signed relay put {set: c2-legacy} (canary markers only)" },
    { id: "M.legacy.check", case: "migration", kind: "relay", after: ["M.legacy.set"], requires: c2, deployment: "C2", title: "owner /get: names and commitments equal; /exists: exists, no custody" },
    { id: "M.migrate", case: "migration", kind: "mutation", after: ["M.legacy.check"], requires: c2, mutation: mut("C2", C2, NEW, "create", { policy: { rules: "image", paused: false }, bundle: "relay:c2-legacy" }), title: "update(C2, NEW committee, bundle(the relay's values, proven equal to c2-legacy))" },
    { id: "M.clear", case: "migration", kind: "relay", after: ["M.migrate"], requires: c2, deployment: "C2", title: "only once /exists answers custody:true: owner-signed put {clear:true}" },
    { id: "M.clear.proof", case: "migration", kind: "operator", after: ["M.clear"], requires: c2, deployment: "C2", markerSets: ["c2-legacy"],
      title: "ACTIVE old-copy deletion: owner /get names []; root has(C2)=false in the live store; marker search 0 with control; backups/snapshots LISTED separately (not claimed cleared)" },
    { id: "M.release", case: "migration", kind: "hardware", after: ["M.clear.proof"], requires: [...c2, ...hw], deployment: "C2", expectRelease: { secretRev: 1 }, title: "start C2: v2 revision 1" },
    proofStep("M.proof", "migration", "C2", ["c2-legacy"], ["M.release"], c2),
    { id: "M.rotate", case: "migration", kind: "mutation", after: ["M.proof"], requires: c2, mutation: mut("C2", C2, NEW, "rotate", { policy: { rules: "image", paused: false }, bundle: "c2-rev2" }), title: "rotate C2 (its old values were relay plaintext)" },
    { id: "M.release.2", case: "migration", kind: "hardware", after: ["M.rotate"], requires: [...c2, ...hw], deployment: "C2", expectRelease: { secretRev: 2 }, title: "restart C2: revision 2" },
    proofStep("M.proof.2", "migration", "C2", ["c2-rev2"], ["M.release.2"], c2, { notSets: ["c2-legacy"] }),
    { id: "M.markers", case: "migration", kind: "operator", after: ["M.proof.2"], requires: c2, deployment: "C2", markerSets: ["c2-legacy", "c2-rev2"], title: "marker search: c2-legacy and c2-rev2 absent; control found" },
    { id: "D2.stop", case: "migration", kind: "operator", after: ["M.markers"], requires: [...c2, "cli.pins"], spend: { txs: ["stop"], cleanup: true }, command: cli("stop", "<C2>"), title: "root stops C2" },
    // ---- committee migration: C3 first on the code-frozen 0x4774, then owner re-entry onto the NEW committee ----
    ...deploy(3, ["D2.stop"]),
    { id: "X.old.create", case: "migrate-committee", kind: "mutation", after: ["D3.check", "S1.markers"], requires: c3, mutation: mut("C3", C3, OLD_COMMITTEE_4774, "create", { policy: { rules: "image", paused: false }, bundle: "c3-rev1" }),
      title: "update(C3, policy{OLD committee 0x4774}, bundle(c3-rev1)): a canary policy of the frozen committee (never 0x4e62)" },
    { id: "X.old.check", case: "migrate-committee", kind: "read", after: ["X.old.create"], requires: c3, deployment: "C3", committee: "old", title: "policyRev 1, committee 0x4774" },
    { id: "X.old.release", case: "migrate-committee", kind: "hardware", after: ["X.old.check"], requires: [...c3, ...hw], deployment: "C3", expectRelease: { secretRev: 1 }, custodian: "old",
      title: "start C3: released by the ORIGINAL custodian c866 (custody-metal0 log); the current production path" },
    proofStep("X.old.proof", "migrate-committee", "C3", ["c3-rev1"], ["X.old.release"], c3),
    { id: "X.reenter", case: "migrate-committee", kind: "mutation", after: ["X.old.proof"], requires: c3, mutation: mut("C3", C3, NEW, "create", { policy: { rules: "image", paused: false }, bundle: "c3-rev1" }),
      title: "owner re-entry: update(C3, policy{NEW committee}, bundle(the SAME c3-rev1 values, encrypted to the NEW committee))" },
    { id: "X.reenter.check", case: "migrate-committee", kind: "read", after: ["X.reenter"], requires: c3, deployment: "C3", title: "policyRev 2, secretRev 2, committee = NEW" },
    { id: "X.new.release", case: "migrate-committee", kind: "hardware", after: ["X.reenter.check"], requires: [...c3, ...hw], deployment: "C3", expectRelease: { secretRev: 2 },
      title: "restart C3: released by the NEW custodian; the old custodian logs no release for C3" },
    proofStep("X.new.proof", "migrate-committee", "C3", ["c3-rev1"], ["X.new.release"], c3),
    { id: "X.old.refuses", case: "migrate-committee", kind: "probe", after: ["X.new.proof"], requires: c3, deployment: "C3", custodian: "old",
      title: "the ORIGINAL custodian, asked for C3 at its old committee: wrong_committee; no partial. The old committee's ciphertext stays in chain history (listed, not deletable)" },
    { id: "X.markers", case: "migrate-committee", kind: "operator", after: ["X.old.refuses"], requires: c3, deployment: "C3", markerSets: ["c3-rev1"], title: "marker search on relay + both custodian hosts: c3-rev1 absent; control found" },
    { id: "D3.stop", case: "migrate-committee", kind: "operator", after: ["X.markers"], requires: [...c3, "cli.pins"], spend: { txs: ["stop"], cleanup: true }, command: cli("stop", "<C3>"), title: "root stops C3" },
    // ---- end ----
    { id: "Z.final", case: "inventory", kind: "read", after: ["D3.stop"], requires: reads,
      title: "re-read 0x4e62 and 0x4774 (unchanged), the NEW committee (still epoch 1, its machine unchanged), owner nonce delta; C1-C3 stay stopped" },
  ];
}

// ids: { COMMITTEE, C1, C2, C3 } learned from the journal (G.verify / D*.create evidence), never typed into pins.
export function buildPlan(pins, observations = {}, ids = {}) {
  const errs = validatePins(pins);
  if (errs.length) throw new Error(`pins: ${errs.join("; ")}`);
  for (const k of ["COMMITTEE", "C1", "C2", "C3"]) {
    if (ids[k] !== undefined && ids[k] !== null && (!H32.test(String(ids[k])) || isPlaceholder(ids[k]))) throw new Error(`ids.${k}: lowercase bytes32, not a placeholder`);
    if (lc(ids[k]) === PROTECTED_POLICY_4E62) throw new Error(`ids.${k} is the protected policy 0x4e62`);
  }
  if (ids.COMMITTEE && lc(ids.COMMITTEE) === OLD_COMMITTEE_4774) throw new Error("the learned committee is the code-frozen 0x4774: refused");
  const deps = ["C1", "C2", "C3"].map((k) => ids[k]).filter(Boolean);
  if (new Set(deps).size !== deps.length) throw new Error("C1, C2 and C3 must be different deployments");
  const resolved = resolvedSet(pins, observations);
  const pinsHash = hashOf("custody-canary-r2-pins-v1", pins);
  const disabled = new Set(pins.cases?.disabled || []);
  const all = cases(pins, ids);
  const kept = new Map(all.filter((s) => !disabled.has(s.case)).map((s) => [s.id, s]));
  const byIdAll = new Map(all.map((s) => [s.id, s]));
  const afterOf = (id) => (kept.has(id) ? [id] : byIdAll.get(id).after.flatMap(afterOf));
  const rev = {};
  const steps = [], byId = new Map();
  for (const s0 of all) {
    if (!kept.has(s0.id)) continue;
    const s = { ...s0, after: [...new Set(s0.after.flatMap(afterOf))] };
    if (s.mutation) { const key = s.mutation.deployment; rev[key] = rev[key] ?? 0; s.mutation = { ...s.mutation, expectPolicyRev: rev[key]++ }; }
    const blockedBy = s.requires.filter((r) => !resolved[r]?.ok).map((r) => `${r}: ${PREREQS[r]}`);
    for (const a of s.after) if (byId.get(a).status === "blocked") blockedBy.push(`after ${a} (blocked)`);
    if (s.mutation) {
      if (!s.mutation.ids.every((i) => H32.test(String(i)))) blockedBy.push("target deployment not created yet");
      if (!H32.test(String(s.mutation.committee))) blockedBy.push("the new committee is not learned yet (G.verify)");
      if (s.mutation.ids.some((i) => lc(i) === PROTECTED_POLICY_4E62)) throw new Error(`${s.id}: would touch the protected policy 0x4e62`);
      if (lc(s.mutation.committee) === OLD_COMMITTEE_4774 && s.case !== "migrate-committee") throw new Error(`${s.id}: only the committee-migration source may name 0x4774`);
    }
    if (s.simulate && (!H32.test(String(s.simulate.id)) || !H32.test(String(s.simulate.committee)))) blockedBy.push("target deployment or committee not known yet");
    const stepHash = hashOf("custody-canary-r2-step-v1", { pinsHash, step: s });
    const step = { ...s, stepHash, status: blockedBy.length ? "blocked" : "ready", blockedBy };
    byId.set(s.id, step);
    steps.push(step);
  }
  const budget = planBudget(steps, pins);
  if (!budget.fits) for (const st of steps) if (spends(st)) { st.status = "blocked"; st.blockedBy = [...st.blockedBy, ...budget.reasons.map((r) => `budget: ${r}`)]; }
  return { v: 1, pinsHash, resolved, steps, budget, disabledCases: [...disabled], ids,
    statement: "r2 canary: a NEW single-seat committee in the original vault 0xE486 created by the corrected custodian (ab589bf8, 70aadff5) with r2 active at genesis, "
      + "then the lifecycle on new canary deployments released to the hash-only proof app. n = 1, t = 1, one chip, one operator: NOT decentralized custody. "
      + "Public-RPC reads are agreement of public endpoints, not trustless. No admin or book-owner function is called by the driver. Known limitations are recorded as "
      + "expected failures (sealed-state rollback) or stated (relay pointer integrity), never bypassed." };
}
