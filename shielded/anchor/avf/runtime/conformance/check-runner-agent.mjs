#!/usr/bin/env node
// check-runner-agent.mjs <dir> -- the offline check of the runner LIFECYCLE agent's device run (cpu/runner-agent-run.mjs;
// runner/runner-agent.mjs; RUNNER-AGENT.md; LAB). Its own copy of what each step must show -- the run's `ok` flags are not
// trusted -- and coverage from the run's OWN records:
//   - steps.jsonl: start, register, claim, prove-1, heartbeat, renew, approach-* (0 or more), renew-interrupted,
//     renew-recovered, after-renew, release -- in that order, each with the outcome it names;
//   - the carrier: every exchange the agent made (proxy.jsonl) is the hub's recorded exchange with the VM, one to one;
//   - every statement RE-VERIFIED (verifyPvmProofKey) over its own nonce; its key the one the VM logged;
//   - every accepted checkpoint RE-VERIFIED (verifyPvmCheckpoint) and equal to its request; every transaction's hash is
//     keccak256 of its journaled bytes, signed by the operator at its nonce, and its call is exactly its journaled intent or
//     checkpoint;
//   - the chain's own events (chain-events.jsonl), reconciled with the journal both ways: every ProofKeySet names the
//     ATTESTED key; one Registered, one Claimed; exactly two Renewed (the ordinary one and the recovered one); one Heartbeat
//     per journaled heartbeat; one Released, after the last Checkpointed; every event's transaction a journaled landing;
//   - the interrupted renew: the transaction never delivered (chain.jsonl) is the one the restarted agent landed, the VM was
//     asked for no proof by the recovery, and the tenant's balance fell by exactly that renew's burn.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const { verifyPvmProofKey } = await import(path.join(REPO, "relay/pvm-app-attest.mjs"));
const { verifyPvmCheckpoint } = await import(path.join(REPO, "relay/pvm-checkpoint.mjs"));
const V = await import("viem");
const d = path.resolve(process.argv[2] || ".");
const fails = [];
const expect = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const rd = (f) => { try { return fs.readFileSync(path.join(d, f), "utf8"); } catch { return null; } };
const jl = (f) => (rd(f) || "").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l.slice(0, 60) }; } });
let run = null; try { run = JSON.parse(rd("run.json")); } catch {}
expect(!!run && /^0x[0-9a-f]{64}$/.test(run.pins?.deployment || ""), "run.json names the lease");
if (!run) { console.log("FAIL cannot continue without run.json"); process.exit(1); }
const pins = run.pins, D = pins.deployment, E = pins.enclaveId, OP = pins.operator;
const addr = { registry: run.addresses.registry.toLowerCase(), ledger: run.addresses.ledger.toLowerCase(), prover: run.addresses.proofOfTime.toLowerCase() };

// ---- the steps, by this checker's own expectations ----
const S = jl("steps.jsonl"), names = S.map((s) => s.step);
const order = ["start", "register", "claim", "prove-1", "heartbeat", "renew"], tail = ["renew-interrupted", "renew-recovered", "after-renew", "release", "payout"];
const approaches = names.slice(order.length, names.length - tail.length);
expect(order.every((n, i) => names[i] === n) && tail.every((n, i) => names[names.length - tail.length + i] === n) && approaches.every((n, i) => n === `approach-${i}`),
       `steps: ${order.join(", ")}, ${approaches.length} approach step(s), ${tail.join(", ")} -- in that order (${names.join(" ")})`);
const st = Object.fromEntries(S.map((s) => [s.step, s]));
const lop = (s) => (s && s.lifecycle ? s.lifecycle.op : null), lk = (s) => (s && s.lifecycle ? s.lifecycle.kind : null), pk = (s) => (s && s.proof ? s.proof.kind : null);
const vmLog = rd("vm/a.log") || "", VM = { instance: (/INSTANCE id=([0-9a-f]{64})/.exec(vmLog) || [])[1], proofKey: (/PROOF key=(0x[0-9a-f]{40})/.exec(vmLog) || [])[1] };
expect(!!VM.instance && !!VM.proofKey && st.start && st.start.attested && st.start.attested.proofKey === VM.proofKey, `start: the agent attested the key the VM logged (${VM.proofKey})`);
expect(lk(st.register) === "landed" && /^register/.test(lop(st.register) || "") && pk(st.register) === "not-our-lease", "register: the agent registered, and asked no proof before holding the lease");
expect(lk(st.claim) === "landed" && lop(st.claim) === "claim", "claim: the agent claimed the lease");
expect(lk(st["prove-1"]) === null && pk(st["prove-1"]) === "landed", "prove-1: nothing due but a proof, which landed");
expect(lk(st.heartbeat) === "landed" && lop(st.heartbeat) === "heartbeat" && pk(st.heartbeat) === "landed", "heartbeat: sent when due, and the proof landed");
expect(lk(st.renew) === "landed" && lop(st.renew) === "renew" && pk(st.renew) === "landed", "renew: inside the margin with a recent proof, renewed; the proof landed");
expect(approaches.every((n) => (lk(st[n]) === null || (lk(st[n]) === "landed" && lop(st[n]) === "heartbeat")) && pk(st[n]) === "landed"), "approach: only proofs (and a due heartbeat) on the way back to the margin -- no renew");
expect(st["renew-interrupted"] && st["renew-interrupted"].kind === "in-flight" && lop(st["renew-interrupted"]) === "renew", "renew-interrupted: the renew was left in flight when the agent stopped");
const rr = st["renew-recovered"] || {};
expect(rr.recovered && rr.recovered.op === "renew" && rr.recovered.kind === "landed", "renew-recovered: the restarted agent landed the journaled renew");
expect(lop(st["after-renew"]) !== "renew" && pk(st["after-renew"]) === "landed", "after-renew: no second renew; the proof landed");
expect(st.release && st.release.outcome && st.release.outcome.kind === "released" && st.release.outcome.proof && st.release.outcome.proof.kind === "landed", "release: a final proof, then released");
expect(lk(st.payout) === "landed" && lop(st.payout) === "withdrawEarnings", "payout: the earnings were withdrawn");

