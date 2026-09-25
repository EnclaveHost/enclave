#!/usr/bin/env node
// check-relay-reconnect.mjs <dir> -- the offline check of RECONNECT IN PLACE through the real relay (cpu/relay-reconnect-run.mjs;
// RUNNER-AGENT.md "Reconnect in place"; LAB). Its own copy of what each step must show, and coverage from the run's OWN records:
//   - steps.jsonl: the plan's steps, in order, each ok;
//   - relay-env.jsonl: every relay process from an allowlisted environment with no secret-bearing name, on loopback; exactly
//     one admitting only the OLD build;
//   - vm/a.log: ONE boot (one ANCHOR start, one transport key, the owner's out-of-band instance) and every in-place re-attach
//     answered by the running VM (REATTACH begin .. end), the hub's acceptance counted;
//   - attach.jsonl: every owner co-signature RE-VERIFIED offline (the rad over its own nonce under the build, authority and
//     Google's roots; the transport key the boot's, in EVERY attach; the instance over THIS transcript; the operator signature
//     recovering to the owner over exactly its name and nonce); no nonce twice; the proxy's down / wrong / stale answers once
//     each, the stale one an earlier owner signature that recovers to someone else over the new nonce;
//   - relay-*.log: never two tunnels at once; the refusals in R3 in order; the old-build relay's refusal on the build;
//   - replay.jsonl: an accepted attest frame (nonce N) replayed on a fresh connection (N') refused on its challenge;
//   - exchanges.jsonl / journal.jsonl / chain-events.jsonl: statements and checkpoints re-verified, the carrier per step,
//     refusals journaled as refused, every Checkpointed a journaled landing, the undelivered checkpoint landed ONCE, no
//     transaction while the relay was down, released once after the last proof;
//   - rows.jsonl: one row for the name throughout; the tier at boot, none after an in-place re-attach;
//   - every attestation chain in the run hangs off ONE provisioned AVF key (the cost measurement: no key per call).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate } from "node:crypto";
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
const count = (s, re) => (s.match(new RegExp(re.source, "gm")) || []).length;
let run = null; try { run = JSON.parse(rd("run.json")); } catch {}
expect(!!run, "run.json present"); if (!run) process.exit(1);
const pins = run.pins, D = pins.deployment, OP = pins.operator, OWNER = run.ownerInstanceOutOfBand, NAME = run.endpoint.split("/t/")[1], WRONG = run.wrongOperator;
const PLAN = ["A-attach", "A-row", "A-bootstrap-attest", "A-register", "A-claim", "A-route", "A-prove", "A-client",
  ...[1, 2, 3].flatMap((i) => [`R1-back-${i}`, `R1-route-${i}`, `R1-row-${i}`, `R1-client-${i}`, `R1-prove-${i}`]),
  "R2-watchdog", "R2-one-tunnel", "R2-route", "R3-refusals", "R3-route", "R3-replay", "R3-client",
  "R4-cut", "R4-route", "R4-pre", "R4-crash", "R4-back", "R4-route-2", "R4-recover", "R5-old-build", "R5-right", "R5-route", "R5-no-tier", "D-release", "D-one-boot"];
const IN_PLACE = 8;   // R1 x3, R2, R3, R4 (after the cut and after the drop), R5
const S = jl("steps.jsonl");
expect(S.length === PLAN.length && S.every((s, i) => s.step === PLAN[i] && s.ok === true), `steps: exactly the plan's ${PLAN.length}, in order, each ok (${S.map((s) => s.step + (s.ok ? "" : "!")).join(" ")})`);
const utcOf = (name) => (S.find((s) => s.step === name) || {}).utc || "";

// ---- the relay's environment ----
const envs = jl("relay-env.jsonl");
expect(envs.length >= 8 && envs.every((e) => e.names.every((n) => !/KEY$|SECRET|TOKEN|PRIVATE|SEED|PASSWORD|STRIPE|SSO_|PROVISIONER/.test(n)) && e.values.PVM_SERVING === "1" && e.values.API_RELAY_BIND === "127.0.0.1"),
       `relay: ${envs.length} processes, each from an allowlisted environment with no secret-bearing name, bound to loopback`);
