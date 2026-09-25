#!/usr/bin/env node
// check-relay-route.mjs <dir> -- the offline check of the runner through the REAL relay (cpu/relay-route-run.mjs; RUNNER-AGENT.md
// "Before the lease, and attaching once registered"; LAB). Its own copy of what each step must show, and coverage from the
// run's OWN records:
//   - steps.jsonl: the phases' steps, in order, each ok -- and the facts behind the load-bearing ones re-derived here;
//   - relay-env.jsonl: every relay process started from an allowlisted environment with no secret-bearing name;
//   - exchanges.jsonl: every proof-key statement RE-VERIFIED over its own nonce (Google's roots, the build, the owner's
//     out-of-band instance, this deployment) and each rate refusal journaled as refused; the pre-lease exchanges came through
//     the bootstrap route and every other through /x; every checkpoint the agent accepted re-verified against the attested key and equal to its request;
//   - attach.jsonl: every co-signature the owner's co-signer gave is RE-VERIFIED offline -- the rad (AVF, the build, the
//     authority, over this nonce and transport key), the instance (pinned, its signature over THIS transcript), and the
//     operator signature recovers to the OWNER over exactly "enclave-tunnel-attach:<name>:<nonce>"; no nonce signed twice;
//     the wrong operator's signatures recover to that other key;
//   - vm/*.log: the relay's verdicts per boot (accepted, refused without a co-signature, refused for the wrong operator,
//     refused on the build, accepted co-signed), and the same instance throughout;
//   - client/*.jsonl: served through /x as bound; another instance, another build and a stale answer refused before sealing;
//   - chain-events.jsonl vs journal.jsonl: registered with the attested key, claimed once, every Checkpointed a journaled
//     landing, the recovered checkpoint exactly the undelivered one, released once after the last proof.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const { verifyPvmProofKey } = await import(path.join(REPO, "relay/pvm-app-attest.mjs"));
const { verifyPvmCheckpoint } = await import(path.join(REPO, "relay/pvm-checkpoint.mjs"));
const { verifyAvfEvidence } = await import(path.join(REPO, "relay/avf-verify.mjs"));
const { avfPadBinding, AVF_PAD_FORMAT } = await import(path.join(REPO, "relay/avf-binding.mjs"));
const V = await import("viem");
const d = path.resolve(process.argv[2] || ".");
const fails = [];
const expect = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const rd = (f) => { try { return fs.readFileSync(path.join(d, f), "utf8"); } catch { return null; } };
const jl = (f) => (rd(f) || "").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l.slice(0, 60) }; } });
const sha = (b) => createHash("sha256").update(b).digest("hex");
let run = null; try { run = JSON.parse(rd("run.json")); } catch {}
expect(!!run, "run.json present"); if (!run) process.exit(1);
const pins = run.pins, D = pins.deployment, OP = pins.operator, OWNER = run.ownerInstanceOutOfBand, NAME = run.endpoint.split("/t/")[1];
const PLAN = ["A-attach", "A-row", "A-bootstrap-attest", "A-register", "A-claim", "A-route", "A-prove", "A-client", "A-client-wrong-instance", "A-client-wrong-build",
  "A-client-stale", "A-crash", "A-recover", "B-disconnect", "B-gone", "B1-no-cosigner", "B2-wrong-operator", "B3-owner-cosigner", "B-route", "B-client", "B-prove",
  "C-wrong-build-relay", "C-right-relay", "C-route", "D-release"];
const S = jl("steps.jsonl");
expect(S.length === PLAN.length && S.every((s, i) => s.step === PLAN[i] && s.ok === true), `steps: exactly the plan's ${PLAN.length}, in order, each ok (${S.map((s) => s.step + (s.ok ? "" : "!")).join(" ")})`);
const st = Object.fromEntries(S.map((s) => [s.step, s.facts || {}]));

