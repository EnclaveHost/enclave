#!/usr/bin/env node
// check-proof-agent.mjs <dir> -- the offline check of the posting agent's device run (cpu/proof-agent-run.mjs; runner/
// proof-agent.mjs; LAB). Coverage comes from the run's OWN records, and this file holds its own copy of the plan, so a run that
// skipped or reordered a step cannot pass by describing itself:
//   - steps.jsonl: exactly the PLAN below, in order, each with an outcome of the kind it names;
//   - the carrier: every exchange the agent made (proxy.jsonl) is the hub's recorded exchange with the VM (evidence/NNN), the
//     same request bytes and the same answer, one to one; the one exception is the replay step, where the answer the agent was
//     HANDED is byte-equal to an earlier genuine answer and not the VM's answer to that request;
//   - every statement RE-VERIFIED (verifyPvmProofKey) over its own request's nonce under Google's roots and the build's pins,
//     for this deployment and the VM's logged instance; its proof key the one the VM logged at both boots, vouched for by
//     another transport key after the restart;
//   - every checkpoint the agent accepted RE-VERIFIED (verifyPvmCheckpoint) against that key, and equal to the request it
//     answers; every transaction's hash is keccak256 of its journaled bytes, which decode to a checkpoint call (or a cancel)
//     signed by the operator at the journaled nonce, carrying exactly that checkpoint;
//   - every landing: a successful, still-canonical receipt from the operator with a Checkpointed event for this deployment and
//     the journal's provenUntil, strictly increasing; the replacement, reorganization, crash recovery and fresh-proof steps
//     each shown by the records they must leave (see each check).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const { verifyPvmProofKey } = await import(path.join(REPO, "relay/pvm-app-attest.mjs"));
const { verifyPvmCheckpoint } = await import(path.join(REPO, "relay/pvm-checkpoint.mjs"));
const V = await import(path.join(REPO, "node_modules/viem/_esm/index.js")).catch(() => import("viem"));
const d = path.resolve(process.argv[2] || ".");
const fails = [];
const expect = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const rd = (f) => { try { return fs.readFileSync(path.join(d, f), "utf8"); } catch { return null; } };
const jl = (f) => (rd(f) || "").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l.slice(0, 60) }; } });
const PLAN = [
  ["start-a", ["attested"]], ["unclaimed", ["not-our-lease"]], ["a1", ["landed"]], ["replay", ["checkpoint-refused"]], ["replace", ["landed"]],
  ["reorg", ["landed"]], ["crash", ["stuck"]], ["recover", ["landed"]], ["stuck", ["stuck"]], ["fresh", ["landed"]], ["start-b", ["attested"]], ["b1", ["landed"]],
];
const POT_ABI = V.parseAbi(["function checkpoint(bytes32 id, bytes32 enclaveId, uint64 upto, uint64 anchorBlock, bytes32 anchorHash, bytes sig)"]);
let run = null; try { run = JSON.parse(rd("run.json")); } catch {}
expect(!!run && /^0x[0-9a-f]{64}$/.test(run.pins?.deployment || ""), "run.json names the lease the VM was pinned to");
if (!run) { console.log("FAIL cannot continue without run.json"); process.exit(1); }
const pins = run.pins, D = pins.deployment, OP = pins.operator, POT = run.addresses.proofOfTime.toLowerCase();

// ---- the plan ----
const steps = jl("steps.jsonl");
expect(steps.length === PLAN.length && steps.every((s, i) => s.step === PLAN[i][0] && s.n === i + 1 && PLAN[i][1].includes(s.outcome && s.outcome.kind) && s.ok === true),
       `steps: exactly the plan's ${PLAN.length} steps, in order, each with the outcome it names (${steps.map((s) => `${s.step}=${s.outcome && s.outcome.kind}`).join(" ")})`);
const S = Object.fromEntries(steps.map((s) => [s.step, s.outcome]));

