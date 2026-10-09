// The pVM marketplace (shielded/anchor/avf/PVM-CPU.md "Serving buyers"): when a phone's protected VM may take buyers'
// CPU-only apps, and which app it serves now.
//
// CAPACITY (eligible): the relay's own verdicts only -- the row is an AVF tunnel the hub tiered pvm-cpu (an admitted, signed
// capability report from the attested VM: relay/pvm-cpu-tier.mjs), its attach was signed by the operator that registered
// its name on chain (the hub records `operator` only then), its id is that registered endpoint's, and the operator of this
// relay switched the market on (PVM_MARKET=1). Nothing the phone or its host says about itself enters.
//
// PER APP (servesUntil, certificate): the deployment is public, active, CPU-only, leased to THIS row, its options are ones a
// pVM serves (no configuration, secrets, protection rules or a confidential-computing demand), and its catalog version is
// listed and approved. The relay then asks the VM -- through the tunnel, via the host -- for v4 evidence over ITS OWN nonce
// (relay/pvm-app-attest.mjs verifyPvmAppEvidence, requireTls): a fresh AVF certificate rooted at Google that binds the pinned
// build, the pinned runtime, this VM instance, the transport key THIS tunnel attached with, and the app -- the SHA-256 of the
// component the relay itself fetched by the catalog's CID -- plus the TLS key, signed by that transport key. Only then is the
// deployment served (routes, TUNA) for TTL, and a certificate issued only for exactly that TLS key. A failure that says
// nothing about the app (busy, unreachable, the gateway) leaves the last verdict to expire on its own; any other revokes it.
import { randomBytes, createHash } from "node:crypto";
import { verifyPvmAppEvidence } from "./pvm-app-attest.mjs";
import { CATALOG_REF_RE, versionRefusal } from "./measurement-predict.mjs";

export const PVM_ISOLATION_BACKEND = "avf-pvm-per-app";
const TTL_MS = 10 * 60_000, REFRESH_MS = 4 * 60_000, MAX_COMPONENT = 256 << 20;
const TRANSIENT = [/^RPC Request failed/, /^HTTP request failed/, /^The request took too long/, /^Request timed out/, /^fetch failed/,
  /^tunnel request timeout/, /^no tunnel for/, /^pVM verification busy/, /^no evidence from the live host/, /^the component could not be CID-verified/];
export const pvmTransient = (m) => TRANSIENT.some((r) => r.test(String(m || "")));
const fingerprint = (d) => JSON.stringify([String(d.id).toLowerCase(), String(d.runner).toLowerCase(), d.appRef, d.configCid, !!d.isPublic, Number(d.cpuMilli),
  Number(d.gpuMilli), !!d.active, String(d.owner || "").toLowerCase()]);

/** Why a pVM does not serve this deployment's OPTIONS, or null (the ledger row only; the catalog and evidence come after). */
export function pvmOptionsRefusal(d) {
  if (!d || d.active !== true) return "the deployment is not active";
  if (d.isPublic !== true) return "only public deployments are served by a pVM host";
  if (Number(d.gpuMilli) !== 0) return "a pVM host serves CPU-only deployments (gpuMilli 0)";
  const raw = String(d.configCid || "").trim();
  let env = {};
  if (raw) { try { env = JSON.parse(raw); } catch { return "the options envelope is not JSON"; } }
  if (!env || typeof env !== "object" || Array.isArray(env)) return "the options envelope is not an object";
  const bad = Object.keys(env).filter((k) => !["isolation", "network", "placement", "gpu"].includes(k));
  if (bad.length) return `options ${bad.join(", ")} are not served by a pVM host`;
  const iso = env.isolation;
  if (iso !== undefined && (!iso || typeof iso !== "object" || Array.isArray(iso) || Object.keys(iso).some((k) => !["require", "cpuTee", "gpuTee"].includes(k))
      || iso.cpuTee === true || iso.gpuTee === true || (iso.require !== undefined && iso.require !== PVM_ISOLATION_BACKEND)))
    return `the deployment's isolation requirement is not ${PVM_ISOLATION_BACKEND}`;
  const n = env.network;
  if (n !== undefined && (!n || typeof n !== "object" || Object.keys(n).some((k) => !["transport", "relay"].includes(k)) || (n.transport !== undefined && n.transport !== "tuna")))
    return "the deployment's network options are not TUNA";
  if (env.gpu !== undefined && (!env.gpu || typeof env.gpu !== "object" || env.gpu.optional !== true)) return "the deployment's gpu options are not { optional: true }";
  return null;
}