// ---- the relay's environment ----
const envs = jl("relay-env.jsonl");
expect(envs.length >= 3 && envs.every((e) => e.names.every((n) => !/KEY$|SECRET|TOKEN|PRIVATE|SEED|PASSWORD|STRIPE|SSO_|PROVISIONER/.test(n)) && e.values.PVM_SERVING === "1" && e.values.API_RELAY_BIND === "127.0.0.1"),
       `relay: ${envs.length} processes, each from an allowlisted environment with no secret-bearing name, bound to loopback`);
expect(envs.some((e) => e.values.METAL_AVF_CODE_HASHES === run.oldCode && e.values.PVM_CPU_CODE_HASHES === run.oldCode) && envs.filter((e) => e.values.METAL_AVF_CODE_HASHES === run.code).length >= 3,
       "relay: the lab build admitted in every relay but the one that admits only the OLD build");

// ---- VM verdicts per boot ----
const vm = (p) => { const c = rd(`vm/${p}.log`) || ""; return { accepted: /RELAY attest ACCEPTED/.test(c), rejected: (/RELAY attest REJECTED: (.*)/.exec(c) || [])[1] || "", cosigned: /RELAY attach (co-signed by the owner|operatorSig attached)/.test(c),
  instance: (/INSTANCE id=([0-9a-f]{64})/.exec(c) || [])[1], proofKey: (/PROOF key=(0x[0-9a-f]{40})/.exec(c) || [])[1] }; };
const B = { a: vm("a"), b1: vm("b1"), b2: vm("b2"), b3: vm("b3"), c: vm("c"), d: vm("d") };
expect(Object.values(B).every((x) => x.instance === OWNER), `every boot logged the owner's out-of-band instance ${OWNER.slice(0, 16)}…`);
expect(B.a.accepted && !B.a.cosigned, "A: attached UNREGISTERED, first-come, without a co-signature");
expect(!B.b1.accepted && /registered on chain; attach must carry operatorSig/.test(B.b1.rejected), `B1: the registered name refused an attach without a co-signature (${B.b1.rejected.slice(0, 80)})`);
expect(!B.b2.accepted && new RegExp(`registered on chain to ${OP}, not ${run.wrongOperator}`).test(B.b2.rejected), `B2: refused: the name is the owner's, the signature another operator's`);
expect(B.b3.accepted && B.b3.cosigned && B.d.accepted && B.d.cosigned, "B3 and C's right relay (boot d): attached with the owner's co-signature");
expect(!B.c.accepted && /allowlisted codeHash|codeHash/.test(B.c.rejected), `C: the relay that admits only another build refused the attach on its build (${B.c.rejected.slice(0, 80)})`);

