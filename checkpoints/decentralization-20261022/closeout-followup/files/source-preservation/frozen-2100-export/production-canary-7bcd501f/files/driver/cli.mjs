#!/usr/bin/env node
// Bounded production canary driver (root-run). One command = at most ONE step; every step is journaled.
//   node driver/cli.mjs plan     --pins pins.json                       the plan, blockers, budget (no network)
//   node driver/cli.mjs status   --pins pins.json                       journal verification + next ready steps (no network)
//   node driver/cli.mjs read     --pins pins.json --step <read step>    agreed-block public reads
//   node driver/cli.mjs probe    --pins pins.json --step <probe step>   public custodian HTTP (pre-attestation only)
//   node driver/cli.mjs markers  --pins pins.json --step S1.markers     create the marker sets (private/, 0600)
//   node driver/cli.mjs needles  --pins pins.json --set <set>           private/needles-<set>.txt for root's remote search (stdin)
//   node driver/cli.mjs prepare  --pins pins.json --step <mutation>     exact calldata -> private/, prints the prepared hash
//   node driver/cli.mjs execute  --pins pins.json --step <mutation> --confirm <prepared hash>   ONE owner transaction
//   node driver/cli.mjs simulate --pins pins.json --step <N.sim.*>      eth_call only
//   node driver/cli.mjs relay    --pins pins.json --step <relay step> --confirm <step hash>      owner-signed relay call(s)
//   node driver/cli.mjs record   --pins pins.json --step <operator|hardware step> --obs obs.json --confirm <step hash>
// The owner key is read ONLY from the env var named by pins.owner.keyEnv, ONLY by prepare/execute/relay, and is
// registered with the output guard. Nothing prints marker values, keys, raw sealed state or wallet data.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256hex } from "./canonical.mjs";
import { createGuard, encodingsOf } from "./guard.mjs";
import { buildPlan, ORIGINAL_VAULT_V2, COMMITTEE_4774, PROTECTED_POLICY_4E62, CUSTODIAN_ENDPOINT } from "./plan.mjs";
import { readJournal, readyToRun, makeEntry, appendEntry } from "./journal.mjs";
import { createMarkerSet, loadMarkerSet, guardPrivateDir, commitmentOf } from "./markers.mjs";
import { loadClient, prepareMutation, prepareSimulation, writePrivate } from "./prepare.mjs";
import { executeTx, simulateRefusal } from "./tx.mjs";
import { createRelay, evalLegacyCheck, evalRelayRefusals, evalClearProof } from "./relay.mjs";
import { probeNonce, probeStale } from "./probe.mjs";
import * as A from "./assert.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MARKER_SETS = { "c1-rev1": ["CANARY_A", "CANARY_B"], "c1-rev2": ["CANARY_A", "CANARY_B"], "c2-legacy": ["CANARY_A", "CANARY_B"], "c2-rev2": ["CANARY_A", "CANARY_B"] };

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const guard = createGuard();
const out = (v) => { guard.check(v, "stdout"); process.stdout.write(JSON.stringify(v, (k, x) => typeof x === "bigint" ? String(x) : x, 1) + "\n"); };

export function loadPins(file) {
  const pins = JSON.parse(fs.readFileSync(file, "utf8"));
  return pins;
}