expect(envs.filter((e) => e.values.METAL_AVF_CODE_HASHES === run.oldCode && e.values.PVM_CPU_CODE_HASHES === run.oldCode).length === 1 && envs.filter((e) => e.values.METAL_AVF_CODE_HASHES === run.code).length === envs.length - 1,
       "relay: the lab build admitted in every relay but the one that admits only the OLD build");

// ---- ONE boot, and the VM's answers to every REATTACH ----
const vm = rd("vm/a.log") || "";
const spkis = [...new Set([...vm.matchAll(/^VSOCK SPKI ([0-9a-f]{88})$/gm)].map((m) => m[1]))];
const instances = [...vm.matchAll(/INSTANCE id=([0-9a-f]{64})/g)].map((m) => m[1]);
expect(count(vm, /ANCHOR start in pVM/) === 1 && spkis.length === 1 && instances.length === 1 && instances[0] === OWNER,
       `ONE boot for the whole run: one start, one transport key ${(spkis[0] || "").slice(24, 40)}…, the owner's out-of-band instance ${OWNER.slice(0, 16)}…`);
const begins = count(vm, /REATTACH begin$/), ends = count(vm, /REATTACH end$/), accepted = count(vm, /RELAY re-attach \d+: ACCEPTED in place/);
expect(begins === ends && begins >= accepted && accepted === IN_PLACE, `the running VM answered every REATTACH (${begins} begun, ${ends} ended); the hub accepted ${accepted} in place (the plan's ${IN_PLACE})`);
// at most ONE live tunnel on the phone: from the boot's acceptance on, each loss comes before the next acceptance, one to one
let live = 0, booted = false, seqOk = count(vm, /RELAY keeper armed/) === 1;
for (const l of vm.split("\n")) {
  if (/^RELAY attest ACCEPTED/.test(l) && !booted) { booted = true; live = 1; }   // the boot's; a re-attach's own hub verdict line is not a second tunnel
  else if (/^RELAY keeper: the tunnel is gone/.test(l)) { if (live !== 1) seqOk = false; live = 0; }
  else if (/^RELAY re-attach \d+: ACCEPTED in place/.test(l)) { if (live !== 0) seqOk = false; live = 1; }
}
expect(seqOk, "one reconnector, armed once: every in-place acceptance follows exactly one loss -- never two live tunnels on the phone");
const bootSpki = spkis[0] ? Buffer.from(spkis[0], "hex") : null;

