// WHOSE deployments a node serves in owner-only scope (every Windows node today): its OPERATOR and the owner of each
// VALID delegation it carries - coordinator enclave-87's rule (2026-09-26), with enclave-e3's delegation format. The
// registry's payoutWallet and OWNER_WALLET authorize nothing: they are the operator's own statement, and a payoutWallet
// naming a victim made the box claim, bill and restart the victim's deployments (enclave-5d). One set answers the
// claim, the ledger scan, the restart gate and the sweep's hold (enclave-bf). Real keys, real signatures; Base faked.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeBaseRpc, DEPLOYMENTS, enclaveIdOf } from "./helpers/fake-base-rpc.mjs";
import { privateKeyToAccount } from "viem/accounts";

const OPERATOR_KEY = "0x" + "4f".repeat(32);
process.env.NODE_OPERATOR_KEY = OPERATOR_KEY;              // loadOperator reads it; a throwaway key, nothing is sent
const rpc = await fakeBaseRpc();
const chain = await import("../windows/node/chain.mjs");
chain.addresses.deployments = DEPLOYMENTS;
const REGISTRY = "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac";
chain.addresses.registry = REGISTRY;
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
const { verifyDelegation, parseDelegation } = await import("../windows/node/host-delegation.mjs");
after(() => rpc.close());

const OPERATOR = privateKeyToAccount(OPERATOR_KEY).address.toLowerCase();
const OWNER_A = privateKeyToAccount("0x" + "a1".repeat(32));            // delegates to this box
const VICTIM = "0x" + "5c".repeat(20);                                  // named as payoutWallet / OWNER_WALLET only
const STRANGER = privateKeyToAccount("0x" + "b2".repeat(32));
const BOX = "test";
const ENDPOINT = `https://api.enclave.host/t/${BOX}`;
const ME = enclaveIdOf(ENDPOINT);
const now = () => Math.floor(Date.now() / 1000);

const delegationText = ({ owner = OWNER_A.address, operator = OPERATOR, box = BOX, chainId = 8453, registry = REGISTRY,
                          expires = now() + 90 * 86400 } = {}) =>
  ["enclave-host-delegation-v1", `owner: ${String(owner).toLowerCase()}`, `operator: ${String(operator).toLowerCase()}`, `box: ${box}`,
   `chain: ${chainId}`, `registry: ${String(registry).toLowerCase()}`, `expires: ${expires}`].join("\n");
const signed = async (message, signer = OWNER_A) => ({ message, signature: await signer.signMessage({ message }) });

const hvBox = (cfg = {}) => new Host({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ee-owners-")), endpoint: ENDPOINT, name: BOX,
  appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, engineRetired: true, isolationManager: "http://127.0.0.1:1", ...cfg });
const carry = (h, file, del) => { const d = path.join(h.cfg.dir, "delegations"); fs.mkdirSync(d, { recursive: true });
                                   fs.writeFileSync(path.join(d, file), JSON.stringify(del)); };
