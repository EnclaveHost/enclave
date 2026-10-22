// Relay-free admission of a pVM host (a phone's protected VM) for ONE deployment. What relay/pvm-market.mjs decided for the
// fleet, any verifier now decides for itself -- a client before it sends, a directory before it lists, an owner, an auditor --
// with the SAME verifier code and no Enclave service in any required role:
//   1. the chain, at ONE snapshot the caller's agreeing RPC quorum read: the deployment is active, public, its options are a
//      pVM's (relay/pvm-market.mjs pvmOptionsRefusal), it is leased NOW to this host, the lease's runnerOperator is the
//      host's registry operator, the registry row is active and names a proof key;
//   2. the platform host policy (the admin's anchored ban/allowlist, network/host-policy-adapters.mjs leaseHostAdmission):
//      anything but an explicit admit refuses -- admin bans stay enforced;
//   3. the catalog version is listed and approved (relay/measurement-predict.mjs versionRefusal), and the app is the SHA-256 of
//      the component the VERIFIER fetched by its CID (content-bound; the caller chooses the sources);
//   4. a FRESH nonce made here: the VM's v4 evidence over it (relay/pvm-app-attest.mjs verifyPvmAppEvidence: Google's roots
//      or the caller's, the pinned build, authority and runtime, the instance, the TLS key), and its sibling statement over
//      the same nonce recovering to the registry's proof key (relay/pvm-market.mjs checkSibling) -- the VM is THIS host's;
//   5. the chain read again: nothing that decided 1-3 changed meanwhile.
// The host's answers travel over `transport`, any carrier (the host's own route, a directory mailbox, or a relay used as an
// opaque pipe): nothing it carries is believed until it verifies here, so the carrier is never an authority.
import { randomBytes, createHash } from "node:crypto";
import { verifyPvmAppEvidence } from "../relay/pvm-app-attest.mjs";
import { pvmOptionsRefusal, checkSibling } from "../relay/pvm-market.mjs";
import { CATALOG_REF_RE, versionRefusal } from "../relay/measurement-predict.mjs";

const lc = (s) => String(s || "").toLowerCase();
const B32 = /^0x[0-9a-f]{64}$/, ADDR = /^0x[0-9a-f]{40}$/, ZERO_ADDR = "0x" + "0".repeat(40);
export const ADMISSION_TTL_MS = 10 * 60_000;

/** The facts a decision rests on; a change between the two reads refuses. */
const fingerprint = (s) => JSON.stringify([lc(s.deployment.id), lc(s.deployment.runner), lc(s.deployment.runnerOperator), s.deployment.appRef, String(s.deployment.configCid || ""),
  !!s.deployment.isPublic, !!s.deployment.active, Number(s.deployment.cpuMilli), Number(s.deployment.gpuMilli), lc(s.deployment.owner), String(s.deployment.leaseUntil),
  lc(s.registry.operator), !!s.registry.active, lc(s.registry.proofKey)]);

/**
 * createPvmIndependentAdmission({ readState, fetchComponent, pins, hostAdmission, transport, rootPins?, now?, random? })
 *   readState(deploymentId) -> { block, deployment, registry, catalog: { app, version } }  ONE agreed chain snapshot
 *   fetchComponent(cid) -> Buffer                     CID-verified bytes from sources the caller chose
 *   pins: { codeHashes[], authorityHashes[], runtimeIds[], rootPins[]? }  the verified verifier inputs (independent.mjs)
 *   hostAdmission(lease) -> { admit, reason }         the platform host policy decision (required: never off by default)
 *   transport: { evidence(hostId, deploymentId, nonceHex), sibling(hostId, deploymentId, nonceHex) } -> the host's JSON
 * -> { admit(deploymentId, hostId) -> { ok: true, ... } | { ok: false, stage, reason } }
 */