// ---- the carrier: the agent's exchanges are the hub's ----
const px = jl("proxy.jsonl");
const hubN = fs.existsSync(path.join(d, "evidence")) ? fs.readdirSync(path.join(d, "evidence")).filter((f) => f.endsWith(".request")).length : 0;
let linked = 0;
px.forEach((x, i) => { const n = String(i + 1).padStart(3, "0"); if ((rd(`evidence/evidence-${n}.request`) || "").trim() === x.request && rd(`evidence/evidence-${n}.json`) === x.answer) linked++; });
expect(px.length > 0 && px.length === hubN && linked === px.length, `carrier: the agent's ${px.length} exchanges are the hub's ${hubN}, request and answer, one to one (${linked})`);
const first = (s) => { try { return JSON.parse(String(s).split("\n")[0]); } catch { return null; } };
let sOk = 0; const sts = px.filter((x) => x.request.startsWith("PROOFKEY "));
for (const x of sts) {
  const v = verifyPvmProofKey(first(x.answer), { nonce: x.request.slice(9), appId: run.app, allowedRuntimeIds: [run.runtimeId], allowedCodeHashes: [run.code], allowedAuthorityHashes: [run.authority],
                                                  rootPins: run.googleRootPins, instanceIds: [VM.instance], deployment: D });
  if (v.ok && v.claims.proofKey === VM.proofKey && ["chainId", "proofOfTime", "registry", "deployment", "enclaveId", "operator"].every((k) => v.claims[k] === pins[k])) sOk++;
}
expect(sts.length >= 3 && sOk === sts.length, `statements: all ${sts.length} re-verify over their own nonces, for this lease, attesting the key the VM logged (${sOk})`);

// ---- the journal ----
const J = jl("journal.jsonl");
const signed = J.filter((e) => e.ev === "signed"), intents = J.filter((e) => e.ev === "intent"), txs = J.filter((e) => e.ev === "tx"), dones = J.filter((e) => e.ev === "done");
let cOk = 0;
for (const s of signed) {
  const c = s.checkpoint, xs = px.filter((x) => x.request === `CHECKPOINT ${c.upto} ${c.anchorBlock} ${c.anchorHash.slice(2)}`);
  const doc = xs.length === 1 ? first(xs[0].answer) : null, v = doc ? await verifyPvmCheckpoint(doc, { pins, proofKey: VM.proofKey }) : { ok: false };
  if (v.ok && doc.sig === c.sig && v.checkpoint.digest === c.digest) cOk++;
}
expect(signed.length > 0 && cOk === signed.length, `checkpoints: each accepted one is one VM answer to exactly its request, re-verified (${cOk}/${signed.length})`);
const POT = V.parseAbi(["function checkpoint(bytes32 id, bytes32 enclaveId, uint64 upto, uint64 anchorBlock, bytes32 anchorHash, bytes sig)"]);
let tOk = 0; const byHash = {};
for (const t of txs) {
  try {
    const tx = V.parseTransaction(t.raw), from = (await V.recoverTransactionAddress({ serializedTransaction: t.raw })).toLowerCase();
    const s = signed.find((e) => e.checkpoint.digest === t.digest), it = intents.find((e) => e.call.digest === t.digest);
    let okCall = false;
    if (s) { const f = V.decodeFunctionData({ abi: POT, data: tx.data }), c = s.checkpoint;
      okCall = tx.to.toLowerCase() === addr.prover && f.args[0] === c.id && String(f.args[2]) === c.upto && f.args[4] === c.anchorHash && f.args[5] === c.sig; }
    else if (it) okCall = tx.to.toLowerCase() === it.call.to && tx.data === it.call.data;
    byHash[t.hash] = { op: it ? it.call.op : "checkpoint", digest: t.digest };
    if (V.keccak256(t.raw) === t.hash && from === OP && tx.nonce === t.nonce && okCall) tOk++;
  } catch {}
}
expect(txs.length > 0 && tOk === txs.length, `transactions: each is keccak256 of its journaled bytes, from the operator at its nonce, carrying exactly its intent or checkpoint (${tOk}/${txs.length})`);