// ---- attach transcripts: every owner co-signature re-verified ----
const AT = jl("attach.jsonl"), DOMAIN = "enclave-pvm-attach-instance-v1\n";
const okOwner = AT.filter((x) => x.signer === "owner" && x.verdict && x.verdict.ok);
let aOk = 0; const parents = new Map();
const noteParent = (chainB64, where) => { try { const p = sha(Buffer.from(chainB64[1], "base64")); parents.set(p, (parents.get(p) || []).concat(where)); } catch {} };
for (const x of okOwner) {
  try {
    const q = x.request, nonce = Buffer.from(q.nonce, "base64"), spki = Buffer.from(q.rad.transportKey, "base64"), Bt = avfPadBinding(spki, q.rad.padKey, nonce);
    const ev = JSON.parse(Buffer.from(q.rad.body, "base64").toString("utf8")); noteParent(ev.chain, `attach ${x.step}`);
    const v = verifyAvfEvidence({ chain: ev.chain.map((c) => Buffer.from(c, "base64")), challenge: createHash("sha256").update(Bt).digest(), signature: Buffer.from(ev.signature, "base64"), signedMessage: Bt },
                                { allowedCodeHashes: [run.code], allowedAuthorityHashes: [run.authority], rootPins: run.googleRootPins });
    const iid = sha(Buffer.from(q.instanceKey, "hex"));
    const iok = cryptoVerify(null, Buffer.concat([Buffer.from(DOMAIN), Bt]), createPublicKey({ key: Buffer.from(q.instanceKey, "hex"), format: "der", type: "spki" }), Buffer.from(q.instanceSig, "hex"));
    const signer = (await V.recoverMessageAddress({ message: `enclave-tunnel-attach:${NAME}:${nonce.toString("base64")}`, signature: x.verdict.operatorSig })).toLowerCase();
    if (q.rad.format === AVF_PAD_FORMAT && v.ok && iid === OWNER && iok && q.name === NAME && signer === OP && bootSpki && spki.equals(bootSpki)) aOk++;
    else console.log(`   (attach ${x.step}: avf ${v.ok}, instance ${iid === OWNER}, isig ${iok}, signer ${signer === OP}, boot key ${!!bootSpki && spki.equals(bootSpki)})`);
  } catch (e) { console.log(`   (attach ${x.step}: ${e.message})`); }
}
expect(okOwner.length >= IN_PLACE + 1 && aOk === okOwner.length, `attach: every owner co-signature re-verifies offline -- the rad (AVF, build, authority, nonce), the BOOT transport key in every one, the instance over THIS transcript, the owner over exactly its name and nonce (${aOk}/${okOwner.length})`);
const nonces = okOwner.map((x) => x.request.nonce);
expect(new Set(nonces).size === nonces.length, "attach: no nonce was co-signed twice");
const cj = jl("cosign-journal.jsonl");
expect(cj.length === okOwner.length && cj.every((l) => l.instanceId === OWNER && l.name === NAME), `the owner's co-signer journal records exactly its ${okOwner.length} signatures`);
const down = AT.filter((x) => x.signer === "proxy-down"), wrong = AT.filter((x) => x.signer === "wrong-operator" && x.verdict && x.verdict.ok), stale = AT.filter((x) => x.signer === "proxy-stale");
let wOk = false, sOk = false;
if (wrong.length === 1) wOk = (await V.recoverMessageAddress({ message: `enclave-tunnel-attach:${NAME}:${wrong[0].request.nonce}`, signature: wrong[0].verdict.operatorSig })).toLowerCase() === WRONG;
if (stale.length === 1) { const s = stale[0], earlier = okOwner.find((x) => x.verdict.operatorSig === s.verdict.operatorSig && x.request.nonce !== s.request.nonce);
  sOk = !!earlier && earlier.utc < s.utc && (await V.recoverMessageAddress({ message: `enclave-tunnel-attach:${NAME}:${s.request.nonce}`, signature: s.verdict.operatorSig })).toLowerCase() !== OP; }
expect(down.length === 1 && wrong.length === 1 && stale.length === 1 && [down, wrong, stale].every((a) => a[0].step === "R3-drop") && wOk && sOk,
       "R3's co-signer answers, once each: down; the WRONG operator's (recovers to that key); a STALE owner signature (an earlier nonce's; over the new nonce it recovers to someone else)");

// ---- the relays: never two tunnels; R3's refusals in order; the old-build refusal ----
const relayLogs = envs.map((e) => ({ n: e.n, why: e.why, log: rd(`relay-${e.n}.log`) || "" }));
const attachLines = relayLogs.flatMap((r) => [...r.log.matchAll(new RegExp(`\\[tunnel\\] ${NAME} attached via [^\\n]*\\((\\d+) enclaves?\\)`, "g"))].map((m) => Number(m[1])));
expect(attachLines.length >= IN_PLACE && attachLines.every((k) => k === 1), `relay: every attach of the name left exactly ONE tunnel (${attachLines.length} attaches, counts ${[...new Set(attachLines)].join(",")})`);
const r3 = relayLogs.find((r) => r.why === "back after a drop" && /must carry operatorSig/.test(r.log));
const rej = r3 ? [...r3.log.matchAll(new RegExp(`\\[tunnel\\] ${NAME} attest REJECTED: (.*)`, "g"))].map((m) => m[1]) : [];
expect(rej.length === 3 && /must carry operatorSig/.test(rej[0]) && rej[1].includes(`registered on chain to ${OP}, not ${WRONG}`) && new RegExp(`registered on chain to ${OP}, not 0x[0-9a-f]{40}`).test(rej[2]) && !rej[2].includes(WRONG) && /attached via/.test(r3.log.split(rej[2])[1] || ""),
       `R3: the hub refused, in order, no co-signature / the wrong operator / the stale signature, then attached (${rej.map((r) => r.slice(0, 40)).join(" | ")})`);