export function createPvmIndependentAdmission({ readState, fetchComponent, pins, hostAdmission, transport, rootPins, now = Date.now, random = () => randomBytes(32).toString("hex") }) {
  if (typeof readState !== "function" || typeof fetchComponent !== "function" || typeof hostAdmission !== "function" || !transport
      || typeof transport.evidence !== "function" || typeof transport.sibling !== "function")
    throw new Error("pVM admission needs readState, fetchComponent, hostAdmission and a transport (evidence, sibling)");
  for (const k of ["codeHashes", "authorityHashes", "runtimeIds"]) if (!Array.isArray(pins?.[k]) || !pins[k].length) throw new Error(`pVM admission needs pins.${k}`);
  const roots = rootPins || pins.rootPins;
  const components = new Map();
  async function appIdOf(cid) {
    if (!components.has(cid)) {
      const bytes = await fetchComponent(cid);
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("the component could not be CID-verified");
      components.set(cid, createHash("sha256").update(bytes).digest("hex"));
      if (components.size > 256) components.delete(components.keys().next().value);
    }
    return components.get(cid);
  }
  async function admit(deploymentId, hostId) {
    const D = lc(deploymentId), H = lc(hostId);
    if (!B32.test(D) || !B32.test(H)) return { ok: false, stage: "input", reason: "a deployment id and a host (registry) id are required" };
    let stage = "chain";
    try {
      const s1 = await readState(D);
      const d = s1.deployment, r = s1.registry;
      if (!d || lc(d.id) !== D) throw new Error("the chain has no such deployment");
      const opt = pvmOptionsRefusal(d, { gpuOptional: true });
      if (opt) throw new Error(opt);
      if (lc(d.runner) !== H || Number(d.leaseUntil) * 1000 <= now()) throw new Error("the deployment is not leased to this host now");
      if (!r || r.active !== true) throw new Error("the host's registry entry is not active");
      if (!ADDR.test(lc(r.operator)) || lc(d.runnerOperator) !== lc(r.operator)) throw new Error("the lease's operator is not the host's registry operator");
      if (!ADDR.test(lc(r.proofKey)) || lc(r.proofKey) === ZERO_ADDR) throw new Error("the host registers no proof key");
      stage = "policy";
      const p = await hostAdmission({ id: D, runner: H, runnerOperator: lc(d.runnerOperator), owner: lc(d.owner) });
      if (!p || p.admit !== true) throw new Error(`the platform host policy refuses this host: ${p?.reason || "no decision"}`);
      stage = "catalog";
      const ref = CATALOG_REF_RE.exec(String(d.appRef || ""));
      if (!ref) throw new Error("catalog app reference required");
      const { app, version } = s1.catalog || {};
      const vr = versionRefusal(app, version, false);
      if (vr) throw new Error(vr);
      let gpuOptional = false; try { gpuOptional = JSON.parse(String(version.config || "{}") || "{}").gpuOptional === true; } catch {}
      const soft = pvmOptionsRefusal(d, { gpuOptional });
      if (soft) throw new Error(soft);
      const appId = await appIdOf(String(version.cid));
      stage = "evidence";
      const nonce = random();
      if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("no fresh nonce");
      const doc = await transport.evidence(H, D, nonce);
      if (!doc || typeof doc !== "object" || doc.error) throw new Error(`no evidence from the host${doc && doc.error ? `: ${String(doc.error).slice(0, 160)}` : ""}`);
      const v = verifyPvmAppEvidence(doc, { nonce, appId, requireTls: true, allowedRuntimeIds: [...pins.runtimeIds], allowedCodeHashes: [...pins.codeHashes],
        allowedAuthorityHashes: [...pins.authorityHashes], ...(roots ? { rootPins: [...roots] } : {}) });
      if (!v.ok) throw new Error(v.reasons.at(-1));
      stage = "binding";
      const sib = await transport.sibling(H, D, nonce);
      if (!sib || typeof sib !== "object" || sib.error) throw new Error(`no sibling statement from the host${sib && sib.error ? `: ${String(sib.error).slice(0, 160)}` : ""}`);
      await checkSibling(sib, { nonce, deployment: D, transportSpki: v.transportSpki, instanceId: v.instanceId, proofKey: r.proofKey });
      stage = "recheck";
      const s2 = await readState(D);
      if (fingerprint(s2) !== fingerprint(s1)) throw new Error("the deployment, its lease or the host's registry entry changed during verification");
      const until = Math.min(now() + ADMISSION_TTL_MS, Number(d.leaseUntil) * 1000);
      return { ok: true, deployment: D, host: H, operator: lc(r.operator), appId, instanceId: v.instanceId, transportSpki: v.transportSpki,
               tlsSpkiSha256: v.tlsSpkiSha256, measurement: v.measurement, runtimeId: v.runtimeId, block: String(s1.block), until, policy: p.status || "admit" };
    } catch (e) {
      return { ok: false, stage, reason: e.message };
    }
  }
  return { admit };
}

/**
 * The host side's answers for `transport`, from the host agent's own surface (shielded/anchor/avf/runner/host-agent.mjs
 * /v1/pvm/evidence and /v1/pvm/sibling) at `base` -- through whatever carries bytes to it. Bounded JSON, no redirects.
 */
export function hostSurfaceTransport({ base, fetch = globalThis.fetch, timeoutMs = 45000, maxBytes = 256 * 1024 }) {
  const get = async (p) => {
    const r = await fetch(new URL(p, base).href, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const chunks = []; let n = 0;
    for await (const c of r.body || []) { n += c.length; if (n > maxBytes) throw new Error("the host's answer is too large"); chunks.push(Buffer.from(c)); }
    const text = Buffer.concat(chunks).toString("utf8");
    try { return JSON.parse(text); } catch { throw new Error("the host's answer is not JSON"); }
  };
  return {
    evidence: (_h, d, nonce) => get(`/v1/pvm/evidence?deployment=${d}&nonce=${nonce}`),
    sibling: (_h, d, nonce) => get(`/v1/pvm/sibling?deployment=${d}&nonce=${nonce}`),
  };
}
