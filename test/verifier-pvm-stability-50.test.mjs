// Independent review of the pVM owner's 50-turn stability run through the installed client 0.4.1 on the Pixel 10 (their
// c003c388, results/pvm-cpu-stability-50, copied verbatim into test/fixtures/verifier/pvm-stability-50 and pinned). Every
// check here is this session's own code over the raw files, none of it the owner's checker: the fixture's identity, the
// capture's completeness, all fifty attestation chains re-verified offline through the exact pinned adapter under the
// one committed policy, the turns' validity re-derived from the client's own output, the VM capture decoded and matched
// one to one by nonce, the committed state unchanged across the run, the deployment selections against the signed table,
// and the detach timing the owner asked to have confirmed from the raw logs. Evidence classes: the chains are device
// evidence re-verified here; sealing and FIN are the client's own claim plus the served count and the nonce match; the
// thermal and host samples are observations, not properties.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyClientPolicy, selectDeployment, keyFingerprint } from "../verifier/pvm-policy.mjs";
import { loadOwnerModule, STRICT_INTEGRATION } from "../verifier/pvm-evidence.mjs";
import { readExchanges, reverifyExchange } from "./helpers/pvm-device-evidence.mjs";

const ownerMod = await loadOwnerModule();
const skip = !ownerMod && !STRICT_INTEGRATION && "owner module absent (ENCLAVE_PVM_MODULE via verifier/integration/resolve.mjs)";
const F = new URL("./fixtures/verifier/pvm-stability-50/", import.meta.url).pathname;
const rd = (n) => fs.readFileSync(path.join(F, n)), js = (n) => JSON.parse(rd(n).toString()), sha256 = (b) => createHash("sha256").update(b).digest("hex");
const lines = (label) => rd(`${label}.jsonl`).toString().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const rows = (n) => rd(n).toString().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const SRC = js("SOURCES.json"), cap = js("capture.json"), turns = rows("turns.jsonl"), calls = rows("exchanges.jsonl"), hub = rows("hub.jsonl");
const policyEnv = js("policies/policy-1.json"), policyBody = JSON.parse(Buffer.from(policyEnv.policy, "base64").toString()), keys = { policy: js("policy-key.json"), release: js("release-key.json") }, anchor = js("cli-install.json").anchor;
const NOW = Date.parse(policyBody.notBefore) + 3600e3;
const label = (i) => `turn-${String(i).padStart(2, "0")}`;
const resultOf = (l) => lines(l).find((x) => x.result).result;