const old = relayLogs.find((r) => /OLD build/.test(r.why));
expect(!!old && /attest REJECTED: no APK component with an allowlisted codeHash/.test(old.log) && !/attached via/.test(old.log), "R5: the relay that admits only another build refused the in-place attach on its build, and attached nothing");

// ---- the replay ----
const RP = jl("replay.jsonl");
const acc = RP.length === 1 ? okOwner.find((x) => x.request.nonce === RP[0].replayedNonce && x.verdict.operatorSig === RP[0].frame.operatorSig && JSON.stringify(x.request.rad) === JSON.stringify(RP[0].frame.rad)) : null;
expect(RP.length === 1 && !!acc && RP[0].connectionNonce && RP[0].connectionNonce !== RP[0].replayedNonce && RP[0].result && RP[0].result.ok === false && /attestationChallenge does not match/.test(RP[0].result.reason || ""),
       "R3: an ACCEPTED attest frame (certificate and co-signature for nonce N) replayed on a fresh connection N' was refused on its challenge");

// ---- statements, checkpoints, the carrier ----
const EX = jl("exchanges.jsonl"), first = (s) => { try { return JSON.parse(String(s).split("\n")[0]); } catch { return null; } };
const pk = EX.filter((x) => x.request.startsWith("PROOFKEY ") && x.status === 200), isRefusal = (x) => { const a = first(x.answer); return !!a && Object.keys(a).join() === "error"; };
const statements = pk.filter((x) => !isRefusal(x)), refusals = pk.filter(isRefusal);
const key = (/PROOF key=(0x[0-9a-f]{40})/.exec(vm) || [])[1];
let stOk = 0;
for (const x of statements) {
  const doc = first(x.answer); if (doc && doc.evidence && Array.isArray(doc.evidence.chain)) noteParent(doc.evidence.chain, `statement ${x.step}`);
  const v = verifyPvmProofKey(doc, { nonce: x.request.slice(9), appId: run.app, allowedRuntimeIds: [run.runtimeId], allowedCodeHashes: [run.code], allowedAuthorityHashes: [run.authority],
    rootPins: run.googleRootPins, instanceIds: [OWNER], deployment: D });
  if (v.ok && v.claims.proofKey === key && v.claims.codeHash === run.code && ["chainId", "proofOfTime", "registry", "deployment", "enclaveId", "operator"].every((k) => v.claims[k] === pins[k])) stOk++;
}
expect(statements.length >= 3 && stOk === statements.length, `statements: all ${statements.length} re-verify over their own nonces (the owner's instance, this deployment, the lab build)`);
const J = jl("journal.jsonl"), JA = J.filter((e) => e.ev === "attest"), retries = J.filter((e) => e.ev === "rate-retry" && e.request === "PROOFKEY");
expect(JA.filter((e) => e.ok === true).length === statements.length && JA.filter((e) => e.ok === true).every((e) => e.proofKey === key && e.instanceId === OWNER) && JA.filter((e) => e.ok === false).length + retries.length >= refusals.length,
       `the agent accepted exactly the ${statements.length} statements; each of the VM's ${refusals.length} rate refusal(s) was journaled as a retry or a refused attest, never a key`);
const BOOT_STEPS = ["A-bootstrap", "A-register", "A-claim"], TR = `/t/${NAME}/pvm/evidence`, XR = `/x/${D}/pvm/evidence`;
expect(EX.length > 0 && EX.every((x) => x.url === (BOOT_STEPS.includes(x.step) ? TR : XR)), `carrier: the bootstrap route in ${BOOT_STEPS.join(", ")} only, /x in every other step (${EX.length} exchanges)`);
const signed = J.filter((e) => e.ev === "signed");
let cOk = 0;
for (const s of signed) { const c = s.checkpoint, xs = EX.filter((x) => x.request === `CHECKPOINT ${c.upto} ${c.anchorBlock} ${c.anchorHash.slice(2)}` && !isRefusal(x));
  const doc = xs.length === 1 ? first(xs[0].answer) : null, v = doc ? await verifyPvmCheckpoint(doc, { pins, proofKey: key }) : { ok: false };
  if (v.ok && doc.sig === c.sig) cOk++; }