// ---- the VM's own facts ----
const vm = (p) => { const c = rd(`vm/${p}.log`) || ""; return { instance: (/INSTANCE id=([0-9a-f]{64})/.exec(c) || [])[1], proofKey: (/PROOF key=(0x[0-9a-f]{40})/.exec(c) || [])[1], pins: /PROOFPINS accepted/.test(c) }; };
const A = vm("a"), B = vm("b");
console.log(`-- the VM's logged facts: A ${JSON.stringify(A)}  B ${JSON.stringify(B)}`);
expect(A.pins && B.pins && A.proofKey && A.proofKey === B.proofKey && A.instance && A.instance === B.instance, "both boots took the pins and logged the SAME instance and proof key");

// ---- the carrier: the agent's exchanges are the hub's, one to one ----
const px = jl("proxy.jsonl");
const hubN = fs.existsSync(path.join(d, "evidence")) ? fs.readdirSync(path.join(d, "evidence")).filter((f) => f.endsWith(".request")).length : 0;
expect(px.length > 0 && px.length === hubN && px.every((x, i) => x.n === i + 1), `carrier: the agent's ${px.length} exchanges and the hub's ${hubN} recorded exchanges, numbered 1..n`);
let linked = 0;
px.forEach((x, i) => {
  const n = String(i + 1).padStart(3, "0"), req = rd(`evidence/evidence-${n}.request`), ans = rd(`evidence/evidence-${n}.json`);
  if (req !== null && req.trim() === x.request && ans === x.answer) linked++;
});
expect(linked === px.length, `carrier: each exchange carried exactly the request and the answer the hub recorded (${linked}/${px.length})`);
const handed = (x) => (x.mode ? x.handed : x.answer);
const replayed = px.filter((x) => x.mode);
expect(replayed.length === 1 && replayed[0].step === "replay" && replayed[0].mode === "replayed-previous-answer"
       && px.some((y) => y.n < replayed[0].n && y.answer === replayed[0].handed) && replayed[0].handed !== replayed[0].answer,
       "replay: exactly one answer was swapped, in the replay step, for an EARLIER genuine answer (not the VM's answer to that request)");

// ---- statements ----
const firstLine = (s) => { try { return JSON.parse(String(s).split("\n")[0]); } catch { return null; } };
const statements = px.filter((x) => x.request.startsWith("PROOFKEY "));
let key = null; const spkis = {};
for (const x of statements) {
  const nonce = x.request.slice(9), doc = firstLine(handed(x));
  const v = verifyPvmProofKey(doc, { nonce, appId: run.app, allowedRuntimeIds: [run.runtimeId], allowedCodeHashes: [run.code], allowedAuthorityHashes: [run.authority],
                                     rootPins: run.googleRootPins, instanceIds: [A.instance], deployment: D });
  const same = v.ok && ["chainId", "proofOfTime", "registry", "deployment", "enclaveId", "operator"].every((k) => v.claims[k] === pins[k]);
  expect(v.ok && same && v.claims.proofKey === A.proofKey, `statement ${x.n} (${x.step}): re-verifies over its own nonce, names the run's pins, attests the key the VM logged${v.ok ? "" : ` -- ${v.reasons.at(-1)}`}`);
  if (v.ok) { key = v.claims.proofKey; (spkis[x.step === "start-b" ? "b" : "a"] = spkis[x.step === "start-b" ? "b" : "a"] || new Set()).add(doc.evidence.spki); }
}
expect(statements.some((x) => x.step === "start-b") && spkis.a && spkis.b && [...spkis.b].every((k) => !spkis.a.has(k)), "restart: boot B's statement is vouched for by another transport key, for the SAME proof key");