// The pinned client repo: HEAD commit, clean tracked tree, and every listed file's sha256.
export function checkRepo(pins, git = (args) => execFileSync("git", ["-C", pins.repo.path, ...args], { encoding: "utf8", timeout: 30_000 })) {
  const repo = pins.repo.path;
  if (!path.isAbsolute(repo) || fs.realpathSync(repo) !== repo) throw new Error("repo.path: absolute, non-symlinked");
  if (git(["rev-parse", "HEAD"]).trim() !== pins.repo.commit) throw new Error("repo HEAD is not the pinned commit");
  if (git(["status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("repo has modified tracked files");
  for (const [rel, want] of Object.entries(pins.repo.files)) if (sha256hex(fs.readFileSync(path.join(repo, rel))) !== want) throw new Error(`${rel}: not the pinned file`);
}

function dirs(pins) {
  const run = path.join(ROOT, "runs", pins.runLabel);
  const priv = path.join(ROOT, "private", pins.runLabel);
  for (const d of [path.join(ROOT, "runs"), path.join(ROOT, "private"), run, priv]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  guardPrivateDir(priv);
  return { journal: path.join(run, "journal.jsonl"), priv };
}

function state(pins) {
  const { journal, priv } = dirs(pins);
  const planFor = (obs, ids) => buildPlan(pins, obs, ids);
  const j = readJournal(journal, planFor);
  // every marker set that exists is registered with the guard before anything is printed or journaled
  for (const set of Object.keys(MARKER_SETS)) {
    if (!fs.existsSync(path.join(priv, `markers-${set}.json`))) continue;
    for (const v of Object.values(loadMarkerSet({ dir: priv, set }).values)) guard.register(v);
  }
  return { journal, priv, ...j };
}

function stepOrDie(st, id, kinds) {
  const r = readyToRun(st.plan, st.done, id);
  if (!r.ok) throw new Error(r.reason);
  if (kinds && !kinds.includes(r.step.kind)) throw new Error(`${id} is a ${r.step.kind} step, not ${kinds.join("|")}`);
  return r.step;
}
function journalIt(st, step, res) {
  const entry = makeEntry({ plan: st.plan, head: st.head, seq: st.entries.length, step, outcome: res.outcome, evidence: res.evidence });
  appendEntry(st.journal, entry, guard);
  out({ step: step.id, outcome: res.outcome, reasons: res.reasons, entryHash: entry.entryHash });
}

async function signer(pins, client) {
  const key = process.env[pins.owner.keyEnv];
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(key))) throw new Error(`env ${pins.owner.keyEnv} does not hold an owner key`);
  guard.register(key);
  const { privateKeyToAccount } = await import(pathToFileURL(path.join(pins.repo.path, "node_modules/viem/_esm/accounts/index.js")).href);
  const account = privateKeyToAccount(key);
  if (account.address.toLowerCase() !== pins.owner.address.toLowerCase()) throw new Error("the key in that env var is not the pinned canary owner");
  return account;
}

async function chainOf(pins, client) {
  const { createChainReaderV2 } = await import(pathToFileURL(path.join(pins.repo.path, "custody/v2/chain.mjs")).href);
  const { custodyVaultKind } = await import(pathToFileURL(path.join(pins.repo.path, "network/custody-vaults.mjs")).href);
  const reader = createChainReaderV2({ rpcs: pins.rpcs, vault: ORIGINAL_VAULT_V2, ...custodyVaultKind(ORIGINAL_VAULT_V2), chainId: 8453,
    minAgree: Math.floor(pins.rpcs.length / 2) + 1, confirmations: 2 });
  const pub = pins.rpcs.map((url) => client.viem.createPublicClient({ transport: client.viem.http(url, { timeout: 10_000, retryCount: 0 }) }));
  // balance/nonce: every RPC must answer the same value at the same block, else refuse (no "best of")
  const agreedScalar = async (fn) => {
    const bn = await pub[0].getBlockNumber() - 2n;
    const vals = await Promise.all(pub.map((c) => fn(c, bn)));
    if (vals.some((v) => v !== vals[0])) throw new Error("RPCs disagree on an owner scalar; retry later");
    return vals[0];
  };
  return { reader, pub, agreedScalar };
}

const policyFacts = (client, st) => ({ block: String(st.blockNumber ?? ""), owner: st.policy.owner, policyRev: String(st.policy.policyRev), secretRev: String(st.policy.secretRev),
  committeeId: st.policy.committeeId, paused: st.policy.paused, rulesKeccak: client.viem.keccak256(st.policy.rules),
  bundleKeccak: st.bundle.data.length ? client.viem.keccak256(st.bundle.data) : null, bundleBytes: st.bundle.data.length });

async function main() {
  const cmd = process.argv[2];
  const pins = loadPins(arg("pins"));
  if (cmd !== "plan" && cmd !== "status") checkRepo(pins);
  const st = state(pins);
  if (cmd === "plan" || cmd === "status") {
    return out({ pinsHash: st.plan.pinsHash, statement: st.plan.statement, budget: st.plan.budget, ids: st.ids, journalHead: st.head,
      steps: st.plan.steps.map((s) => ({ id: s.id, kind: s.kind, status: st.done.has(s.id) ? `recorded:${st.done.get(s.id).outcome}` : s.status === "blocked" ? "blocked" : readyToRun(st.plan, st.done, s.id).ok ? "ready" : "waiting", stepHash: s.stepHash, title: s.title, blockedBy: s.blockedBy })) });
  }
  const id = arg("step");
  const client = await loadClient(pins.repo.path);
  const relay = createRelay({ api: pins.relay.api });
  const C = { C1: st.ids.C1, C2: st.ids.C2 };

  if (cmd === "markers") {
    const step = stepOrDie(st, id, ["local"]);
    const commitments = {};
    for (const [set, names] of Object.entries(MARKER_SETS)) {
      const m = createMarkerSet({ dir: st.priv, run: pins.runLabel, set, names });
      for (const v of Object.values(m.values)) guard.register(v);
      commitments[set] = m.commitments;
    }
    return journalIt(st, step, { outcome: "pass", evidence: { commitments } });
  }
  if (cmd === "needles") {
    const set = arg("set");
    const m = loadMarkerSet({ dir: st.priv, set });
    const lines = Object.values(m.values).flatMap((v) => encodingsOf(v));
    const file = writePrivate(st.priv, `needles-${set}-${Date.now()}.txt`, null);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return out({ set, needlesFile: file, needles: lines.length, use: "ssh <host> 'grep -rcFf /dev/stdin <paths> | grep -v :0$ | wc -l' < needlesFile  (counts only)" });
  }
  if (cmd === "read") {
    const step = stepOrDie(st, id, ["read"]);
    const { reader, agreedScalar } = await chainOf(pins, client);
    if (id === "S0.chain" || id === "Z.final") {
      const [vid, com, prot] = await Promise.all([reader.readVaultIdentity(), reader.readCommittee({ committeeId: COMMITTEE_4774 }), reader.readRelease({ id: PROTECTED_POLICY_4E62, endpoint: null })]);
      const ownerBalanceWei = String(await agreedScalar((c, blockNumber) => c.getBalance({ address: pins.owner.address, blockNumber })));
      const ownerNonce = await agreedScalar((c, blockNumber) => c.getTransactionCount({ address: pins.owner.address, blockNumber }));
      const facts = { vaultCodeHash: vid.codeHash, committee: com.committee && { epoch: com.committee.epoch, t: com.committee.t, W: com.committee.W,
        machines: com.committee.machines.map((m) => ({ endpoint: m.endpoint, encKey: m.encKey, measurement: m.measurement })) }, pending: !!com.pending,
        protected: { id: PROTECTED_POLICY_4E62, ...policyFacts(client, prot) }, ownerBalanceWei, ownerNonce };
      if (id === "S0.chain") {
        const resolves = A.evalInventory({ facts, pins, budget: st.plan.budget });
        const ok = Object.values(resolves).every((r) => r.ok);
        return journalIt(st, step, { outcome: ok ? "pass" : "fail", evidence: { facts, resolves } });
      }
      const before = st.done.get("S0.chain").evidence.facts;
      const prot2 = A.evalProtectedUnchanged({ before: before.protected, after: facts.protected });
      const sent = st.entries.filter((e) => e.kind === "mutation" && e.evidence?.txHash).length;
      const nonceDelta = facts.ownerNonce - before.ownerNonce;
      const ok = prot2.outcome === "pass" && JSON.stringify(facts.committee) === JSON.stringify(before.committee);
      return journalIt(st, step, { outcome: ok ? "pass" : "fail", evidence: { facts, protectedUnchanged: prot2.evidence, nonceDelta, transactionsThisJournal: sent,
        note: "nonce delta also counts the CLI's own deployment create/stop transactions" } });
    }
    const which = step.deployment || (id.startsWith("M.") ? "C2" : "C1");
    const dep = C[which];
    const r = await reader.readRelease({ id: dep, endpoint: pins.recipient.endpoint });
    const facts = { id: dep, ...policyFacts(client, r), beneficialOwner: r.beneficialOwner, leaseRunnerIsRecipient: r.lease?.runner === r.endpointId,
      leaseLive: !!r.lease && r.lease.leaseUntil > Math.floor(Date.now() / 1000), relayCustody: (await relay.exists(dep)).custody };
    if (step.resolves?.length) {   // D1.check / D2.check
      const ex = await relay.exists(dep);
      const ok = facts.policyRev === "0" && facts.beneficialOwner === pins.owner.address.toLowerCase() && facts.leaseRunnerIsRecipient && facts.leaseLive && ex.exists === false;
      return journalIt(st, step, { outcome: ok ? "pass" : "fail", evidence: { facts, relayExists: ex.exists, resolves: { [step.resolves[0]]: { ok, note: "owner, policyRev 0, live lease on the recipient, no relay record" } } } });
    }
    const prepStep = step.after[0];
    const prepared = JSON.parse(fs.readFileSync(path.join(st.priv, `prepared-${prepStep}.json`), "utf8"));
    const expect = { policyRev: String(BigInt(prepared.summary.expectPolicyRev) + 1n), secretRev: prepared.summary.nextSecretRev, custodyFlag: true };
    return journalIt(st, step, A.evalPolicyCheck({ facts, expect, ownerAddress: pins.owner.address, prepared }));
  }
  if (cmd === "probe") {
    const step = stepOrDie(st, id, ["probe"]);
    if (id === "S0.custodian") {
      const r = await fetch(`${CUSTODIAN_ENDPOINT}/v2/custody/info`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
      const info = await r.json();
      const { reader } = await chainOf(pins, client);
      const { committee } = await reader.readCommittee({ committeeId: COMMITTEE_4774 });
      const resolves = A.evalCustodianInfo({ info, committee });
      return journalIt(st, step, { outcome: resolves["custodian.info"].ok ? "pass" : "fail",
        evidence: { status: r.status, encKey: info?.encKey ?? null, vault: info?.vault ?? null, resolves } });
    }
    const { reader } = await chainOf(pins, client);
    const r = await reader.readRelease({ id: C.C1, endpoint: pins.recipient.endpoint });
    const cur = { id: C.C1, endpoint: pins.recipient.endpoint, committeeId: COMMITTEE_4774, epoch: r.committee.epoch, policyRev: r.policy.policyRev, secretRev: r.policy.secretRev };
    const res = id === "N.probe.nonce" ? await probeNonce({ base: CUSTODIAN_ENDPOINT, cur }) : await probeStale({ base: CUSTODIAN_ENDPOINT, cur });
    return journalIt(st, step, res);
  }
  if (cmd === "simulate") {
    const step = stepOrDie(st, id, ["simulate"]);
    const { reader, pub } = await chainOf(pins, client);
    const r = await reader.readRelease({ id: step.simulate.id, endpoint: null });
    const sim = prepareSimulation({ client, pins, step, chain: { policy: r.policy } });
    const res = await simulateRefusal({ client: { call: (a) => pub[0].call({ account: a.from, to: a.to, data: a.data }) }, ...sim });
    return journalIt(st, step, res);
  }
  if (cmd === "prepare") {
    const step = stepOrDie(st, id, ["mutation"]);
    const account = await signer(pins, client);
    const { reader, agreedScalar } = await chainOf(pins, client);
    const dep = step.mutation.ids[0];
    const r = await reader.readRelease({ id: dep, endpoint: pins.recipient.endpoint });
    const { committee } = await reader.readCommittee({ committeeId: COMMITTEE_4774 });
    const configText = client.protocol.configTextFromEnvelope(r.lease ? r.lease.envelope : "");
    const ownerNonce = await agreedScalar((c, blockNumber) => c.getTransactionCount({ address: account.address, blockNumber }));
    let env = null;
    if (step.mutation.bundle?.startsWith("relay:")) {     // migration: the relay's values, proven equal to the local markers first
      const set = step.mutation.bundle.slice(6), m = loadMarkerSet({ dir: st.priv, set });
      const got = await relay.getValuesForMigration(dep, account);
      const same = Object.keys(got.env).length === Object.keys(m.values).length && Object.entries(got.env).every(([k, v]) => m.values[k] !== undefined
        && commitmentOf({ run: pins.runLabel, set, name: k, value: v }) === m.commitments[k]);
      if (!same) throw new Error("the relay's values are not the c2-legacy markers: nothing prepared");
      env = got.env;
    } else if (step.mutation.bundle) env = loadMarkerSet({ dir: st.priv, set: step.mutation.bundle }).values;
    const { prepared, tx } = prepareMutation({ client, pins, step, chain: { block: { number: String(r.blockNumber ?? "") }, policy: r.policy, committee, configText, ownerNonce }, env });
    writePrivate(st.priv, `prepared-${step.id}.json`, { ...prepared, tx });
    return out({ step: step.id, preparedHash: prepared.preparedHash, summary: prepared.summary, gasCap: step.mutation.gasCap, maxCostWei: step.mutation.maxCostWei,
      next: `node driver/cli.mjs execute --pins <pins> --step ${step.id} --confirm ${prepared.preparedHash}` });
  }
  if (cmd === "execute") {
    const step = stepOrDie(st, id, ["mutation"]);
    const rec = JSON.parse(fs.readFileSync(path.join(st.priv, `prepared-${step.id}.json`), "utf8"), (k, v) => typeof v === "string" && v.startsWith("n:") ? BigInt(v.slice(2)) : v);
    const { tx, ...prepared } = rec;
    const account = await signer(pins, client);
    const pub = client.viem.createPublicClient({ transport: client.viem.http(pins.sendRpc, { timeout: 15_000, retryCount: 0 }) });
    const wallet = client.viem.createWalletClient({ account, transport: client.viem.http(pins.sendRpc, { timeout: 15_000, retryCount: 0 }) });
    const adapter = {
      getBalance: (a) => pub.getBalance(a), call: (a) => pub.call({ account: a.from, to: a.to, data: a.data }),
      estimateGas: (a) => pub.estimateGas({ account: a.from, to: a.to, data: a.data }), getGasPrice: () => pub.getGasPrice(),
      getTransactionCount: (a) => pub.getTransactionCount(a),
      sendTransaction: (t) => wallet.sendTransaction({ to: t.to, data: t.data, value: 0n, gas: t.gas, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas, nonce: t.nonce, chain: null }),
      waitForReceipt: (hash, timeout) => pub.waitForTransactionReceipt({ hash, timeout }),
    };
    const res = await executeTx({ step, prepared, selector: prepared.selector, tx, confirm: arg("confirm"), client: adapter });
    return journalIt(st, step, { ...res, evidence: { ...res.evidence, preparedHash: prepared.preparedHash, summary: prepared.summary } });
  }
  if (cmd === "relay") {
    const step = stepOrDie(st, id, ["relay"]);
    if (arg("confirm") !== step.stepHash) throw new Error(`--confirm must equal ${step.stepHash}`);
    const account = await signer(pins, client);
    if (id === "N.relay") {
      const { generatePrivateKey, privateKeyToAccount } = await import(pathToFileURL(path.join(pins.repo.path, "node_modules/viem/_esm/accounts/index.js")).href);
      const throwaway = generatePrivateKey(); guard.register(throwaway);
      const heldSet = await relay.put(C.C1, account, { set: { CANARY_REFUSED: "refused-" + sha256hex(throwaway).slice(0, 32) } });
      const strangerGet = await relay.getMeta(C.C1, privateKeyToAccount(throwaway));
      return journalIt(st, step, evalRelayRefusals({ heldSet, strangerGet, exists: await relay.exists(C.C1) }));
    }
    if (id === "M.legacy.set") {
      const m = loadMarkerSet({ dir: st.priv, set: "c2-legacy" });
      const r = await relay.put(C.C2, account, { set: m.values });
      return journalIt(st, step, { outcome: r.status === 200 ? "pass" : "fail", evidence: { status: r.status, error: r.error, names: Object.keys(m.values).sort(), commitments: m.commitments } });
    }
    if (id === "M.legacy.check") {
      const m = loadMarkerSet({ dir: st.priv, set: "c2-legacy" });
      const meta = await relay.getMeta(C.C2, account, { run: pins.runLabel, set: "c2-legacy", values: m.values });
      return journalIt(st, step, evalLegacyCheck({ meta, exists: await relay.exists(C.C2), markerNames: Object.keys(m.values) }));
    }
    if (id === "M.clear") {
      const ex = await relay.exists(C.C2);
      if (!ex.custody) return journalIt(st, step, { outcome: "fail", evidence: { exists: ex, note: "relay does not report custody:true; nothing cleared (re-run is impossible: a new plan step is needed)" } });
      const r = await relay.put(C.C2, account, { clear: true });
      const after = await relay.getMeta(C.C2, account);
      return journalIt(st, step, { outcome: r.status === 200 ? "pass" : "fail", evidence: { status: r.status, error: r.error, ownerGetAfter: { status: after.status, names: after.names, rev: after.rev } } });
    }
    throw new Error(`no relay handler for ${id}`);
  }
  if (cmd === "record") {
    const step = stepOrDie(st, id, ["operator", "hardware"]);
    if (arg("confirm") !== step.stepHash) throw new Error(`--confirm must equal ${step.stepHash}`);
    const obs = JSON.parse(fs.readFileSync(arg("obs"), "utf8"));
    guard.check(obs, "observation");
    let res;
    if (step.learns) {
      const ok = /^0x[0-9a-f]{64}$/.test(String(obs.deploymentId)) && obs.deploymentId !== PROTECTED_POLICY_4E62 && !Object.values(C).includes(obs.deploymentId);
      res = { outcome: ok ? "pass" : "fail", evidence: { deploymentId: obs.deploymentId, createTx: obs.createTx, gasUsed: obs.gasUsed, command: obs.command } };
    } else if (id === "S0.root") {
      const ok = (k) => ({ ok: obs[k]?.ok === true, note: String(obs[k]?.note || "").slice(0, 300) });
      res = { outcome: "pass", evidence: { resolves: { "recipient.runner": ok("recipientRunner"), "recipient.billing": ok("billing"), "relay.v2aware": ok("relay"), "hw.oneGuest": ok("oneGuest") } } };
      if (!Object.values(res.evidence.resolves).every((r) => r.ok)) res.outcome = "fail";
    } else if (step.expectRelease || step.expectRefusal) {
      const dep = C[id.startsWith("M.") ? "C2" : "C1"];
      const lines = A.filterLines({ frontLog: fs.readFileSync(obs.frontLog, "utf8"), custodianLog: fs.readFileSync(obs.custodianLog, "utf8"), id: dep });
      res = step.expectRelease ? A.evalRelease({ id: dep, obs: { lines, appAnswered: obs.appAnswered }, expect: step.expectRelease, imageMeasurement: pins.image.measurement })
        : A.evalRefusal({ id: dep, obs: { lines, appAnswered: obs.appAnswered }, expect: step.expectRefusal });
    } else if (step.markerSets && id !== "M.clear.proof") {
      res = A.evalMarkerSearch({ sets: step.markerSets, counts: obs.counts, control: obs.control, locations: obs.locations });
    } else if (id === "M.clear.proof") {
      const markerSearch = A.evalMarkerSearch({ sets: step.markerSets, counts: obs.counts, control: obs.control, locations: obs.locations });
      res = evalClearProof({ ownerGet: st.done.get("M.clear").evidence.ownerGetAfter, hasIdOnRelayHost: obs.hasIdOnRelayHost, markerSearch, retentionListed: obs.retentionListed });
    } else if (step.command) {
      res = { outcome: obs.ok === true ? "pass" : "fail", evidence: { command: step.command, tx: obs.tx ?? null, note: String(obs.note || "").slice(0, 300) } };
    } else throw new Error(`${id}: no recorder (blocked or not an operator step)`);
    return journalIt(st, step, res);
  }
  throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { try { guard.check(e.message, "error"); console.error(`REFUSED: ${e.message}`); } catch { console.error("REFUSED: (message withheld: it contained guarded material)"); } process.exit(1); });
