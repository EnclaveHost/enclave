// Pre-attestation refusal probes against the REAL custodian (public endpoint). No attestation is sent or claimed:
// the evidence field is a deliberately non-evidence object, so every request is refused before any partial could be
// made. These show nonce single use/expiry and the chain-revision gates on the live custodian; they are NOT
// attestation evidence and NOT state anti-replay.
import { randomBytes } from "node:crypto";

const NOT_EVIDENCE = Object.freeze({ format: "enclave-canary-not-evidence/1" });
const PARTIAL_KEYS = /partial|share|sealed|plaintext|env/i;

async function post(fetchImpl, base, path, body, timeoutMs = 20_000) {
  const r = await fetchImpl(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
    redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, code: j?.error ?? null, keys: j && typeof j === "object" ? Object.keys(j) : [] };
}

export function releaseBody({ id, endpoint, committeeId, epoch, policyRev, secretRev, challenge, rng = randomBytes, nowSec }) {
  return { v: 2, id, endpoint, committeeId, epoch, policyRev: String(policyRev), secretRev: String(secretRev),
    recipientKey: "0x" + rng(32).toString("hex"), challenges: [{ encKey: challenge.encKey, nonce: challenge.nonce }],
    operator: { sig: "0x" + "00".repeat(65), expiry: nowSec + 300 }, evidence: NOT_EVIDENCE };
}

async function challenge(fetchImpl, base) {
  const r = await fetchImpl(`${base}/v2/custody/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    redirect: "error", signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => null);
  if (r.status !== 200 || !/^0x[0-9a-f]{64}$/.test(String(j?.encKey)) || typeof j?.nonce !== "string") throw new Error(`challenge: HTTP ${r.status}`);
  return { encKey: j.encKey, nonce: j.nonce };
}

// cur: { id, endpoint (the lease runner), committeeId, epoch, policyRev, secretRev } as read at an agreed block.
export async function probeNonce({ base, cur, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), nowSec = () => Math.floor(Date.now() / 1000), expiryWaitMs = 125_000 }) {
  const body = releaseBody({ ...cur, challenge: await challenge(fetchImpl, base), nowSec: nowSec() });
  const first = await post(fetchImpl, base, "/v2/custody/release", body);
  const replay = await post(fetchImpl, base, "/v2/custody/release", body);
  const late = await challenge(fetchImpl, base);
  await sleep(expiryWaitMs);
  const expired = await post(fetchImpl, base, "/v2/custody/release", releaseBody({ ...cur, challenge: late, nowSec: nowSec() }));
  return evalNonce({ first, replay, expired });
}

export function evalNonce({ first, replay, expired }) {
  const noPartial = [first, replay, expired].every((r) => !r.keys.some((k) => PARTIAL_KEYS.test(k)));
  const ok = first.status >= 400 && replay.status === 403 && replay.code === "bad_challenge" && expired.status === 403 && expired.code === "bad_challenge" && noPartial;
  return { outcome: ok ? "pass" : "fail", evidence: { first: { status: first.status, code: first.code }, replay: { status: replay.status, code: replay.code },
    expired: { status: expired.status, code: expired.code }, noPartial, scope: "pre-attestation refusal on the live custodian; not attestation evidence" } };
}

export async function probeStale({ base, cur, fetchImpl = fetch, nowSec = () => Math.floor(Date.now() / 1000) }) {
  const fresh = () => challenge(fetchImpl, base);
  const variants = {
    staleRevision: { ...cur, policyRev: BigInt(cur.policyRev) - 1n, secretRev: BigInt(cur.secretRev) - 1n },
    wrongCommittee: { ...cur, committeeId: "0x" + "ab".repeat(32) },
    staleEpoch: { ...cur, epoch: cur.epoch + 1 },
  };
  const out = {};
  for (const [k, v] of Object.entries(variants)) out[k] = await post(fetchImpl, base, "/v2/custody/release", releaseBody({ ...v, challenge: await fresh(), nowSec: nowSec() }));
  return evalStale(out);
}

export function evalStale(r) {
  const want = { staleRevision: [409, "stale_revision"], wrongCommittee: [409, "wrong_committee"], staleEpoch: [409, "stale_epoch"] };
  const results = Object.fromEntries(Object.entries(want).map(([k, [s, c]]) => [k, { status: r[k]?.status, code: r[k]?.code, ok: r[k]?.status === s && r[k]?.code === c && !r[k].keys.some((x) => PARTIAL_KEYS.test(x)) }]));
  return { outcome: Object.values(results).every((x) => x.ok) ? "pass" : "fail",
    evidence: { ...results, scope: "chain-revision freshness on the live custodian; NOT sealed-state anti-replay" } };
}