// rootPins: the attestation roots (default: Google's, relay/avf-verify.mjs); tests pass their own CA's.
export function createPvmMarket({ hub, enabled = false, pins = null, confirmRow, readCatalog, fetchVerified, hasSecrets = () => false,
                                  rootPins = undefined, now = Date.now, log = console.warn } = {}) {
  const on = enabled === true && !!pins;
  if (enabled === true && !pins) log("[pvm-market] PVM_MARKET is set but the pVM CPU pins are not: the market stays off");
  const apps = new Map();              // `${row.name}|${d.id}` -> { until, checked, fingerprint, keyFp, tlsSpkiSha256 }
  const attempts = new Map();          // same key -> last attempt (ms)
  const components = new Map();        // cid -> sha256 hex (CID-verified bytes)
  let active = 0, refreshing = false;
  const info = (row) => (row && row.name ? hub.info(row.name) : null);
  function eligible(row) {
    if (!on || !row || row.tunnel !== true || row.mode !== "avf" || row.tier !== "pvm-cpu" || !/^0x[0-9a-f]{64}$/i.test(String(row.id || ""))) return false;
    const t = info(row);
    return !!(t && t.mode === "avf" && t.tier === "pvm-cpu" && /^0x[0-9a-f]{40}$/.test(String(t.operator || "")));
  }
  const keyOf = (row, d) => `${row.name}|${String(d.id).toLowerCase()}`;
  function servesUntil(row, d) {
    if (!eligible(row) || !d) return 0;
    const a = apps.get(keyOf(row, d)), t = info(row);
    if (!a || a.until <= now() || a.fingerprint !== fingerprint(d) || a.keyFp !== t.keyFp || pvmOptionsRefusal(d) || hasSecrets(String(d.id).toLowerCase()))
      return 0;
    if (String(d.runner).toLowerCase() !== String(row.id).toLowerCase() || Number(d.leaseUntil) * 1000 <= now()) return 0;
    return Math.floor(Math.min(a.until, Number(d.leaseUntil) * 1000) / 1000);
  }
  async function expectedApp(d) {
    const ref = CATALOG_REF_RE.exec(String(d.appRef || ""));
    if (!ref) throw new Error("catalog app reference required");
    const c = await readCatalog(ref[1].toLowerCase(), Number(ref[2]));
    const refusal = versionRefusal(c && c.app, c && c.version, false);
    if (refusal) throw new Error(refusal);
    const cid = String(c.version.cid);
    if (!components.has(cid)) {
      const got = await fetchVerified(cid, MAX_COMPONENT);
      if (!got || !got.ok || !Buffer.isBuffer(got.bytes)) throw new Error("the component could not be CID-verified");
      components.set(cid, createHash("sha256").update(got.bytes).digest("hex"));
      if (components.size > 256) components.delete(components.keys().next().value);
    }
    return components.get(cid);
  }
  async function admit(row, candidate, csrSpkiSha256) {
    if (!eligible(row)) return { ok: false, reason: "not an admitted pVM host" };
    if (active >= 2) return { ok: false, reason: "pVM verification busy; retry shortly" };
    active++;
    const k = keyOf(row, candidate);
    attempts.set(k, now());
    try {
      const d = await confirmRow(String(candidate.id).toLowerCase());
      const opt = pvmOptionsRefusal(d);
      if (opt) throw new Error(opt);
      if (hasSecrets(String(d.id).toLowerCase())) throw new Error("a deployment with sealed secrets is not served by a pVM host");
      if (String(d.runner).toLowerCase() !== String(row.id).toLowerCase() || Number(d.leaseUntil) * 1000 <= now())
        throw new Error("the deployment is not leased to this host");
      const appId = await expectedApp(d);
      const t = info(row), keyFp = t.keyFp;
      const nonce = randomBytes(32).toString("hex");
      const doc = await hub.fetchJson(`tunnel://${row.name}`, `/v1/pvm/evidence?deployment=${String(d.id).toLowerCase()}&nonce=${nonce}`);
      if (!doc || typeof doc !== "object" || doc.error) throw new Error(`no evidence from the live host${doc && doc.error ? `: ${String(doc.error).slice(0, 120)}` : ""}`);
      const v = verifyPvmAppEvidence(doc, { nonce, appId, requireTls: true, allowedRuntimeIds: [...pins.runtimeIds],
        allowedCodeHashes: [...pins.codeHashes], allowedAuthorityHashes: [...pins.authorityHashes], ...(rootPins ? { rootPins } : {}) });
      if (!v.ok) throw new Error(v.reasons.at(-1));
      // the evidence's transport key must be the one THIS tunnel attached with: another VM's genuine evidence is not this host's
      if (createHash("sha256").update(Buffer.from(v.transportSpki, "hex")).digest("hex") !== keyFp || info(row)?.keyFp !== keyFp)
        throw new Error("the evidence is not from the VM attached as this host");
      if (csrSpkiSha256 !== undefined && csrSpkiSha256 !== v.tlsSpkiSha256) throw new Error("the certificate key differs from the VM's evidenced TLS key");
      const current = await confirmRow(String(d.id).toLowerCase());
      if (fingerprint(current) !== fingerprint(d)) throw new Error("the deployment changed during verification");
      const until = now() + TTL_MS;
      apps.set(k, { until, checked: now(), fingerprint: fingerprint(d), keyFp, tlsSpkiSha256: v.tlsSpkiSha256 });
      log(`[pvm-market] verified ${row.name}/${String(d.id).slice(0, 10)}: app ${appId.slice(0, 12)}, TLS key ${v.tlsSpkiSha256.slice(0, 12)}, instance ${String(v.instanceId).slice(0, 12)}`);
      return { ok: true, spkiSha256: v.tlsSpkiSha256, until };
    } catch (e) {
      if (!pvmTransient(e.message)) apps.delete(k);
      return { ok: false, reason: e.message };
    } finally { active--; }
  }
  async function refresh(hosts, rows) {
    if (!on || refreshing) return;
    refreshing = true;
    try {
      for (const row of hosts.filter(eligible)) {
        const leased = rows.filter((d) => d && d.active === true && d.isPublic === true && String(d.runner).toLowerCase() === String(row.id).toLowerCase()
          && Number(d.leaseUntil) * 1000 > now()).slice(0, 8);
        for (const d of leased) {
          const k = keyOf(row, d), a = apps.get(k);
          if (attempts.has(k) && now() - attempts.get(k) < REFRESH_MS / 4) continue;
          if (a && now() - a.checked < REFRESH_MS && servesUntil(row, d)) continue;
          const r = await admit(row, d);
          if (!r.ok) log(`[pvm-market] ${row.name}/${String(d.id).slice(0, 10)}: ${r.reason}`);
        }
      }
      for (const [k, a] of apps) if (a.until <= now()) apps.delete(k);
    } finally { refreshing = false; }
  }
  /** The deployments this row serves now, each with its `until` (unix seconds). */
  function served(row, rows) {
    if (!eligible(row)) return [];
    const t = Math.floor(now() / 1000);
    return rows.map((d) => ({ id: String(d.id).toLowerCase(), until: servesUntil(row, d) })).filter((x) => x.until > t);
  }
  return { enabled: on, eligible, servesUntil, served, refresh, certificate: (row, d, spki) => admit(row, d, spki) };
}
