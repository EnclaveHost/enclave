/* ============================================================
   Wallet-direct uploads to every adapter in the profile's storage plan.

   The same protocol as the CLI (sdk/storage/artifacts.mjs and
   sdk/bootstrap/storage.mjs), in the browser:
     1. compute the CID locally (js/core/unixfs.js) - no adapter is asked
        what the bytes are called;
     2. one wallet signature per adapter, bound to that adapter's
        deployment (audience), route, exact SHA-256, size and expiry
        (js/core/upload-auth.js; there is no upload-token service);
     3. upload; the adapter's answer must be exactly the local CID;
     4. read every byte back from that adapter's own gateway in bounded
        ranges and compare with the local bytes;
     5. succeed only with plan.minimumCopies verified copies.
   An acknowledgement alone never counts, a failed adapter never blocks
   the others, and nothing here falls back to Enclave's adapter.
   Verified copies prove availability now, not retention later, and
   distinct hostnames do not prove distinct operators.
   ============================================================ */
import { artifactIdentity, rawCid, hex } from "./unixfs.js";
import { directUploadDigestHeaders, accountUploadDigestHeaders } from "./upload-auth.js";
import { validateStoragePlan } from "./independent.js";

const WINDOW = 4 * 1024 * 1024;
export const KINDS = {
  file:  { path: "/add-file",  type: "application/octet-stream", max: 2 * 1024 * 1024 * 1024 },
  wasm:  { path: "/add-wasm",  type: "application/wasm",         max: 2 * 1024 * 1024 * 1024 },
  json:  { path: "/add-json",  type: "application/json",         max: 1024 * 1024 },
  image: { path: "/add-image", type: "application/octet-stream", max: 4 * 1024 * 1024 },
};