// ---- the chain's events, reconciled with the journal ----
const EV = jl("chain-events.jsonl"), R = Object.fromEntries(jl("receipts.jsonl").map((r) => [r.hash, r]));
const landed = new Map(dones.filter((e) => e.kind === "landed").map((e) => [e.hash, e]));
const ofEvent = (n) => EV.filter((e) => e.event === n);
expect(ofEvent("ProofKeySet").length >= 1 && ofEvent("ProofKeySet").every((e) => e.args.id === E && e.args.proofKey.toLowerCase() === VM.proofKey),
       `registry: every ProofKeySet for this runner names the ATTESTED key (${ofEvent("ProofKeySet").length})`);
expect(ofEvent("Registered").length === 1 && ofEvent("Claimed").length === 1 && ofEvent("Claimed")[0].args.enclaveId === E && ofEvent("Claimed")[0].args.operator.toLowerCase() === OP,
       "one Registered; one Claimed, by this runner and operator");
const hb = [...landed.values()].filter((e) => e.op === "heartbeat");
expect(ofEvent("Renewed").length === 2 && ofEvent("Heartbeat").length === hb.length && hb.length >= 1, `exactly two Renewed (ordinary + recovered); ${hb.length} Heartbeat(s), one per journaled heartbeat`);
const rel = ofEvent("Released"), cps = ofEvent("Checkpointed");
expect(rel.length === 1 && cps.length >= 1 && BigInt(rel[0].block) > BigInt(cps.at(-1).block), "one Released, mined after the last Checkpointed");
// the published measurement is EXACTLY the build the VM attests (register uses the fresh statement's claims.codeHash)
expect(ofEvent("Updated").length >= 1 && ofEvent("Updated").every((e) => e.args.id === E && e.args.measurement === "0x" + run.code),
       `registry: the published measurement is exactly the attested build 0x${run.code.slice(0, 16)}… (${ofEvent("Updated").length})`);
const wd = ofEvent("EarningsWithdrawn"), po = jl("chain.jsonl").find((e) => e.label === "payout") || {};
expect(wd.length === 1 && wd[0].args.operator.toLowerCase() === OP && wd[0].args.to.toLowerCase() === (run.labPayout || {}).to && String(wd[0].args.amount6) === po.earnedBefore
       && po.balanceAfter === po.earnedBefore && po.earnedAfter === "0" && BigInt(po.earnedBefore || 0) > 0n,
       `payout: one withdrawal of all ${po.earnedBefore} earned, from the operator to the owner's payout address`);
const lifecycleEvents = EV.filter((e) => e.event !== "Updated" && e.event !== "ProofKeySet" && e.event !== "Deregistered");
expect(lifecycleEvents.every((e) => landed.has(e.tx)) && [...landed.keys()].every((h) => EV.some((e) => e.tx === h)),
       `every event's transaction is a journaled landing, and every landing has its event (${lifecycleEvents.length} events, ${landed.size} landings)`);
expect([...landed.keys()].every((h) => R[h] && R[h].receipt && R[h].receipt.status === "success" && R[h].receipt.canonical && R[h].receipt.from === OP),
       "every landing: a successful, canonical receipt from the operator");
const fin = jl("chain.jsonl").find((e) => e.label === "final");
expect(!!fin && fin.runner === "0x" + "00".repeat(32), "the lease is released on the ledger");

// ---- the interrupted renew ----
const sw = jl("chain.jsonl").filter((e) => e.label === "swallowed-send" && e.step === "renew-interrupted");
const rec = rr.recovered || {}, ren = ofEvent("Renewed").find((e) => e.tx === rec.hash);
expect(sw.length === 1 && rec.hash === sw[0].hash && !!ren, "renew: the transaction never delivered is exactly the one the restarted agent landed (its Renewed event)");
expect(!px.some((x) => x.step === "renew-recovered" && x.request.startsWith("CHECKPOINT")), "renew: the recovery asked the VM for no proof");
expect(!!ren && BigInt(rr.balBefore) - BigInt(rr.balAfter) === BigInt(ren.args.burned6), `renew: the tenant's balance fell by exactly that renew's burn (${ren && ren.args.burned6})`);

// ---- no keys ----
const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => walk(path.join(p, f))) : [p]);
expect(!walk(d).some((f) => /"?privateKey"?\s*[:=]/.test(fs.readFileSync(f, "utf8"))), "no private key field anywhere in the results");
expect(/the operator key appears nowhere in the results/.test(rd("run.log") || ""), "the run scanned its own results for the operator key and found none");
console.log(fails.length ? `FAIL ${fails.length} check(s)` : "PASS the runner lifecycle agent on the device");
process.exitCode = fails.length ? 1 : 0;
