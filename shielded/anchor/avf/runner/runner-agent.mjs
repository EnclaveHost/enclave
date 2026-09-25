// runner-agent.mjs -- the owner-side LIFECYCLE agent for a pVM runner (RUNNER-AGENT.md): register or setProofKey, claim,
// renew, heartbeat, and stop-with-release, around the proof-posting agent (proof-agent.mjs) and through ITS transaction
// engine: one operator key, one journal, one transaction in flight. Every transaction is simulated, signed locally, journaled
// before any node sees it, and followed to a confirmed canonical receipt carrying the event it must produce; a restart
// follows whatever the journal says may be in flight BEFORE it reads the chain and decides anything. Decisions are read
// from the chain each tick, never remembered -- so an interrupted renew is finished, never re-decided (a second renew
// spends the tenant's money).
//
// It never touches: a registry entry of another operator; an entry the owner deactivated (unless the config says to
// register, i.e. to serve); a deployment it was not configured for; a bond the owner did not authorize. It renews only a
// lease its proofs show serving. It releases only after a final proof (release clears the proof watermark).
//
//   const runner = await createRunnerAgent({ config, publicClient, account, stateDir })
//   await runner.start(); await runner.tick(); await runner.stop({ release: true }); runner.close()
import { createProofAgent, checkAgentConfig } from "./proof-agent.mjs";

export const RUNNER_CONFIG_FORMAT = "enclave-pvm-runner-agent/v1";
export const LIFECYCLE_DEFAULTS = Object.freeze({ claim: false, syncProofKey: true, renewMarginSec: 600, heartbeatSec: 900, maxClaimBond6: "0", finalProofWaitMs: 70000 });
const ZERO = "0x0000000000000000000000000000000000000000", ZERO32 = "0x" + "00".repeat(32);

/** Strict, like the proof agent's: { format, proof: <an enclave-pvm-proof-agent/v1 config>, lifecycle: { ... } }. */
export function checkRunnerConfig(c) {
  const bad = (m) => { throw new Error(`runner-agent config: ${m}`); };
  if (!c || typeof c !== "object" || Array.isArray(c)) bad("not an object");
  if (Object.keys(c).sort().join() !== "format,lifecycle,proof") bad("the keys must be exactly format, proof, lifecycle");
  if (c.format !== RUNNER_CONFIG_FORMAT) bad(`format must be ${RUNNER_CONFIG_FORMAT}`);
  checkAgentConfig(c.proof);
  const l = c.lifecycle;
  if (!l || typeof l !== "object" || Array.isArray(l)) bad("lifecycle must be an object");
  for (const k of Object.keys(l)) if (!["register", "payout", ...Object.keys(LIFECYCLE_DEFAULTS)].includes(k)) bad(`unknown lifecycle key ${JSON.stringify(k)}`);
  if (l.payout !== undefined) {   // the owner's: where earnings go, and the least worth a transaction; absent = never withdraw
    const w = l.payout;
    if (!w || typeof w !== "object" || Object.keys(w).sort().join() !== "minWithdraw6,to") bad("lifecycle.payout must be exactly { to, minWithdraw6 } (the owner's values)");
    if (!/^0x[0-9a-f]{40}$/.test(w.to || "") || /^0x0{40}$/.test(w.to)) bad("lifecycle.payout.to must be 0x + 40 lowercase hex, not zero");
    if (!/^[1-9][0-9]{0,30}$/.test(w.minWithdraw6 || "")) bad("lifecycle.payout.minWithdraw6 must be a decimal > 0");
  }
  if (l.register !== undefined) {
    const r = l.register;
    if (!r || typeof r !== "object" || Object.keys(r).sort().join() !== "cpuPricePerSec6,measurement,repo") bad("lifecycle.register must be exactly { repo, measurement, cpuPricePerSec6 } (the owner's values)");
    if (typeof r.repo !== "string" || !r.repo.length || r.repo.length > 200) bad("lifecycle.register.repo must be a non-empty string");
    if (!/^0x[0-9a-f]{64}$/.test(r.measurement || "")) bad("lifecycle.register.measurement must be 0x + 64 lowercase hex");
    if (!/^[1-9][0-9]{0,18}$/.test(r.cpuPricePerSec6 || "") || BigInt(r.cpuPricePerSec6) >= 1n << 64n) bad("lifecycle.register.cpuPricePerSec6 must be a decimal price > 0 (the owner's)");
    // the published measurement is the build the VM attests, not whatever the config says (enclave-99's review of e4ecc4aa):
    // it must be one of the code hashes the evidence pins, and THE one when exactly one is pinned
    const pinned = c.proof.evidence.allowedCodeHashes;
    if (!pinned.includes(r.measurement.slice(2))) bad(`lifecycle.register.measurement must be one of the evidence's allowedCodeHashes (the attested build's code hash)${pinned.length === 1 ? `: ${pinned[0]}` : ""}`);
  }
  for (const k of ["claim", "syncProofKey"]) if (l[k] !== undefined && typeof l[k] !== "boolean") bad(`lifecycle.${k} must be true or false`);
  for (const k of ["renewMarginSec", "heartbeatSec", "finalProofWaitMs"]) if (l[k] !== undefined && (!Number.isInteger(l[k]) || l[k] < 60)) bad(`lifecycle.${k} must be an integer >= 60`);
  if (l.maxClaimBond6 !== undefined && !/^(0|[1-9][0-9]{0,30})$/.test(l.maxClaimBond6)) bad("lifecycle.maxClaimBond6 must be a decimal (0: never bond)");
  return { ...c, lifecycle: { ...LIFECYCLE_DEFAULTS, ...l } };
}