async function boundedBytes(res, limit){
  if (Number(res.headers.get("content-length")) > limit){ await res.body?.cancel(); throw new Error("response too large"); }
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, limit + 1);
  const reader = res.body.getReader(); const parts = []; let size = 0;
  try {
    for (;;){
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new Error("response too large");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(size); let o = 0; for (const p of parts){ out.set(p, o); o += p.length; }
  return out;
}

/* Exact-byte readback: every window must be the local bytes at that offset. */
async function readback(cid, bytes, gateway, fetchImpl, signal){
  for (let start = 0; start < bytes.length || start === 0; start += WINDOW){
    const size = Math.min(WINDOW, bytes.length - start), end = start + size - 1;
    const headers = { "cache-control": "no-cache", ...(size ? { range: `bytes=${start}-${end}` } : {}) };
    const res = await fetchImpl(`${gateway}/${cid}`, { redirect: "error", credentials: "omit", cache: "no-store", signal, headers });
    const whole = res.status === 200 && start === 0 && size === bytes.length;
    const partial = res.status === 206 && res.headers.get("content-range") === `bytes ${start}-${end}/${bytes.length}`;
    if (!whole && !partial){ await res.body?.cancel(); throw new Error("readback range refused or changed"); }
    const got = await boundedBytes(res, size);
    if (got.length !== size) throw new Error("truncated readback");
    const want = bytes.subarray(start, start + size);
    for (let i = 0; i < size; i++) if (got[i] !== want[i]) throw new Error("readback bytes differ");
    if (!size) break;
  }
}

const deadlineFor = (n) => Math.min(3600000, 240000 + Math.ceil(n / 1048576) * 1000);

async function collect(plan, identity, operation){
  const results = await Promise.all(plan.replicas.map(async (replica, index) => {
    try { await operation(replica, index); return { index, ...replica, verified: true }; }
    catch (e){
      return { index, ...replica, verified: false,
        reason: e && e.name === "TimeoutError" ? "deadline exceeded" : "upload or exact-byte readback failed: " + String(e && e.message || e).slice(0, 160) };
    }
  }));
  const copies = results.filter((r) => r.verified), failures = results.filter((r) => !r.verified);
  const report = { version: 1, cid: identity.cid, sha256: identity.sha256, minimumCopies: plan.minimumCopies,
    verifiedCopies: copies.length, copies, failures, checkedAt: new Date().toISOString(), independentOperatorsVerified: false };
  if (copies.length < plan.minimumCopies){
    const e = new Error(`storage requirement not met: ${copies.length} of ${plan.minimumCopies} required copies verified`
      + (failures.length ? " (" + failures.map((f) => new URL(f.upload).host + ": " + f.reason).join("; ") + ")" : ""));
    e.report = report; throw e;
  }
  return report;
}

/* Publish `bytes` (Uint8Array) of `kind` to the plan. signer is either a wallet key, { address,
   signMessage({message}) -> 0x signature } (EIP-191, upload v1), or a smart ACCOUNT, { kind: "erc1271", account,
   chainId, sign(message) -> 0x ERC-1271 bytes } (upload v2: the adapter asks the account's own contract).
   onProgress(sentBytes, totalBytes) aggregates every adapter's upload. */
export async function publishToPlan(bytes, kind, rawPlan, signer, { fetchImpl = (...a) => globalThis.fetch(...a), onProgress, identity: known } = {}){
  const plan = validateStoragePlan(rawPlan), format = KINDS[kind];
  if (!format || !(bytes instanceof Uint8Array) || bytes.length > format.max) throw new Error("invalid upload kind or size");
  const account = signer && signer.kind === "erc1271";
  if (!signer || !/^0x[0-9a-fA-F]{40}$/.test((account ? signer.account : signer.address) || ""))
    throw new Error(account ? "the account to authorize the upload is missing" : "connect a wallet to authorize the upload");
  const identity = known || await artifactIdentity(bytes);
  // Sign first, for every adapter, so a declined signature uploads nothing anywhere.
  const headers = [];
  for (const replica of plan.replicas)
    headers.push(account
      ? await accountUploadDigestHeaders({ audience: replica.audience, url: new URL(format.path, replica.upload).href,
          account: signer.account, chainId: signer.chainId, hash: identity.sha256, size: identity.bytes, sign: (m) => signer.sign(m) })
      : await directUploadDigestHeaders({ audience: replica.audience, url: new URL(format.path, replica.upload).href,
          address: signer.address, hash: identity.sha256, size: identity.bytes, signMessage: (a) => signer.signMessage(a) }));
  const body = new Blob([bytes], { type: format.type });
  const sent = plan.replicas.map(() => 0);
  const report = await collect(plan, identity, async (replica, index) => {
    const signal = AbortSignal.timeout(deadlineFor(bytes.length));
    const res = await fetchImpl(new URL(format.path, replica.upload).href, { method: "POST", redirect: "error", credentials: "omit",
      signal, headers: { "content-type": format.type, ...headers[index] }, body });
    if (!res.ok){ await res.body?.cancel(); throw new Error("adapter refused the upload (HTTP " + res.status + ")"); }
    let answer; try { answer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(res, 4096))); }
    catch { throw new Error("adapter answer is not JSON"); }
    if (!answer || answer.cid !== identity.cid) throw new Error("adapter named a different CID than the local import");
    sent[index] = bytes.length; if (onProgress) onProgress(sent.reduce((a, b) => a + b, 0), bytes.length * plan.replicas.length);
    await readback(identity.cid, bytes, replica.gateway, fetchImpl, signal);
  });
  return { ...report, kind, bytes: identity.bytes };
}

/* Re-check that the plan still holds `bytes` without uploading or signing. */
export async function verifyOnPlan(bytes, rawPlan, { fetchImpl = (...a) => globalThis.fetch(...a), identity: known } = {}){
  const plan = validateStoragePlan(rawPlan), identity = known || await artifactIdentity(bytes);
  return collect(plan, identity, (replica) => readback(identity.cid, bytes, replica.gateway, fetchImpl, AbortSignal.timeout(deadlineFor(bytes.length))));
}

/* Startup packages ride /add-json as RAW blocks (sdk/bootstrap/storage.mjs):
   the adapter answers the raw-leaf CID of the exact bytes. */
export async function publishPackageToPlan(bytes, rawPlan, signer, opts = {}){
  const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  return publishToPlan(bytes, "json", rawPlan, signer, { ...opts, identity: { cid: rawCid(sha256), sha256, bytes: bytes.length } });
}
export async function verifyPackageOnPlan(bytes, rawPlan, opts = {}){
  const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  return verifyOnPlan(bytes, rawPlan, { ...opts, identity: { cid: rawCid(sha256), sha256, bytes: bytes.length } });
}
