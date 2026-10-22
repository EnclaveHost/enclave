#!/usr/bin/env node
// The policy OWNER's tool for an authorized custody rewrap (custody/v2/rewrap.mjs, docs/security/custody-owner-rewrap.md).
// READ-ONLY: it reads public chain state at ONE agreed block and prints UNSIGNED requests; it never signs or sends.
//
//   plan:   node scripts/custody-rewrap-plan.mjs --id 0x… --rewrap-manifest <image dir>/manifest.json
//                [--dest 0x<committeeId> --dest-code 0x<sha256 of the destination custodian measurement>] [--expiry-sec 86400]
//                [--rpcs url,url,… --min-agree <strict majority>] [--vault 0x…] [--out plan.json]
//           -> admit (rules + the rewrap image; same committee/pause/bundle) and rollback, each as `update` calldata for an EOA
//              owner and as `updateBySig` EIP-712 data (EOA or ERC-1271 owner); the rewrap AUTHORIZATION's EIP-712 data
//              when the destination committee exists (else the source half, with the destination fields to fill)
//   switch: node scripts/custody-rewrap-plan.mjs --switch --authorization auth.json --result result.json --original-rules rules.json [--paused]
//           -> the owner's ONE switch update after checking the guest's result (label proof, digest, chain, vault)
import fs from "node:fs";
import { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { createChainReaderV2, VAULT_V2_ABI, BOOK_KEYS } from "../custody/v2/chain.mjs";
import { MEASURED_RPCS } from "../custody/v2/build-config.mjs";
import { planRewrap, checkResultAndSwitch, rewrapTypedData, rewrapDigest, ownerUpdateRequests, normalizeAuthorization, REWRAP_RUNTIME_ID } from "../custody/v2/rewrap.mjs";
import { parseRules } from "../custody/rules.mjs";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes("--" + n);
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? "0x" + Buffer.from(v).toString("hex") : v), 1);
const VAULT = String(arg("vault", "0xe48699b8401564aace7a814ae4569b67a3f7eef5")).toLowerCase(), CHAIN_ID = Number(arg("chain-id", "8453"));
const BOOK_ABI = parseAbi(["function addr(bytes32) view returns (address)"]);
const LEDGER_ABI = parseAbi(["function get(bytes32 id) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil))"]);
const REG_ABI = parseAbi(["function get(bytes32 id) view returns ((string endpoint, string repo, bytes32 measurement, address operator, uint64 registeredAt, uint64 lastSeen, bool active, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey, address payoutWallet))"]);
const out = (o) => { const s = J(o) + "\n"; if (arg("out")) fs.writeFileSync(arg("out"), s, { flag: "wx" }); process.stdout.write(s); };

if (has("switch")) {
  const auth = JSON.parse(fs.readFileSync(arg("authorization"), "utf8"));
  const result = JSON.parse(fs.readFileSync(arg("result"), "utf8"));
  const originalRules = JSON.parse(fs.readFileSync(arg("original-rules"), "utf8"));
  const r = result.result || result;
  const { switchUpdate } = checkResultAndSwitch({ chainId: CHAIN_ID, vault: VAULT, authorization: auth.authorization || auth, result: r, originalRules, paused: has("paused") });
  const a = normalizeAuthorization(auth.authorization || auth);
  out({ what: "the owner's ONE switch update (destination committee, the original rules, the new bundle), guarded by expectPolicyRev",
        checked: { authorizationDigest: r.authorizationDigest, bundleHash: r.bundleHash, destination: r.destination },
        switch: { fields: switchUpdate, requests: ownerUpdateRequests({ chainId: CHAIN_ID, vault: VAULT, id: a.id, update: switchUpdate, deadline: Math.floor(Date.now() / 1000) + 3600 }) } });
  process.exit(0);
}

const id = String(arg("id", "")).toLowerCase();
if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("--id must be the deployment id (bytes32)");
const manifest = JSON.parse(fs.readFileSync(arg("rewrap-manifest"), "utf8"));
if (manifest.role !== "enclave-custody-rewrap" || !/^[0-9a-f]{96}$/.test(String(manifest.measurement)) || manifest.runtimeId !== REWRAP_RUNTIME_ID)
  throw new Error("--rewrap-manifest is not a measured rewrap image manifest of this runtime");
