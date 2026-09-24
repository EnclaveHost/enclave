// test/helpers/pvm-instance-campaign.mjs: a COMPLETENESS review of a recorded pVM instance-binding campaign
// (results/pvm-cpu-instance-binding as the owner writes it), written after Codex's audit of the owner's checker found
// that it passed a copy with every v3 envelope deleted: its checks were all() over whatever remained on disk. Here the
// coverage comes from the campaign's OWN records and nothing is scored from absence:
//   - the expected calls are fixed by the campaign's shape: enroll-a, bound-a, other-a, unbound-a, bound-b, and bound-c
//     exactly when run.log has a phase C; each must appear in exchanges.jsonl exactly once, with exactly one exchange;
//   - every evidence-NNN on disk must be owned by exactly one call, and every owned exchange must exist and parse;
//   - the request kind must be the call's (EVIDENCE3 for the enrollment and the bound/other turns, EVIDENCE for the
//     unbound turn), the request nonce must link to the call's own output (the enrollment record's nonce, a served
//     turn's verified.nonce prefix), meta.sentToVmAt must lie inside the call's window and the call inside its run.log
//     phase (second-inclusive at the end);
//   - each envelope is re-verified through verifier/pvm-evidence.mjs (the owner's module, pinned) over its request's
//     nonce with the expectations from the policy the call ran under, and must prove THAT phase's logged InstanceID
//     with its spki suffix equal to the key the client pinned; the other-instance turn must be refused at the instance;
//   - the enrollment record's own envelope is re-verified over the record's nonce, must name the instance it claims,
//     and must be canonical-JSON byte-equal to the carrier's envelope for enroll-a; its fields are never trusted.
// Fail closed: any problem makes ok false; `checks` counts what was positively established.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyPvmEvidence } from "../../verifier/pvm-evidence.mjs";
import { verifyClientPolicy, selectDeployment } from "../../verifier/pvm-policy.mjs";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const canonical = (v) => JSON.stringify(v, Object.keys(v).sort());
const PHASE_OF = { "enroll-a": "a", "bound-a": "a", "other-a": "a", "unbound-a": "a", "bound-b": "b", "bound-c": "c" };
const KIND_OF = { "enroll-a": 3, "bound-a": 3, "other-a": 3, "unbound-a": 2, "bound-b": 3, "bound-c": 3 };