// ---- attach transcripts: every owner co-signature re-verified ----
const AT = jl("attach.jsonl"), DOMAIN = "enclave-pvm-attach-instance-v1\n";
const okOwner = AT.filter((x) => x.signer === "owner" && x.verdict && x.verdict.ok), okWrong = AT.filter((x) => x.signer === "wrong-operator" && x.verdict && x.verdict.ok);
let aOk = 0;
for (const x of okOwner) {
  try {
    const q = x.request, nonce = Buffer.from(q.nonce, "base64"), spki = Buffer.from(q.rad.transportKey, "base64"), Bt = avfPadBinding(spki, q.rad.padKey, nonce);
    const ev = JSON.parse(Buffer.from(q.rad.body, "base64").toString("utf8"));
    const v = verifyAvfEvidence({ chain: ev.chain.map((c) => Buffer.from(c, "base64")), challenge: createHash("sha256").update(Bt).digest(), signature: Buffer.from(ev.signature, "base64"), signedMessage: Bt },
                                { allowedCodeHashes: [run.code], allowedAuthorityHashes: [run.authority], rootPins: run.googleRootPins });
    const iid = sha(Buffer.from(q.instanceKey, "hex"));
    const iok = cryptoVerify(null, Buffer.concat([Buffer.from(DOMAIN), Bt]), createPublicKey({ key: Buffer.from(q.instanceKey, "hex"), format: "der", type: "spki" }), Buffer.from(q.instanceSig, "hex"));
    const msg = `enclave-tunnel-attach:${NAME}:${nonce.toString("base64")}`, signer = (await V.recoverMessageAddress({ message: msg, signature: x.verdict.operatorSig })).toLowerCase();
    if (q.rad.format === AVF_PAD_FORMAT && v.ok && iid === OWNER && iok && q.name === NAME && signer === OP) aOk++;
    else console.log(`   (attach ${x.step}: avf ${v.ok}, instance ${iid === OWNER}, isig ${iok}, signer ${signer === OP})`);
  } catch (e) { console.log(`   (attach ${x.step}: ${e.message})`); }
}
expect(okOwner.length >= 3 && aOk === okOwner.length, `attach: every owner co-signature re-verifies offline: the rad (AVF, build, authority, nonce, transport key), the instance and its signature over THIS transcript, the owner's operator signature over exactly its own name and nonce (${aOk}/${okOwner.length})`);
const nonces = okOwner.map((x) => x.request.nonce);
expect(new Set(nonces).size === nonces.length, "attach: no nonce was co-signed twice");
let wOk = 0; for (const x of okWrong) { const msg = `enclave-tunnel-attach:${NAME}:${x.request.nonce}`; if ((await V.recoverMessageAddress({ message: msg, signature: x.verdict.operatorSig })).toLowerCase() === run.wrongOperator) wOk++; }
expect(okWrong.length === 1 && wOk === 1 && okWrong[0].step === "B2-wrong-operator", "attach: the wrong operator's one signature recovers to that other key (the hub refused it: B2)");
const cj = jl("cosign-journal.jsonl");
expect(cj.length === okOwner.length && cj.every((l) => l.instanceId === OWNER && l.name === NAME), `the owner's co-signer journal records exactly its ${okOwner.length} signatures`);

// ---- statements and checkpoints over the relay ----
const EX = jl("exchanges.jsonl"), first = (s) => { try { return JSON.parse(String(s).split("\n")[0]); } catch { return null; } };
// every 200 answer to PROOFKEY is either a statement or the payload's own one-line refusal ({"error"} alone: its evidence
// budget, one answer per 2 s, is the VM's and every caller's); each statement must re-verify, and the agent must have
// journaled exactly one accepted attest per statement and one refused attest per refusal (it never took a refusal as a key)
const pk = EX.filter((x) => x.request.startsWith("PROOFKEY ") && x.status === 200), isRefusal = (x) => { const a = first(x.answer); return !!a && Object.keys(a).join() === "error"; };
const statements = pk.filter((x) => !isRefusal(x)), refusals = pk.filter(isRefusal);
let sOk = 0; const key = B.a.proofKey;
for (const x of statements) {
  const v = verifyPvmProofKey(first(x.answer), { nonce: x.request.slice(9), appId: run.app, allowedRuntimeIds: [run.runtimeId], allowedCodeHashes: [run.code], allowedAuthorityHashes: [run.authority],
    rootPins: run.googleRootPins, instanceIds: [OWNER], deployment: D });
  if (v.ok && v.claims.proofKey === key && v.claims.codeHash === run.code && ["chainId", "proofOfTime", "registry", "deployment", "enclaveId", "operator"].every((k) => v.claims[k] === pins[k])) sOk++;
}
expect(statements.length >= 2 && sOk === statements.length, `statements: all ${statements.length} re-verify over their own nonces (the owner's instance, this deployment, codeHash = the lab build)`);
const JA = jl("journal.jsonl").filter((e) => e.ev === "attest"), aYes = JA.filter((e) => e.ok === true), aNo = JA.filter((e) => e.ok === false);
expect(aYes.length === statements.length && aYes.every((e) => e.proofKey === key && e.instanceId === OWNER) && aNo.length === refusals.length,
       `the agent accepted exactly the ${statements.length} statements and refused the payload's ${refusals.length} rate refusal(s) (${refusals.map((x) => x.step).join(", ") || "none"}): never a refusal taken as a key`);