// ---- the journal: accepted checkpoints and the transactions carrying them ----
const J = jl("journal.jsonl");
const signed = J.filter((e) => e.ev === "signed"), txs = J.filter((e) => e.ev === "tx"), dones = J.filter((e) => e.ev === "done");
const cpAsks = px.filter((x) => x.request.startsWith("CHECKPOINT "));
let sOk = 0;
for (const s of signed) {
  const c = s.checkpoint, want = `CHECKPOINT ${c.upto} ${c.anchorBlock} ${c.anchorHash.slice(2)}`;
  const xs = cpAsks.filter((x) => x.request === want);
  const doc = xs.length === 1 ? firstLine(handed(xs[0])) : null;
  const v = doc ? await verifyPvmCheckpoint(doc, { pins, proofKey: key }) : { ok: false };
  if (xs.length === 1 && v.ok && doc.sig === c.sig && v.checkpoint.digest === c.digest && String(v.checkpoint.upto) === c.upto) sOk++;
  else console.log(`   (signed ${c.digest.slice(0, 18)}…: ${xs.length} exchanges, ${v.ok ? "verifies" : "does not verify"})`);
}
expect(signed.length > 0 && sOk === signed.length, `journal: every checkpoint the agent accepted is one carrier answer to exactly its request, re-verified under the attested key (${sOk}/${signed.length})`);
const unsigned = cpAsks.filter((x) => !signed.some((s) => x.request === `CHECKPOINT ${s.checkpoint.upto} ${s.checkpoint.anchorBlock} ${s.checkpoint.anchorHash.slice(2)}`));
expect(unsigned.length === 1 && unsigned[0].step === "replay", `journal: the only CHECKPOINT answer the agent did not accept is the replayed one (${unsigned.map((x) => x.step).join(",")})`);
let tOk = 0; const txInfo = {};
for (const t of txs) {
  try {
    const tx = V.parseTransaction(t.raw), from = (await V.recoverTransactionAddress({ serializedTransaction: t.raw })).toLowerCase();
    const s = signed.find((e) => e.checkpoint.digest === t.digest);
    let okData;
    if (t.cancel) okData = tx.to.toLowerCase() === OP && (tx.value || 0n) === 0n && (!tx.data || tx.data === "0x");
    else {
      const f = V.decodeFunctionData({ abi: POT_ABI, data: tx.data });
      const c = s && s.checkpoint;
      okData = tx.to.toLowerCase() === POT && f.functionName === "checkpoint" && !!c && f.args[0] === c.id && f.args[1] === c.enclaveId && String(f.args[2]) === c.upto
        && String(f.args[3]) === c.anchorBlock && f.args[4] === c.anchorHash && f.args[5] === c.sig;
    }
    txInfo[t.hash] = { nonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas, digest: t.digest };
    if (V.keccak256(t.raw) === t.hash && from === OP && tx.nonce === t.nonce && String(tx.maxFeePerGas) === t.maxFeePerGas && okData) tOk++;
  } catch (e) { console.log(`   (tx ${t.hash.slice(0, 18)}…: ${e.message.slice(0, 80)})`); }
}
expect(txs.length > 0 && tOk === txs.length, `transactions: each journaled hash is keccak256 of its bytes, signed by the operator at the journaled nonce, carrying exactly its checkpoint (${tOk}/${txs.length})`);

// ---- landings ----
const R = Object.fromEntries(jl("receipts.jsonl").map((r) => [r.hash, r]));
expect(txs.every((t) => R[t.hash] !== undefined), "receipts: every journaled transaction was looked up before the chain stopped");
const landed = dones.filter((e) => e.kind === "landed");
let lOk = 0, prev = 0n;
for (const l of landed) {
  const r = R[l.hash], ev = r && r.checkpointed.find((c) => c.id === D);
  if (r && r.receipt && r.receipt.status === "success" && r.receipt.canonical && r.receipt.from === OP && r.receipt.blockHash === l.blockHash && ev
      && ev.provenUntil === l.provenUntil && ev.enclaveId === pins.enclaveId && ev.operator === OP && BigInt(l.provenUntil) > prev) { lOk++; prev = BigInt(l.provenUntil); }
  else console.log(`   (landed ${l.hash.slice(0, 18)}…: receipt ${JSON.stringify(r && r.receipt)}, events ${JSON.stringify(r && r.checkpointed)})`);
}
const planLanded = PLAN.filter((p) => p[1].includes("landed")).length;
expect(landed.length === planLanded && lOk === landed.length, `landings: ${landed.length} (the plan's ${planLanded}), each a successful canonical receipt from the operator with this deployment's Checkpointed event and the journal's provenUntil, strictly increasing`);
const onChain = Object.values(R).flatMap((r) => (r.receipt && r.receipt.status === "success" ? r.checkpointed.filter((c) => c.id === D) : []));
expect(onChain.length === landed.length, `landings: no Checkpointed event on chain that the journal does not record as landed (${onChain.length})`);

