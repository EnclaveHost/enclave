// Owner-signed relay calls for the canary ids, with the relay's own message formats (relay/secrets.js putMessage /
// getMessage; cli/enclave.mjs secretsCall: expiry = now + 300). Reads return METADATA ONLY: names, rev, and whether
// each value equals the local marker (by commitment). Values never leave this module. fetch and the signer are
// injected, so tests touch no network and no key.
import { createHash } from "node:crypto";
import { commitmentOf } from "./markers.mjs";

export const putMessage = (id, expiry, payload) => `enclave-secrets:put:${id}:${expiry}:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
export const getMessage = (id, expiry) => `enclave-secrets:get:${id}:${expiry}`;
const H32 = /^0x[0-9a-f]{64}$/;

async function post(fetchImpl, api, path, body, timeoutMs = 20_000) {
  const r = await fetchImpl(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

export function createRelay({ api, fetchImpl = fetch, now = () => Date.now() }) {
  if (!/^https:\/\/[a-z0-9.-]+$/.test(api)) throw new Error("relay api must be an https origin");
  const expiry = () => Math.floor(now() / 1000) + 300;
  return {
    async exists(id) {
      if (!H32.test(id)) throw new Error("id");
      const r = await post(fetchImpl, api, "/v1/secrets/exists", { id });
      return { status: r.status, exists: r.body?.exists === true, custody: r.body?.custody === true };
    },
    // marker: { run, set, values } (in memory) — compared by commitment, never returned
    async getMeta(id, signer, marker = null) {
      const e = expiry();
      const signature = await signer.signMessage({ message: getMessage(id, e) });
      const r = await post(fetchImpl, api, `/v1/secrets/${id}/get`, { expiry: e, signature });
      const env = r.body && typeof r.body.env === "object" && r.body.env ? r.body.env : {};
      const names = Object.keys(env).sort();
      const out = { status: r.status, error: r.body?.error ?? null, rev: r.body?.rev ?? null, names };
      if (marker) out.valuesEqualMarkers = names.length === Object.keys(marker.values).length
        && names.every((n) => n in marker.values && commitmentOf({ run: marker.run, set: marker.set, name: n, value: env[n] }) === commitmentOf({ run: marker.run, set: marker.set, name: n, value: marker.values[n] }));
      return out;
    },
    // the plaintext env for ONE migration step, handed straight to buildBundleV2 and never logged
    async getValuesForMigration(id, signer) {
      const e = expiry();
      const signature = await signer.signMessage({ message: getMessage(id, e) });
      const r = await post(fetchImpl, api, `/v1/secrets/${id}/get`, { expiry: e, signature });
      if (r.status !== 200 || !r.body?.env || !Object.keys(r.body.env).length) throw new Error(`relay holds no values for ${id} (HTTP ${r.status})`);
      return { rev: r.body.rev, env: r.body.env };
    },
    async put(id, signer, payloadObj) {
      const payload = JSON.stringify(payloadObj);
      const e = expiry();
      const signature = await signer.signMessage({ message: putMessage(id, e, payload) });
      const r = await post(fetchImpl, api, `/v1/secrets/${id}`, { payload, expiry: e, signature });
      return { status: r.status, error: r.body?.error ?? null };
    },
  };
}

// --- evaluations (pure) ---
export function evalLegacyCheck({ meta, exists, markerNames }) {
  const ok = meta.status === 200 && meta.valuesEqualMarkers === true && JSON.stringify(meta.names) === JSON.stringify([...markerNames].sort())
    && exists.exists === true && exists.custody === false;
  return { outcome: ok ? "pass" : "fail", evidence: { getStatus: meta.status, names: meta.names, valuesEqualMarkers: meta.valuesEqualMarkers, exists: exists.exists, custody: exists.custody } };
}
export function evalRelayRefusals({ heldSet, strangerGet, exists }) {
  const ok = heldSet.status === 409 && heldSet.error === "custody_held" && [401, 403].includes(strangerGet.status) && strangerGet.names.length === 0 && exists.custody === true;
  return { outcome: ok ? "pass" : "fail", evidence: { heldSet, strangerGet: { status: strangerGet.status, error: strangerGet.error, names: strangerGet.names.length }, exists } };
}
export function evalClearProof({ ownerGet, hasIdOnRelayHost, markerSearch, retentionListed }) {
  const reasons = [];
  if (ownerGet.status !== 200 || ownerGet.names.length !== 0) reasons.push("owner /get still names values");
  if (hasIdOnRelayHost !== false) reasons.push("secrets.json still has the id (root R5 read)");
  if (markerSearch?.outcome !== "pass") reasons.push("marker search did not pass");
  if (!Array.isArray(retentionListed)) reasons.push("R6 retention inventory (backups/snapshots) not recorded");
  return { outcome: reasons.length ? "fail" : "pass", evidence: { ownerGetNames: ownerGet.names.length, ownerGetRev: ownerGet.rev, hasIdOnRelayHost, retentionListed,
    limitation: "clears the live relay store only; backups, snapshots, journals of earlier hosts and process memory are listed, not cleared" }, reasons };
}