if (manifest.measured?.vault !== VAULT || manifest.measured?.chainId !== CHAIN_ID) throw new Error("the rewrap image is measured for another chain or vault");
const rpcs = String(arg("rpcs", MEASURED_RPCS.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
const chain = createChainReaderV2({ rpcs, vault: VAULT, vaultKind: "book", chainId: CHAIN_ID, minAgree: Number(arg("min-agree", String(Math.floor(rpcs.length / 2) + 1))), maxAgeSec: 300 });
const dest = arg("dest", null) ? String(arg("dest")).toLowerCase() : null;
const facts = await chain.snapshot(async ({ call }) => {
  const [owner, policyRev, secretRev, committeeId, paused, rules] = await call(VAULT, VAULT_V2_ABI, "policyOf", [id]);
  const [bCid, bRev, bundle] = await call(VAULT, VAULT_V2_ABI, "bundleOf", [id]);
  const book = await call(VAULT, VAULT_V2_ABI, "book");
  const [ledger, registry] = await Promise.all([call(book, BOOK_ABI, "addr", [BOOK_KEYS.deployments]), call(book, BOOK_ABI, "addr", [BOOK_KEYS.registry])]);
  const row = await call(ledger, LEDGER_ABI, "get", [id]);
  const reg = await call(registry, REG_ABI, "get", [row.runner]);
  let destC = null;
  if (dest) { const [Y, epoch] = await call(VAULT, VAULT_V2_ABI, "committeeOf", [dest]); destC = Number(epoch) ? { committeeId: dest, Y: String(Y).toLowerCase(), epoch: Number(epoch) } : null; }
  return { policy: { id, owner: owner.toLowerCase(), policyRev: policyRev.toString(), secretRev: secretRev.toString(), committeeId: committeeId.toLowerCase(), paused, rules: rules.toLowerCase() },
           bundle: { committeeId: bCid.toLowerCase(), secretRev: bRev.toString(), data: bundle.toLowerCase() },
           lease: { runner: String(row.runner).toLowerCase(), leaseUntil: String(row.leaseUntil), endpoint: reg.endpoint, operator: String(reg.operator).toLowerCase(), active: reg.active },
           dest: destC };
});
if (BigInt(facts.policy.policyRev) === 0n) throw new Error("the deployment has no custody policy");
if (dest && !facts.dest) throw new Error("the destination committee does not exist (yet) in this vault");
const expiry = BigInt(facts.blockTimestamp) + BigInt(Number(arg("expiry-sec", "86400")));
const placeholder = { committeeId: "0x" + "00".repeat(31) + "01", Y: "0x02" + "00".repeat(32) };
const policy = { ...facts.policy, policyRev: BigInt(facts.policy.policyRev), secretRev: BigInt(facts.policy.secretRev) };
const p = planRewrap({ policy, bundle: facts.bundle, dest: facts.dest || placeholder, destCodeMeasurement: arg("dest-code", "0x" + "00".repeat(32)),
  leaseEndpoint: facts.lease.endpoint, rewrapMeasurement: manifest.measurement, expiry });
const deadline = Number(facts.blockTimestamp) + 3600;
const authorization = facts.dest ? p.authorization : Object.fromEntries(Object.entries(p.authorization).map(([k, v]) => [k, ["destCommitteeId", "destKeyHash"].includes(k) || (k === "destCodeMeasurement" && !arg("dest-code")) ? "TO FILL: the destination committee's (after its genesis)" : v]));
out({ what: "UNSIGNED owner requests for an authorized custody rewrap; nothing here was signed or sent",
  checkedAtBlock: { number: String(facts.blockNumber), hash: facts.blockHash, timestamp: String(facts.blockTimestamp) },
  chainId: CHAIN_ID, vault: VAULT, policy: { ...facts.policy, rules: parseRules(Buffer.from(facts.policy.rules.slice(2), "hex")), rulesKeccak: keccak256(facts.policy.rules) },
  bundle: { committeeId: facts.bundle.committeeId, secretRev: facts.bundle.secretRev, bytes: (facts.bundle.data.length - 2) / 2, keccak: keccak256(facts.bundle.data) },
  lease: { ...facts.lease, live: BigInt(facts.lease.leaseUntil) > BigInt(facts.blockTimestamp),
    note: "a release (the rewrap guest's included) needs a LIVE lease held by this endpoint, and its registry operator's signature" }, rewrapImage: { measurement: manifest.measurement, measurementSha256: manifest.measurementSha256, runtimeId: REWRAP_RUNTIME_ID, initramfsSha256: manifest.initramfs?.sha256, sourcesCommitted: manifest.sourcesCommitted },
  steps: {
    "1 admit (owner)": { fields: p.admit, requests: ownerUpdateRequests({ chainId: CHAIN_ID, vault: VAULT, id, update: p.admit, deadline }) },
    "2 authorize (owner, EIP-712)": facts.dest ? { authorization, typedData: rewrapTypedData({ chainId: CHAIN_ID, vault: VAULT, authorization }), digest: rewrapDigest({ chainId: CHAIN_ID, vault: VAULT, authorization }) }
                                               : { authorization, note: "the destination committee must exist first; rerun with --dest and --dest-code" },
    "3 run (lease host operator)": "node custody/v2/rewrap-host.mjs <config> with this image; the result is ciphertext only",
    "4 switch (owner)": "node scripts/custody-rewrap-plan.mjs --switch --authorization … --result … --original-rules …",
    "rollback before the switch (owner)": { fields: p.rollback, requests: ownerUpdateRequests({ chainId: CHAIN_ID, vault: VAULT, id, update: p.rollback, deadline }) } },
  originalRules: p.originalRules });