export async function reviewInstanceCampaign(dir) {
  const problems = [], facts = {}; let checks = 0;
  const bad = (m) => { problems.push(m); };
  const ok = (m) => { checks++; };
  const has = (f) => fs.existsSync(path.join(dir, f));
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  const js = (f) => { try { return JSON.parse(read(f)); } catch (e) { return { __error: e.message }; } };
  // 0. the records this review rests on
  if (!has("exchanges.jsonl")) { bad("exchanges.jsonl missing: no record of which call made which exchange"); return { ok: false, problems, checks, facts }; }
  if (!has("run.log")) { bad("run.log missing: no phase record"); return { ok: false, problems, checks, facts }; }
  for (const f of ["enroll-a.json", "cli-install.json", "policies/policy-2.json"]) if (!has(f)) bad(`${f} missing`);
  if (problems.length) return { ok: false, problems, checks, facts };
  // 1. phases from run.log: "HH:MM:SSZ == A: ...", "== B: ...", "== C: ..." on the campaign's date (from exchanges.jsonl)
  const rowsRaw = read("exchanges.jsonl").split("\n").filter(Boolean); const rows = [];
  for (const l of rowsRaw) { try { rows.push(JSON.parse(l)); } catch (e) { bad(`exchanges.jsonl: unreadable row: ${e.message}`); } }
  const date = rows[0] && typeof rows[0].utcStart === "string" ? rows[0].utcStart.slice(0, 10) : null;
  if (!date) { bad("exchanges.jsonl: no utcStart on the first row"); return { ok: false, problems, checks, facts }; }
  const stamp = (hms) => Date.parse(`${date}T${hms}`);
  const log = read("run.log").split("\n"), marks = [];
  for (const l of log) { const m = /^(\d\d:\d\d:\d\dZ) == ([ABC]):/.exec(l); if (m) marks.push({ phase: m[2].toLowerCase(), at: stamp(m[1]) }); }
  const last = log.map((l) => (/^(\d\d:\d\d:\d\dZ) /.exec(l) || [])[1]).filter(Boolean).pop();
  if (!marks.some((m) => m.phase === "a") || !marks.some((m) => m.phase === "b")) bad("run.log: phases A and B are not both marked");
  const phaseWindow = (p) => { const i = marks.findIndex((m) => m.phase === p); if (i < 0) return null; return { start: marks[i].at, end: (i + 1 < marks.length ? marks[i + 1].at : stamp(last)) + 999 }; };   // second-inclusive at the end
  const hasC = marks.some((m) => m.phase === "c"); facts.phases = marks.map((m) => m.phase); ok();
  // the logged InstanceID per phase, from vm/<phase>.log
  const logged = {};
  for (const p of ["a", "b", ...(hasC ? ["c"] : [])]) { const f = `vm/${p}.log`; if (!has(f)) { bad(`${f} missing: no logged InstanceID for phase ${p.toUpperCase()}`); continue; } const ids = [...new Set([...read(f).matchAll(/INSTANCE id=([0-9a-f]{64})/g)].map((m) => m[1]))]; if (ids.length !== 1) bad(`${f}: expected exactly one logged InstanceID, found ${ids.length}`); else logged[p] = ids[0]; }
  facts.logged = logged;
  // 2. the calls: exactly the expected set, once each, one exchange each
  const expected = ["enroll-a", "bound-a", "other-a", "unbound-a", "bound-b", ...(hasC ? ["bound-c"] : [])];
  const byLabel = new Map();
  for (const r of rows) { if (byLabel.has(r.label)) bad(`call row duplicated: ${r.label}`); byLabel.set(r.label, r); }
  for (const l of expected) if (!byLabel.has(l)) bad(`call missing from exchanges.jsonl: ${l}`);
  for (const r of rows) if (!expected.includes(r.label)) bad(`unexpected call in exchanges.jsonl: ${r.label}`);
  const owner = new Map();   // exchange n -> label
  for (const l of expected) { const r = byLabel.get(l); if (!r) continue; if (!Array.isArray(r.exchanges) || r.exchanges.length !== 1 || !Number.isInteger(r.exchanges[0])) { bad(`call ${l}: must own exactly one exchange (got ${JSON.stringify(r.exchanges)})`); continue; } const n = r.exchanges[0]; if (owner.has(n)) bad(`exchange ${String(n).padStart(3, "0")} owned by two calls: ${owner.get(n)} and ${l}`); else owner.set(n, l); }
  const onDisk = fs.existsSync(path.join(dir, "evidence")) ? fs.readdirSync(path.join(dir, "evidence")).filter((f) => /^evidence-\d{3}\.json$/.test(f)).map((f) => parseInt(f.slice(9, 12), 10)) : [];
  for (const n of onDisk) if (!owner.has(n)) bad(`exchange ${String(n).padStart(3, "0")} is on disk but owned by no call`);
  for (const [n] of owner) if (!onDisk.includes(n)) bad(`exchange ${String(n).padStart(3, "0")} is owned by ${owner.get(n)} but missing from disk`);
  if (!problems.length) ok();
  // 3. policies and the anchor
  const anchor = js("cli-install.json").anchor, enroll = js("enroll-a.json");
  if (!anchor || !enroll || enroll.__error) { bad("the anchor or the enrollment record is unreadable"); return { ok: false, problems, checks, facts }; }
  const policyFor = (serial, now) => { const f = `policies/policy-${serial}.json`; if (!has(f)) return { ok: false, reason: `${f} missing` }; return verifyClientPolicy(js(f), { anchorFp: anchor.policyKeyFp, serialFloor: anchor.serialFloor, now, clientVersion: "0.5.0" }); };
  const D_BOUND = enroll.deployment;
  // 4. per call: the exchange's request, kind, nonce link, window, phase, and re-verification
  for (const l of expected) {
    const r = byLabel.get(l); if (!r || !Array.isArray(r.exchanges) || r.exchanges.length !== 1) continue;
    const n = String(r.exchanges[0]).padStart(3, "0"), base = `evidence/evidence-${n}`;
    if (!has(`${base}.json`) || !has(`${base}.request`) || !has(`${base}.meta.json`)) { bad(`call ${l}: its exchange ${n} is incomplete on disk`); continue; }
    const req = /^EVIDENCE(3)? ([0-9a-f]{64})\n$/.exec(fs.readFileSync(path.join(dir, `${base}.request`), "latin1"));
    if (!req) { bad(`call ${l}: exchange ${n} request is not an EVIDENCE line`); continue; }
    const kind = req[1] ? 3 : 2, nonce = req[2];
    if (kind !== KIND_OF[l]) { bad(`call ${l}: exchange ${n} request kind is EVIDENCE${kind === 3 ? "3" : ""}, the call's is EVIDENCE${KIND_OF[l] === 3 ? "3" : ""}`); continue; }
    let envelope; try { const ls = read(`${base}.json`).split("\n").filter(Boolean); if (ls.length !== 1) throw new Error(`${ls.length} lines`); envelope = JSON.parse(ls[0]); } catch (e) { bad(`call ${l}: exchange ${n} envelope unreadable: ${e.message}`); continue; }
    const meta = js(`${base}.meta.json`); if (meta.__error) { bad(`call ${l}: exchange ${n} meta unreadable`); continue; }
    // the nonce links to the call's own output
    let result = null; if (has(`${l}.jsonl`)) { try { const lines = read(`${l}.jsonl`).split("\n").filter(Boolean); result = JSON.parse(lines[lines.length - 1]).result || null; } catch {} }
    if (l === "enroll-a") { if (enroll.nonce !== nonce) bad(`call enroll-a: the enrollment record's nonce is not exchange ${n}'s request nonce`); else ok(); }
    else if (result && result.verified) { if (!nonce.startsWith(result.verified.nonce)) bad(`call ${l}: the turn's verified nonce ${result.verified.nonce} is not a prefix of exchange ${n}'s request nonce`); else ok(); }
    else if (l === "other-a") { if (!result || result.step !== "verify" || result.sent !== false) bad("call other-a: its result must be a refusal at verify with nothing sent"); else ok(); }
    else bad(`call ${l}: no result to link the nonce to (${l}.jsonl)`);
    // time: the exchange inside the call, the call inside its phase
    const t = Date.parse(meta.sentToVmAt), s = Date.parse(r.utcStart), e = Date.parse(r.utcEnd), w = phaseWindow(PHASE_OF[l]);
    if (!(t >= s && t <= e)) bad(`call ${l}: exchange ${n} was sent at ${meta.sentToVmAt}, outside the call's window ${r.utcStart}..${r.utcEnd}`);
    else if (!w || !(s >= w.start && e <= w.end)) bad(`call ${l}: its window ${r.utcStart}..${r.utcEnd} is outside phase ${PHASE_OF[l].toUpperCase()}`);
    else ok();
    // re-verification over the request nonce, with the expectations from the policy the call ran under
    const P = policyFor(r.after && r.after.serial, s); if (!P.ok) { bad(`call ${l}: the policy it ran under does not verify: ${P.reason}`); continue; }
    const body = P.policy, expect = { nonce: Buffer.from(nonce, "hex"), appId: Buffer.from(body.appIds[0], "hex"), allowedRuntimeIds: body.runtimeIds, allowedCodeHashes: body.codeHashes, allowedAuthorityHashes: body.authorityHashes, rootPins: body.googleRootPins, formats: body.formats };
    if (/^bound-/.test(l)) { const sel = selectDeployment(body, { deployment: D_BOUND }); if (!sel.ok || !sel.instances) { bad(`call ${l}: the policy does not bind ${D_BOUND.slice(0, 12)}… to instances`); continue; } expect.instanceIds = sel.instances; expect.formats = ["enclave-pvm-app-evidence/v3"]; }
    if (l === "other-a") { const other = result && result.deployment && result.deployment.id; const sel = other ? selectDeployment(body, { deployment: other }) : { ok: false }; if (!sel.ok || !sel.instances) { bad("call other-a: its result names no deployment bound to another instance"); continue; } expect.instanceIds = sel.instances; expect.formats = ["enclave-pvm-app-evidence/v3"]; }
    const v = await verifyPvmEvidence(envelope, expect, { now: Date.parse(meta.answeredAt) });
    if (l === "other-a") { if (v.status !== "rejected" || !v.reasons.join(" ").includes("not one bound to the selected deployment")) bad(`call other-a: expected the instance refusal, got ${v.status}: ${v.reasons.at(-1)}`); else ok(); continue; }
    if (v.status !== "verified") { bad(`call ${l}: re-verification of exchange ${n} over its request nonce: ${v.status}: ${v.reasons.at(-1)}`); continue; }
    ok();
    if (kind === 3) { const want = logged[PHASE_OF[l]]; if (!want) bad(`call ${l}: phase ${PHASE_OF[l].toUpperCase()} logged no InstanceID to hold the envelope to`); else if (v.claims.instanceId !== want) bad(`call ${l}: exchange ${n} proves instance ${String(v.claims.instanceId).slice(0, 16)}…, not phase ${PHASE_OF[l].toUpperCase()}'s logged ${want.slice(0, 16)}…`); else ok(); }
    if (result && result.verified) { if (!v.claims.transportSpki.endsWith(result.verified.key)) bad(`call ${l}: the envelope's transport key does not end in the key the client pinned (${result.verified.key})`); else ok(); }
    if (l === "enroll-a") { if (envelope.spki !== enroll.transportSpki) bad("call enroll-a: the record's transport key is not the exchange's"); else ok(); facts.enrollEnvelope = envelope; }
  }
  // 5. the enrollment record's own envelope: never trusted, re-verified, and the carrier's bytes
  if (!enroll.envelope || typeof enroll.envelope !== "object") bad("enrollment record has no envelope");
  else {
    if (facts.enrollEnvelope && canonical(enroll.envelope) !== canonical(facts.enrollEnvelope)) bad("enrollment record: its envelope is not byte-equal (canonical JSON) to the carrier's envelope for enroll-a");
    else if (facts.enrollEnvelope) ok();
    if (sha256hex(Buffer.from(String(enroll.instanceKey || ""), "hex")) !== enroll.instanceId) bad("enrollment record: instanceId is not SHA-256 of its instanceKey");
    else ok();
    const P1 = policyFor(enroll.policySerial, Date.parse(enroll.at));
    if (!P1.ok) bad(`enrollment record: its policy does not verify: ${P1.reason}`);
    else {
      const b = P1.policy, v = await verifyPvmEvidence(enroll.envelope, { nonce: Buffer.from(String(enroll.nonce || ""), "hex"), appId: Buffer.from(b.appIds[0], "hex"), allowedRuntimeIds: b.runtimeIds, allowedCodeHashes: b.codeHashes, allowedAuthorityHashes: b.authorityHashes, rootPins: b.googleRootPins, formats: b.formats }, { now: Date.parse(enroll.at) });
      if (v.status !== "verified") bad(`enrollment record: its own envelope does not verify over the record's nonce: ${v.reasons.at(-1)}`);
      else if (v.claims.instanceId !== enroll.instanceId) bad(`enrollment record: its envelope proves ${String(v.claims.instanceId).slice(0, 16)}…, not the instanceId it claims`);
      else ok();
    }
  }
  facts.instanceId = enroll.instanceId; facts.calls = expected;
  return { ok: problems.length === 0, problems, checks, facts };
}