test("the fixture is the owner's results verbatim (325 files hash to the record; the owner's reported hashes match), and the run script, capture and preflight were frozen before the run with only the checker differing afterwards", () => {
  for (const [rel, want] of Object.entries(SRC.files)) assert.equal(sha256(rd(rel)), want, rel);
  for (const [rel, want] of Object.entries(SRC.ownerReportedSha256Prefix)) assert.equal(sha256(rd(rel)).slice(0, want.length), want, rel);
  assert.equal(Object.keys(SRC.files).length, 325);
  const fr = SRC.toolingFrozenAt; assert.ok(Date.parse(fr.committed) < Date.parse(cap.runStart), "the freeze commit precedes the run");
  const same = Object.entries(fr.files).filter(([, v]) => v.atFreeze === v.atRun).map(([p]) => path.basename(p)).sort();
  assert.deepEqual(same, ["activation-capture.sh", "app-stability-run.sh", "preflight-activation-capture.sh"]); assert.notEqual(fr.files["shielded/anchor/avf/runtime/conformance/check-app-stability.py"].atFreeze, fr.files["shielded/anchor/avf/runtime/conformance/check-app-stability.py"].atRun, "the checker is the one file that changed: the detach-rule correction");
});
test("the capture is complete: fifty exchanges in order, each request a nonce line and each envelope one v2 JSON line answering it, UTC times inside the run and inside its turn, sizes as recorded, fifty distinct nonces, and the committed state after every turn the same generation 2", () => {
  assert.equal(cap.clock, "UTC"); assert.equal(cap.turnsPlanned, 50); assert.equal(cap.turnsAttempted, 50); assert.equal(cap.turnsValid, 50);
  const exs = readExchanges(path.join(F, "evidence")); assert.equal(exs.length, 50); assert.equal(calls.length, 50); assert.equal(turns.length, 50);
  const gen2 = js("cli-state.d/2.json").state;
  for (const [i, ex] of exs.entries()) {
    const l = label(i + 1), row = calls.find((r) => r.label === l), meta = js(`evidence/evidence-${ex.n}.meta.json`), res = resultOf(l);
    assert.equal(cap.exchanges[i].label, l); assert.equal(ex.n, String(i + 1).padStart(3, "0"));
    assert.ok(ex.nonce, `${ex.n}: request line`); assert.ok(ex.envelope, `${ex.n}: envelope ${ex.parseError || ""}`); assert.equal(ex.envelope.nonce, ex.nonce); assert.equal(ex.envelope.format, "enclave-pvm-app-evidence/v2");
    for (const t of [meta.sentToVmAt, meta.answeredAt]) assert.ok(Date.parse(cap.runStart) <= Date.parse(t) && Date.parse(t) <= Date.parse(cap.runEnd), `${ex.n}: inside the run`);
    assert.ok(Date.parse(row.utcStart) <= Date.parse(meta.sentToVmAt) && Date.parse(meta.answeredAt) <= Date.parse(row.utcEnd), `${l}: inside its turn`);
    assert.equal(meta.bytesIn, Buffer.byteLength(ex.requestText)); assert.equal(meta.bytesOut, Buffer.byteLength(ex.envelopeText));
    assert.deepEqual(row.exchanges, [i + 1]); assert.equal(res.verified.nonce, ex.nonce.slice(0, 16), `${l}: the client's own nonce`);
    const want = { gen: 2, serial: gen2.serial, policyFp: gen2.policyFp, nextPolicyFp: gen2.nextPolicyFp, releaseFp: gen2.releaseFp, active: null };
    assert.deepEqual(row.after, want, `${l}: the carrier-side state copy is generation 2`); assert.deepEqual(cap.exchanges[i].stateAfter, want);
  }
  assert.equal(new Set(exs.map((e) => e.nonce)).size, 50);
});
test("all fifty chains re-verify offline through the pinned adapter under the one committed policy, each released by the browser-kind gate with claims equal to its turn's own verified summary; one VM boot; a replayed envelope is refused", { skip }, async () => {
  const exs = readExchanges(path.join(F, "evidence")), failures = [];
  for (const [i, ex] of exs.entries()) {
    const l = label(i + 1), meta = js(`evidence/evidence-${ex.n}.meta.json`), r = await reverifyExchange(ex, policyBody, { now: Date.parse(meta.answeredAt) });
    if (!r.ok) { failures.push(`${ex.n} ${l}: ${r.why}`); continue; }
    const v = resultOf(l).verified;
    assert.deepEqual(r.summary, { format: v.format, app: v.app, runtime: v.runtime, codeHash: v.codeHash, key: v.key, appKey: v.appKey, nonce: v.nonce }, `${l}: the adapter's claims equal the client's summary`);
    assert.deepEqual(r.sealed, { windowSeconds: policyBody.sealedWindow.seconds, maxRequests: policyBody.sealedWindow.maxRequests });
  }
  assert.deepEqual(failures, [], `exchanges that did not re-verify:\n${failures.join("\n")}`);
  assert.equal(new Set(exs.map((e) => e.envelope.spki)).size, 1, "one transport key"); assert.equal(new Set(exs.map((e) => e.envelope.appKey)).size, 1, "one app key: one boot");
  const swapped = await reverifyExchange({ ...exs[7], nonce: exs[8].nonce, requestText: exs[8].requestText }, policyBody, { now: Date.parse(js("evidence/evidence-008.meta.json").answeredAt) }); assert.equal(swapped.ok, false); assert.match(swapped.why, /not this client's challenge/);
});
test("fifty valid turns re-derived from the client's own output: the policy committed before each request, every stream complete and every whole answer 200, clientVersion 0.4.1, thirty-five streams and fifteen whole, 2040 tokens, and every turn's token ids a prefix of one greedy sequence", () => {
  let streams = 0, whole = 0, tokens = 0; const seqs = [];
  for (let i = 1; i <= 50; i++) {
    const l = label(i), ls = lines(l), ci = ls.findIndex((x) => x.committed), ri = ls.findIndex((x) => x.result), r = ls[ri].result, t = turns[i - 1];
    assert.ok(ci >= 0 && ci < ri, `${l}: committed before the result`); assert.deepEqual(ls[ci].committed, { serial: 1, gen: 2 });
    assert.equal(Number(rd(`${l}.rc`).toString().trim()), 0); assert.equal(r.clientVersion, "0.4.1"); assert.equal(r.policySerial, 1); assert.equal(r.stateGen, 2); assert.equal(r.status, 200); assert.equal(r.sent, true);
    if (r.mode === "stream") { streams++; assert.equal(r.complete, true, `${l}: a stream is valid only at its authenticated FIN`); assert.equal(r.tokens, t.tokens); } else { whole++; assert.match(r.body || "", /"token":/); }
    assert.equal(t.rc, 0); assert.equal(t.label, l); tokens += t.tokens; seqs.push(t.tokenIds);
  }
  assert.equal(streams, 35); assert.equal(whole, 15); assert.equal(tokens, 2040);
  const longest = seqs.reduce((a, b) => (b.length > a.length ? b : a), []); assert.equal(longest.length, 128);
  for (const [i, s] of seqs.entries()) assert.deepEqual(s, longest.slice(0, s.length), `${label(i + 1)}: a prefix of the same greedy sequence`);
});
test("selection: thirty turns by deployment name the signed table's entry and its app, twenty by app carry no deployment; this session's verifier accepts the policy and selects the same app; the anchors are the install's", () => {
  const p = verifyClientPolicy({ policy: policyEnv.policy, sig: policyEnv.sig }, { anchorFp: anchor.policyKeyFp, serialFloor: anchor.serialFloor, now: NOW, clientVersion: "0.4.1" }); assert.equal(p.ok, true, p.reason);
  const entry = policyBody.deployments[0]; assert.equal(policyBody.deployments.length, 1); assert.deepEqual(selectDeployment(p.policy, { deployment: entry.id }), { ok: true, app: entry.app, deployment: entry.id, instances: null });
  let byDep = 0, byApp = 0;
  for (let i = 1; i <= 50; i++) { const r = resultOf(label(i)), t = turns[i - 1]; if (t.selection === "dep") { byDep++; assert.deepEqual(r.deployment, entry, `${label(i)}`); assert.equal(r.verified.app, entry.app); } else { byApp++; assert.equal("deployment" in r, false, `${label(i)}: no deployment field`); assert.equal(r.verified.app, policyBody.appIds[0]); } }
  assert.equal(byDep, 30); assert.equal(byApp, 20);
  assert.equal(keyFingerprint(keys.policy.key), anchor.policyKeyFp); assert.equal(keyFingerprint(keys.release.key), anchor.releaseKeyFp); assert.equal(js("cli-state.d/2.json").state.digest, sha256(Buffer.from(policyEnv.policy, "base64")));
});
test("the committed state never moved during the fifty turns: exactly two generations (the install and policy 1), the final state equal to generation 2, nothing staged or active", () => {
  assert.deepEqual(fs.readdirSync(path.join(F, "cli-state.d")).sort(), ["1.json", "2.json"]);
  const g2 = js("cli-state.d/2.json"); assert.equal(g2.gen, 2); assert.equal(g2.state.serial, 1); assert.equal(g2.state.staged, null); assert.equal(g2.state.active, null);
  const fin = js("state-final.json"); assert.equal(fin.gen, 2); assert.deepEqual(fin.state, g2.state); assert.deepEqual(js("state-0-installed.json").state.serial, 1);
});
test("the VM capture, decoded here: thirty-five streams served to FIN and fifteen whole answers, one to one by nonce with the turns, nothing served that no turn answered; no plaintext in the capture, the hub or the carrier; no private key anywhere", () => {
  const decode = (t) => t + "\n" + [...t.matchAll(/APPOUT \d+ ([0-9a-f]+)/g)].map((m) => Buffer.from(m[1], "hex").toString("utf8")).join("\n");
  const L = decode(rd("l1.log").toString());
  const fins = [...L.matchAll(/SEALED stream nonce=(\w+) fin after/g)].map((m) => m[1]), served = [...L.matchAll(/SEALED served nonce=(\w+)/g)].map((m) => m[1]);
  assert.equal(fins.length, 35); assert.equal(served.length, 15);
  for (let i = 1; i <= 50; i++) { const r = resultOf(label(i)); assert.ok((r.mode === "stream" ? fins : served).includes(r.verified.nonce), `${label(i)}: served as its mode says`); }
  const answered = new Set(Array.from({ length: 50 }, (_, i) => resultOf(label(i + 1)).verified.nonce)); for (const n of [...fins, ...served]) assert.ok(answered.has(n), `served ${n} without a turn`);
  for (const n of ["l1.log", "hub.jsonl", "hub.err", "carrier.log"]) { const t = decode(rd(n).toString()); for (const needle of ["GET /?graph", "steps=", '"token":', "tok_per_s"]) assert.equal(t.includes(needle), false, `${n} carries ${needle}`); }
  for (const rel of Object.keys(SRC.files)) assert.equal(rd(rel).toString("latin1").includes("PRIVATE KEY"), false, rel);
});
test("the detach, confirmed from the raw logs: one attach before the first turn, one detach after the last turn ended and after the run declared 50 valid, the hub ending 49 ms later by the script's stop; the run's own checker failed only on its 'no detach' rule and the corrected one counts detaches before the last turn only", () => {
  const attaches = hub.filter((h) => h.change === "attach"), detaches = hub.filter((h) => h.change === "detach");
  assert.equal(attaches.length, 1); assert.equal(detaches.length, 1);
  const first = calls[0], last = calls[49]; assert.equal(last.label, "turn-50");
  assert.ok(Date.parse(attaches[0].t) < Date.parse(first.utcStart), "attached before the first turn");
  assert.ok(Date.parse(detaches[0].t) > Date.parse(last.utcEnd), `detached (${detaches[0].t}) after the last turn ended (${last.utcEnd})`);
  assert.equal(detaches[0].t, "2026-09-24T16:31:34.686Z"); assert.equal(last.utcEnd, "2026-09-24T16:31:28.849Z");
  const end = hub.at(-1); assert.equal(end.end, "SIGTERM"); assert.equal(Date.parse(end.t) - Date.parse(detaches[0].t), 49);
  const log = rd("run.log").toString(); assert.match(log, /16:31:31Z attempted 50, valid 50/); assert.match(log, /16:31:34Z the lab app was stopped by the script after the turns/);
  assert.equal(calls.filter((r) => Date.parse(r.utcStart) > Date.parse(detaches[0].t)).length, 0, "no turn after the detach: no reconnect");
  const c0 = rd("check.txt").toString(), c1 = rd("check-corrected.txt").toString(), fails = (t) => t.split("\n").filter((l) => /^FAIL /.test(l) && !/^FAIL \(\d+\)$/.test(l));
  assert.deepEqual(fails(c0), ["FAIL one VM boot throughout (1 transport/app key pair(s)), one attach, no detach (1 attach, 1 detach)"]); assert.match(c0, /^FAIL \(1\)$/m);
  assert.deepEqual(fails(c1), []); assert.match(c1, /no detach before the last turn ended \(0 mid-run; 1 after it: the scripted stop\)/); assert.match(c1, /^PASS /m);
});
test("observations, recorded as such: thermal status 0 at all 51 samples, battery 31.5 to 35.8 C, host 1-minute load 2.09 to 3.24; not properties", () => {
  const th = rows("thermal.jsonl"); assert.equal(th.length, 51, "one sample per turn plus one");
  assert.ok(th.every((r) => r.thermalStatus === 0), "thermal status 0 at every sample");
  const temps = th.map((r) => r.batteryTempTenthsC / 10); assert.ok(Math.min(...temps) >= 31.5 && Math.max(...temps) <= 35.8, `battery ${Math.min(...temps)}..${Math.max(...temps)} C within the reported band`);
  const loads = rows("host.jsonl").map((r) => Number(String(r.loadavg).split(" ")[0])); assert.equal(loads.length, 7);
  assert.ok(Math.min(...loads) >= 2.09 && Math.max(...loads) <= 3.24, `host 1-minute load ${Math.min(...loads)}..${Math.max(...loads)} as sampled (the owner's 2.1-3.8 rounds the first and takes the 5-minute figure)`);
  assert.match(rd("NOTES.md").toString(), /stream-probe|fixed prompt|not the chat workload/i, "the notes scope the workload");
});