// ---- the special steps, each by the records it must leave ----
const byStep = (st) => steps.find((s) => s.step === st)?.outcome || {};
expect(!px.some((x) => x.step === "unclaimed" && x.request.startsWith("CHECKPOINT")), "unclaimed: the VM was not asked for a proof while the lease was not the runner's");
{ const o = byStep("replay"); expect(/replayed or crossed/.test(o.reason || ""), `replay: refused as a replayed or crossed answer (${o.reason})`); }
{ const o = byStep("replace"), same = txs.filter((t) => txInfo[t.hash] && txInfo[t.hash].nonce === o.nonce && txInfo[t.hash].digest === dones.find((e) => e.hash === o.hash && e.kind === "landed")?.digest);
  const bids = same.map((t) => BigInt(t.maxFeePerGas));
  expect(same.length >= 2 && bids.every((b, i) => i === 0 || b * 100n >= bids[i - 1] * 125n) && same.filter((t) => R[t.hash] && R[t.hash].receipt).length === 1,
         `replace: ${same.length} transactions at nonce ${o.nonce}, each bidding >= 25 % more than the last, exactly one mined`); }
{ const o = byStep("reorg"), ro = J.find((e) => e.ev === "reorg"), rc = jl("chain.jsonl").find((e) => e.label === "reorganized");
  expect(!!ro && !!rc && ro.hash === o.hash && rc.hash === o.hash && ro.was === rc.removedBlockHash && o.blockHash !== rc.removedBlockHash,
         "reorg: the block holding the proof was reorganized away, the agent noticed, and the SAME bytes landed in another block"); }
{ const o = byStep("recover"), sw = jl("chain.jsonl").filter((e) => e.label === "swallowed-send" && e.step === "crash");
  expect(sw.length === 1 && o.hash === sw[0].hash && J.some((e) => e.ev === "recover") && !px.some((x) => x.step === "recover" && x.request.startsWith("CHECKPOINT")),
         "crash/recover: the transaction in flight when the agent stopped (never delivered) is the one the next agent rebroadcast and landed, asking the VM for nothing new"); }
{ const sk = byStep("stuck"), fr = byStep("fresh"), stuckTx = txs.filter((t) => txInfo[t.hash] && txInfo[t.hash].nonce === sk.nonce && t.digest !== (dones.find((e) => e.hash === fr.hash)?.digest));
  const frTx = txs.find((t) => t.hash === fr.hash);
  expect(fr.nonce === sk.nonce && stuckTx.length >= 1 && stuckTx.every((t) => R[t.hash] && R[t.hash].receipt === null) && !!frTx
         && BigInt(frTx.maxFeePerGas) * 100n >= BigInt(stuckTx.at(-1).maxFeePerGas) * 125n && frTx.digest !== stuckTx[0].digest,
         `stuck/fresh: a FRESH proof took the stuck nonce ${sk.nonce}, outbidding the ${stuckTx.length} undelivered transaction(s) there`); }

// ---- no keys ----
const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => walk(path.join(p, f))) : [p];
const files = walk(d);
expect(!files.some((f) => /"?privateKey"?\s*[:=]/.test(fs.readFileSync(f, "utf8"))), "no private key field anywhere in the results");
expect(/the operator key appears nowhere in the results/.test(rd("run.log") || ""), "the run scanned its own results for the operator key and found none");
console.log(fails.length ? `FAIL ${fails.length} check(s)` : "PASS the posting agent on the device");
process.exitCode = fails.length ? 1 : 0;