export async function createRunnerAgent({ config, publicClient, account, stateDir, fetchImpl, now = Date.now,
                                          sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const rc = checkRunnerConfig(config), L = rc.lifecycle;
  const agent = await createProofAgent({ config: rc.proof, publicClient, account, stateDir, fetchImpl, now, sleep, log });
  const cfg = agent.config, E = cfg.enclaveId, D = cfg.deployment, me = cfg.operator;
  const note = (o) => agent.note({ ...o, layer: "lifecycle" });

  // ---- at most ONE lifecycle transaction, chosen from the chain as it is now; null when nothing is due ----
  async function lifecycleStep() {
    const s = await agent.lease();
    if (!agent.attested) { const a = await agent.attest(); if (!a.ok) return { kind: "attest-failed", stop: true, reason: a.reason }; }
    const key = agent.attested.proofKey;
    // 1. the entry
    // a key goes on-chain only from a statement over a FRESH nonce, taken right now: an attestation from an earlier tick may name
    // a key a re-provisioned VM no longer holds (enclave-99's review of e4ecc4aa)
    const fresh = async () => { const a = await agent.attest(); return a.ok ? a.claims : null; };
    const freshKey = async () => { const c = await fresh(); return c ? c.proofKey : null; };
    const register = async (why) => {
      const c = await fresh();
      const k = c ? c.proofKey : null;
      if (!k) return { kind: "attest-failed", stop: true, reason: "no fresh attested key to register" };
      // the measurement published is EXACTLY the build this statement attests (and the config's value must be that build)
      const measurement = "0x" + c.codeHash;
      if (measurement !== L.register.measurement)
        return { kind: "measurement-mismatch", stop: true, reason: `the VM attests build ${c.codeHash}, the config says ${L.register.measurement}: nothing is registered` };
      return agent.sendCall({ op: `register (${why})`, contract: "registry", functionName: "register",
        args: [cfg.endpoint, L.register.repo, measurement, BigInt(L.register.cpuPricePerSec6), 0n, k], event: "Registered|Updated", eventId: E });
    };
    if (!s.regExists) return L.register ? register("new") : { kind: "registry-missing", stop: true, reason: "no registry entry, and the config does not register (the owner's repo, measurement and price)" };
    if (s.regOperator !== me) return { kind: "endpoint-taken", stop: true, reason: `the entry for ${cfg.endpoint} belongs to ${s.regOperator}: never touched` };
    if (!s.regActive) return L.register ? register("re-activate") : { kind: "registry-inactive", stop: true, reason: "the entry is inactive and the config does not register: not revived (a heartbeat would re-activate it)" };
    if (s.regProofKey !== key) {
      if (!L.syncProofKey) return { kind: "proof-key-mismatch", stop: true, reason: `the entry publishes ${s.regProofKey}, the VM attests ${key}` };
      const k = await freshKey();
      if (!k) return { kind: "attest-failed", stop: true, reason: "no fresh attested key to set" };
      if (k === s.regProofKey) return null;   // the fresh statement names the registered key: the earlier attestation was the stale one
      return agent.sendCall({ op: "setProofKey", contract: "registry", functionName: "setProofKey", args: [E, k], event: "ProofKeySet", eventId: E });
    }
    // 2. the lease
    const ours = s.runner === E && s.runnerOperator === me, live = s.leaseUntil >= s.headTs;
    if (s.active && ours && live) {
      if (s.leaseUntil - s.headTs <= BigInt(L.renewMarginSec)) {
        // "serving" = a proof LANDED recently (the prover's lastProofAt), not provenUntil: the prover advances provenUntil by at
        // most the time elapsed since the last proof, so after any outage longer than the window it trails now by the outage
        // for the rest of the lease even while fresh proofs land -- gating on it would never renew again
        const serving = s.lastProofAt + 2n * BigInt(cfg.policy.intervalSec) >= s.headTs;
        if (!serving) note({ ev: "renew-withheld", reason: `the last proof landed at ${s.lastProofAt} (now ${s.headTs}): a lease the app is not serving is left to lapse` });
        else return agent.sendCall({ op: "renew", contract: "deployments", functionName: "renew", args: [D], event: "Renewed", eventId: D });
      }
    } else if (s.active && L.claim && s.headTs > s.leaseUntil) {   // open: never leased, released, or a lapsed lease (ours re-claimed in place)
      const bond = BigInt(await agent.readLedger("claimBond6", []));
      if (bond > 0n) {
        const [have, exitAt] = await agent.readLedger("bondOf", [me]);
        if (!(BigInt(have) >= bond && BigInt(exitAt) === 0n))
          return { kind: "bond-required", reason: `the ledger asks a ${bond} claim bond; ${BigInt(L.maxClaimBond6) >= bond ? "posting one is not implemented here" : `the owner's ceiling is ${L.maxClaimBond6}`}: not claiming` };
      }
      // (unfunded, over the owner's rate cap, or taken meanwhile: the simulation refuses it with the ledger's own reason)
      const c = await agent.sendCall({ op: ours ? "claim (re-claim a lapsed lease)" : "claim", contract: "deployments", functionName: "claim", args: [D, E], event: "Claimed", eventId: D });
      return c.kind === "refused" ? { ...c, kind: "claim-refused" } : c;
    } else if (s.runner !== ZERO32 && !ours && live) note({ ev: "leased-to-another", runner: s.runner });
    // 3. the heartbeat
    if (s.regActive && s.headTs - s.regLastSeen >= BigInt(L.heartbeatSec))
      return agent.sendCall({ op: "heartbeat", contract: "registry", functionName: "heartbeat", args: [E], event: "Heartbeat", eventId: E });
    // 4. earnings, to the owner's payout address, when they reach the owner's minimum (the operator key never keeps them)
    if (L.payout) {
      const earned = BigInt(await agent.readLedger("earned6", [me]));
      if (earned >= BigInt(L.payout.minWithdraw6))
        return agent.sendCall({ op: "withdrawEarnings", contract: "deployments", functionName: "withdrawEarnings", args: [L.payout.to], event: "EarningsWithdrawn",
                                match: { operator: me, to: L.payout.to } });
    }
    return null;
  }

  // ---- one bounded round: anything in flight, then at most one lifecycle transaction, then the proof ----
  async function tick() {
    if (agent.pending) {
      const s = await agent.settlePending();
      if (agent.pending) { note({ ev: "tick", kind: "in-flight", settle: s.kind }); return { kind: "in-flight", settle: s }; }
      note({ ev: "settled", kind: s.kind, op: s.op });
    }
    const l = await lifecycleStep();
    if (l) note({ ev: "tick-lifecycle", ...l });
    if (agent.pending) return { kind: "in-flight", lifecycle: l };   // followed first on the next tick (or after a restart)
    if (l && l.stop) return { kind: l.kind, lifecycle: l };
    const p = await agent.tick();
    return { kind: p.kind, lifecycle: l, proof: p };
  }

  // ---- stop: a final proof, then release (in that order: release clears the watermark) ----
  async function stop({ release = false } = {}) {
    if (agent.pending) { const s = await agent.settlePending(); if (agent.pending) return { kind: "in-flight", settle: s }; }
    if (!release) return { kind: "stopped" };
    const s = await agent.lease();
    if (!(s.runner === E && s.runnerOperator === me)) return { kind: "not-our-lease", reason: "nothing to release" };
    let proof = null;
    if (s.leaseUntil > s.headTs) {
      const wait = agent.lastCheckpointAskAt + (cfg.policy.vmGapSec * 1000) - now();
      if (wait > 0 && wait <= L.finalProofWaitMs) await sleep(wait);   // the VM signs one checkpoint per 60 s
      proof = await agent.tick();
      note({ ev: "final-proof", kind: proof.kind, reason: proof.reason });
      if (agent.pending) return { kind: "in-flight", proof };
    }
    const r = await agent.sendCall({ op: "release", contract: "deployments", functionName: "release", args: [D], event: "Released", eventId: D });
    const after = await agent.lease();
    return { kind: r.kind === "landed" && after.runner === ZERO32 ? "released" : r.kind, proof, release: r };
  }

  async function start() { return agent.start(); }
  async function run({ ticks = Infinity, signal } = {}) {
    const outs = [];
    for (let i = 0; i < ticks && !(signal && signal.aborted); i++) {
      const t0 = now();
      try { outs.push(await tick()); } catch (e) { const o = { kind: "error", reason: e.shortMessage || e.message }; note({ ev: "tick", ...o }); outs.push(o); }
      if (i + 1 < ticks) { const wait = t0 + cfg.policy.intervalSec * 1000 - now(); if (wait > 0) await sleep(wait); }
    }
    return outs;
  }
  return { start, tick, stop, run, lifecycleStep, agent, close: () => agent.close() };
}