// the carrier the harness gave the agent: the bootstrap route in exactly the steps before the lease route exists, /x in every other
const BOOT_STEPS = ["A-bootstrap", "A-register", "A-claim"], TR = `/t/${NAME}/pvm/evidence`, XR = `/x/${D}/pvm/evidence`;
expect(EX.length > 0 && EX.every((x) => x.url === (BOOT_STEPS.includes(x.step) ? TR : XR)), `carrier: the bootstrap route in ${BOOT_STEPS.join(", ")} only (${EX.filter((x) => x.url === TR).length}), /x in every other step (${EX.filter((x) => x.url === XR).length})`);
expect(statements.length > 0 && statements[0].step === "A-bootstrap" && statements[0].url === TR, "the first statement came through the BOOTSTRAP route, before any lease");
const J = jl("journal.jsonl"), signed = J.filter((e) => e.ev === "signed");
let cOk = 0;
for (const s of signed) { const c = s.checkpoint, xs = EX.filter((x) => x.request === `CHECKPOINT ${c.upto} ${c.anchorBlock} ${c.anchorHash.slice(2)}`);
  const doc = xs.length === 1 ? first(xs[0].answer) : null, v = doc ? await verifyPvmCheckpoint(doc, { pins, proofKey: key }) : { ok: false };
  if (v.ok && doc.sig === c.sig) cOk++; }
expect(signed.length >= 3 && cOk === signed.length, `checkpoints: each accepted one is one answer to exactly its request, re-verified (${cOk}/${signed.length})`);

// ---- the client through /x ----
const res = (label) => { const r = (rd(`client/${label}.jsonl`) || "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).reverse().find((x) => x.result); return (r && r.result) || {}; };
const ab = res("a-bound"), bb = res("b-bound");
expect(ab.complete === true && ab.deployment && ab.deployment.instance === OWNER && bb.complete === true && bb.deployment && bb.deployment.instance === OWNER, "client: served through /x as the bound deployment, before and after the reconnect");
for (const [l, re] of [["a-wrong-instance", /instance/i], ["a-wrong-build", /code/i], ["a-stale", /nonce/i]]) { const r = res(l); expect(!r.complete && re.test(r.refused || "") && !r.sent, `client ${l}: refused before sealing (${String(r.refused).slice(0, 80)})`); }

// ---- the chain ----
const EV = jl("chain-events.jsonl"), of = (n) => EV.filter((e) => e.event === n), landed = new Map(J.filter((e) => e.ev === "done" && e.kind === "landed").map((e) => [e.hash, e]));
expect(of("ProofKeySet").length === 1 && of("ProofKeySet")[0].args.proofKey.toLowerCase() === key && of("Registered").length === 1 && of("Claimed").length === 1, "registered once with the attested key; claimed once");
expect(of("Checkpointed").length === signed.length && of("Checkpointed").every((e) => landed.has(e.tx)), `every Checkpointed is a journaled landing, one per signed checkpoint (${of("Checkpointed").length})`);
const sw = jl("chain.jsonl").filter((e) => e.label === "swallowed-send"), rec = J.filter((e) => e.ev === "recover");
expect(sw.length === 1 && rec.length >= 1 && of("Checkpointed").some((e) => e.tx === sw[0].hash), "exactly once: the checkpoint never delivered is the one the restarted agent landed");
expect(of("Released").length === 1 && BigInt(of("Released")[0].block) > BigInt(of("Checkpointed").at(-1).block), "released once, after the last proof");
expect(/the operator keys appear nowhere in the results/.test(rd("run.log") || ""), "the run scanned its own results for both operator keys and found neither");
console.log(fails.length ? `FAIL ${fails.length} check(s)` : "PASS the pVM runner through the real relay");
process.exitCode = fails.length ? 1 : 0;