const ISOLATED = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
const dep = (owner, over = {}) => ({ createdAt: 1, active: true, owner, isPublic: true, runner: ME,
  leaseUntil: now() + 3600, cpuMilli: 100, gpuMilli: 0, configCid: ISOLATED,
  appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4", ...over });
const claims = (h, d) => chain.claimPolicy(d, { scope: h.scope(), ownerAllow: h.ownerSet(), enclaveId: h.enclaveId,
                                                 isolationBackend: h.isolationBackend });

test("payoutWallet = a victim's wallet and OWNER_WALLET = the victim, no delegation: the victim is NOT served", async () => {
  const h = hvBox({ ownerWallet: VICTIM });
  h.registered = { payoutWallet: VICTIM, endpoint: ENDPOINT };
  await h.refreshOwners();
  assert.deepEqual([...h.ownerSet()], [OPERATOR], "only the operator: payoutWallet and OWNER_WALLET authorize nothing");
  const d = dep(VICTIM);
  assert.match(String(claims(h, d)), /owner-only scope and hosts only its operator's and its delegated owners'/);
  assert.match(String(h.restartRefusal("0x" + "c1".repeat(32), d)), /restarts only its operator's/);
  assert.match(String(h.heldReason(d)), /serves only its operator's and its delegated owners' deployments.*held/);
  assert.deepEqual(h.availability().owners, [OPERATOR]);
});

test("the OPERATOR's own deployment is claimed, restartable and not held", async () => {
  const h = hvBox();
  await h.refreshOwners();
  const d = dep(OPERATOR);
  assert.equal(claims(h, d), null);
  assert.equal(h.restartRefusal("0x" + "c2".repeat(32), d), null);
  assert.equal(h.heldReason(d), null);
});

test("a DELEGATED owner's deployment is claimed, restartable and not held", async () => {
  const h = hvBox();
  carry(h, "a.json", await signed(delegationText()));
  const set = await h.refreshOwners();
  assert.ok(set.has(OWNER_A.address.toLowerCase()));
  const d = dep(OWNER_A.address);
  assert.equal(claims(h, d), null);
  assert.equal(h.restartRefusal("0x" + "c3".repeat(32), d), null);
  assert.equal(h.heldReason(d), null);
  // and a stranger with no delegation still is not
  assert.match(String(claims(h, dep(STRANGER.address))), /owner-only scope/);
});

test("an expired delegation, or one for another box, chain, registry or operator, or signed by someone else, authorizes nobody", async () => {
  const cases = {
    expired: await signed(delegationText({ expires: now() - 1 })),
    "too far out": await signed(delegationText({ expires: now() + 181 * 86400 })),
    "another box": await signed(delegationText({ box: "someone-else" })),
    "another chain": await signed(delegationText({ chainId: 1 })),
    "another registry": await signed(delegationText({ registry: "0x" + "12".repeat(20) })),
    "another operator": await signed(delegationText({ operator: "0x" + "34".repeat(20) })),
    "signed by a stranger": await signed(delegationText(), STRANGER),
    "not the strict form": await signed(delegationText().replace("box: test", "box:  test")),
  };
  for (const [label, del] of Object.entries(cases)) {
    const h = hvBox();
    carry(h, "x.json", del);
    const set = await h.refreshOwners();
    assert.deepEqual([...set], [OPERATOR], `${label} widened the set`);
    assert.match(String(claims(h, dep(OWNER_A.address))), /owner-only scope/, label);
    assert.ok(h.owners.invalid.get("x.json"), `${label} was not recorded as ignored`);
  }
});

test("revocation: deleting the delegation file ends that owner's authority at the next refresh", async () => {
  const h = hvBox();
  carry(h, "a.json", await signed(delegationText()));
  assert.ok((await h.refreshOwners()).has(OWNER_A.address.toLowerCase()));
  fs.rmSync(path.join(h.cfg.dir, "delegations", "a.json"));
  assert.ok(!(await h.refreshOwners()).has(OWNER_A.address.toLowerCase()));
});

test("verifyDelegation: the strict parse and every check, directly", async () => {
  const good = await signed(delegationText());
  const ctx = { operator: OPERATOR, box: BOX, chain: 8453, registry: REGISTRY };
  const v = await verifyDelegation(good, ctx);
  assert.deepEqual({ ok: v.ok, owner: v.owner }, { ok: true, owner: OWNER_A.address.toLowerCase() });
  assert.equal((await verifyDelegation(good, { ...ctx, operator: null })).ok, false, "no operator key: nothing validates");
  assert.equal((await verifyDelegation(good, { ...ctx, registry: "" })).ok, false, "an unresolved registry validates nothing");
  assert.ok(parseDelegation(delegationText() + "\n").error, "a trailing newline is refused");
  assert.ok(parseDelegation(delegationText().replace(OWNER_A.address.toLowerCase(), OWNER_A.address)).error, "mixed-case hex is refused");
  assert.ok(parseDelegation(delegationText({ expires: "0123" })).error, "a leading-zero expiry is refused");
});

// ---- the SWEEP (enclave-bf): a lease this box holds whose owner is no longer served is HELD, never renewed or respawned
const ledgerRow = (owner) => ({ id: "0x" + "e7".repeat(32), owner, ports: "", configCid: ISOLATED,
  appRef: "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4",
  gpuMilli: 0, cpuMilli: 100, appPort: 8080, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 0n, spent6: 0n,
  runner: ME, runnerOperator: "0x" + "00".repeat(20), leaseUntil: BigInt(now() + 600) });   // inside the renewal window

async function sweepOnce(owner) {
  const logs = [];
  const h = hvBox({ log: (s) => logs.push(String(s)) });
  h.chainReady = true; h.registered = { endpoint: ENDPOINT, cpuPricePerSec6: 12n };
  h.ensureRegistered = async () => {}; h.ensurePriced = async () => {};
  const id = "0x" + "e7".repeat(32);
  h.tracked.add(id);
  const ensured = [];
  h.ensureApp = async (i, d, o) => { ensured.push(i); return { status: "running" }; };
  rpc.row.current = ledgerRow(owner);
  const sent = rpc.calls.length;
  await h.tick();
  const txs = rpc.calls.slice(sent).filter((c) => /sendRawTransaction|sendTransaction/.test(JSON.stringify(c))).length;
  return { rec: h.records.get(id), ensured, logs, txs };
}

test("sweep: a tracked lease whose ledger owner became a stranger (a rev-11 transfer) is HELD - not renewed, not respawned", async () => {
  const r = await sweepOnce(STRANGER.address);
  assert.equal(r.rec?.status, "held", JSON.stringify(r.rec));
  assert.match(r.rec.reason, /owner-only scope and serves only its operator's/);
  assert.equal(r.ensured.length, 0, "respawned");
  assert.equal(r.logs.filter((l) => /renew/i.test(l)).length, 0, `renew attempted: ${r.logs.join(" / ")}`);
  assert.equal(r.txs, 0, "a transaction was sent");
});

test("sweep control: the operator's own lease is NOT held - the tick goes on to renew it and ensure it runs", async () => {
  const r = await sweepOnce(OPERATOR);
  assert.notEqual(r.rec?.status, "held", JSON.stringify(r.rec));
  assert.ok(r.logs.some((l) => /renew/i.test(l)) || r.ensured.length === 1, `neither renewed nor ensured: ${r.logs.join(" / ")}`);
});