expect(signed.length >= 6 && cOk === signed.length, `checkpoints: each accepted one is one answer to exactly its request, re-verified (${cOk}/${signed.length})`);

// ---- the client ----
const res = (label) => { const r = (rd(`client/${label}.jsonl`) || "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).reverse().find((x) => x.result); return (r && r.result) || {}; };
const turns = ["a-bound", "r1-bound-1", "r1-bound-2", "r1-bound-3", "r3-bound"];
expect(turns.every((l) => { const r = res(l); return r.complete === true && r.deployment && r.deployment.instance === OWNER; }), `client: served through /x as the bound deployment at boot and after every checked re-attach (${turns.length})`);

// ---- the rows ----
const rows = jl("rows.jsonl"), at = (st) => rows.filter((r) => r.step === st).at(-1);
expect(rows.length >= 6 && rows.every((r) => r.rows.length <= 1) && rows.filter((r) => r.rows.length === 1).length >= 6, "rows: never two rows for the name, at any sampled moment");
const boot = at("A-attach") || rows.find((r) => r.rows[0] && r.rows[0].tier), r5 = at("R5-no-tier"), r2 = at("R2-thaw");
expect(!!boot && boot.rows[0].tier === "pvm-cpu" && !!r5 && r5.rows.length === 1 && !r5.rows[0].tier && r5.rows[0].eligible === false && r5.rows[0].serving === false,
       "rows: the tier at boot (a self-test after that attach); none after an in-place re-attach (routing only), never eligible, never serving");
expect(!!r2 && r2.rows.length === 1, "R2: after the thaw, exactly one row for the name");

// ---- the chain ----
const EV = jl("chain-events.jsonl"), of = (n) => EV.filter((e) => e.event === n), landed = new Map(J.filter((e) => e.ev === "done" && e.kind === "landed").map((e) => [e.hash, e]));
expect(of("ProofKeySet").length === 1 && of("ProofKeySet")[0].args.proofKey.toLowerCase() === key && of("Registered").length === 1 && of("Claimed").length === 1, "registered once with the attested key; claimed once");
expect(of("Checkpointed").length === signed.length && of("Checkpointed").every((e) => landed.has(e.tx)), `every Checkpointed is a journaled landing, one per signed checkpoint (${of("Checkpointed").length})`);
const sw = jl("chain.jsonl").filter((e) => e.label === "swallowed-send");
expect(sw.length === 1 && sw[0].step === "R4-crash" && of("Checkpointed").filter((e) => e.tx === sw[0].hash).length === 1 && J.some((e) => e.ev === "recover"), "exactly once across a drop: the checkpoint never delivered is the one the restarted agent landed, once");
const cutFrom = utcOf("R3-client"), cutTo = utcOf("R4-cut");
expect(!!cutFrom && !!cutTo && !J.some((e) => e.ev === "signed" && e.at > cutFrom && e.at <= cutTo), "R4: no checkpoint was signed or sent while the relay was down (a request cut by a drop sends nothing)");
expect(of("Released").length === 1 && BigInt(of("Released")[0].block) > BigInt(of("Checkpointed").at(-1).block), "released once, after the last proof");

// ---- the attestation cost: one provisioned key ----
expect(parents.size === 1 && [...parents.values()][0].length >= okOwner.length, `every attestation chain in the run (${[...parents.values()].flat().length}: attaches and statements) hangs off ONE provisioned AVF key -- no key consumed per call`);
expect(/the operator keys appear nowhere in the results/.test(rd("run.log") || ""), "the run scanned its own results for both operator keys and found neither");
console.log(fails.length ? `FAIL ${fails.length} check(s)` : "PASS reconnect in place through the real relay");
process.exitCode = fails.length ? 1 : 0;
