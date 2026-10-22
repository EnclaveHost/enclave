// ROOT-ONLY admin pin of the EXACT reviewed EnclaveDNS 0.1.5 artifact through the s3-ipfs-adapter's supported
// api-key route (POST /api/upload?path=pins/<cid>, enclave-apps d4a755b main.rs api_upload / authorized()).
// It does NOT mint or use a wallet upload token, does not sign, and does not touch the handoff's plan or journals.
//
//   node admin-upload.mjs                                   dry run (default): artifact, CID and journal checks; the
//                                                           credential file is only stat()ed, never opened; plan sha256
//   node admin-upload.mjs --execute --approve <plan sha256> ONE upload attempt, then a bounded full-DAG readback
//
// Rules: the artifact must be the pinned bytes (size, sha256, kubo-identical UnixFS CID: the handoff's own frozenWasm).
// The api key is read only at --execute, held in memory, sent only as the X-Api-Key header (never in a URL), and never
// printed, journaled or put in an error. Redirects are refused. Every request is time-bounded. The attempt is journaled
// BEFORE the request; an attempt with no recorded outcome (or any earlier attempt) blocks another one: no retries.
// The run refuses while the user's wallet handoff is mid-upload, awaiting a signature, or has started publish/upgrade.
// Remote error text is never relayed: outcomes are classified (HTTP status, adapter-error shape, the S3 status number).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(here, "../../..");                       // work/
const HANDOFF = path.join(WORK, "enclavedns-stale-20261021/wallet-handoff");
export const DEFAULTS = Object.freeze({
  adapterUpload: "https://7ae476a3.app.enclave.host/api/upload",  // the adapter's own label: ipfs.enclave.host does not route /api
  gateway: "https://ipfs.enclave.host/ipfs/",
  credentialFile: path.join(process.env.HOME || "/home/steven", "enclave-prod/sia-s3-cutover/adapter-r2-rollback.env"),
  credentialName: "API_KEY",
  journalDir: path.join(HANDOFF, "journals"),
  attempts: path.join(here, "attempts.jsonl"),
  uploadTimeoutMs: 300_000,          // the adapter's own S3 PUT deadline is 240 s (s3.rs PUT_DEADLINE)
  readbackEveryMs: 15_000, readbackForMs: 600_000, probeTimeoutMs: 20_000,
});
const sha = (b) => createHash("sha256").update(b).digest("hex");
export class CanaryRefusal extends Error { constructor(m) { super(m); this.name = "CanaryRefusal"; } }
const refuse = (m) => { throw new CanaryRefusal(m); };

/** The pinned release (the handoff's DNS trust object) and the frozen artifact checked by the handoff's own frozenWasm. */
export async function loadArtifact() {
  const { DNS } = await import(path.join(HANDOFF, "trust.mjs"));
  const { frozenWasm } = await import(path.join(WORK, "site-host-live-publish/handoff/site-upload.mjs"));
  const { bytes, dag } = frozenWasm(DNS);   // size + sha256 + UnixFS import == expectedCid, or it throws
  return { t: DNS, bytes, dag };
}

/** The wallet handoff must be idle: no signature pending, no upload in flight, no publish/upgrade begun. */
export function handoffState(dir) {
  const read = (k) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `${k}.json`), "utf8")); } catch (e) { return e.code === "ENOENT" ? null : { unreadable: true }; } };
  const s = { upload: read("upload"), publish: read("publish"), upgrade: read("upgrade") };
  const busy = [];
  if (s.upload?.unreadable) busy.push("upload journal unreadable");
  if (["awaiting-signature", "uploading"].includes(s.upload?.status)) busy.push(`wallet upload is ${s.upload.status}`);
  if (s.upload?.status === "verified" || s.upload?.cid) busy.push("the wallet upload is already verified: nothing to do");
  for (const k of ["publish", "upgrade"]) if (s[k] && (s[k].unreadable || (s[k].status && s[k].status !== "not started"))) busy.push(`${k} journal status ${s[k].unreadable ? "unreadable" : s[k].status}`);
  return { upload: s.upload?.status ?? null, publish: s.publish?.status ?? null, upgrade: s.upgrade?.status ?? null, busy };
}

/** Prior attempts: any earlier attempt (finished or not) blocks a new one. */
export function priorAttempts(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function journal(file, rec) {
  const fd = fs.openSync(file, "a", 0o600);
  try { fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** The plan root approves: exactly what would be sent where, without any secret. */
export function planOf(t, opts) {
  return { schema: "enclavedns-admin-pin/1", artifact: { path: t.wasm.path, bytes: t.wasm.bytes, sha256: t.wasm.sha256 }, cid: t.expectedCid,
    request: { method: "POST", url: `${opts.adapterUpload}?path=pins/${t.expectedCid}`, auth: `header X-Api-Key from ${opts.credentialFile} (${opts.credentialName})`, redirects: "refused", timeoutMs: opts.uploadTimeoutMs },
    readback: { indexProbe: `${opts.gateway}${t.expectedCid}?format=raw`, car: t.upload.carUrl(t.expectedCid), file: `${opts.gateway}${t.expectedCid}`, everyMs: opts.readbackEveryMs, forMs: opts.readbackForMs },
    attemptJournal: opts.attempts, attemptsAllowed: 1 };
}
export const planSha = (plan) => sha(JSON.stringify(plan));

/** Read ONE named value from the documented .env; returns it, never logs it. */
export function readCredential(file, name) {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) refuse("the credential file is readable by others; refusing to use it");
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && m[1] === name) { const v = m[2].replace(/^"(.*)"$/, "$1"); if (!/^[\x21-\x7e]{16,512}$/.test(v)) refuse(`${name} has an unexpected shape`); return v; }
  }
  refuse(`${name} is not in the credential file`);
}

/** Classify a non-2xx answer without relaying it: the adapter's {"error":...} shape, and the S3 status number only. */
async function classify(res) {
  let text = "";
  try { const b = Buffer.from(await res.arrayBuffer()); text = b.length <= 65536 ? b.toString("utf8") : ""; } catch {}
  let j = null; try { j = JSON.parse(text); } catch {}
  const err = typeof j?.error === "string" ? j.error : null;
  const s3 = err && /\bS3 (?:HEAD )?answered (\d{3})\b/.exec(err);
  return { status: res.status, adapterError: !!err, badKey: err === "bad key", s3Status: s3 ? Number(s3[1]) : null,
    timeout: !!err && /timed? ?out|deadline/i.test(err), errorSha256: err ? sha(err) : null };
}

async function bounded(fetchFn, url, init, ms) {
  return fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(ms) });
}

/** Wait (bounded) until the adapter indexes the CID, then verify the CAR's exact block set and the file bytes. */
export async function readback({ t, dag, fetchFn, opts, sleep }) {
  const { verifyCar, readBounded } = await import(path.join(WORK, "site-host-live-publish/handoff/site-upload.mjs"));
  const deadline = Date.now() + opts.readbackForMs; let probes = 0, last = null;
  while (true) {
    probes++;
    try { const r = await bounded(fetchFn, `${opts.gateway}${t.expectedCid}?format=raw`, { method: "GET" }, opts.probeTimeoutMs); last = r.status; await r.arrayBuffer().catch(() => {}); if (r.status === 200) break; }
    catch { last = "error"; }
    if (Date.now() + opts.readbackEveryMs > deadline) return { verified: false, reason: `not indexed after ${probes} probes (last ${last})` };
    await sleep(opts.readbackEveryMs);
  }
  const carRes = await bounded(fetchFn, t.upload.carUrl(t.expectedCid), { method: "GET" }, opts.probeTimeoutMs * 3);
  if (carRes.status !== 200) return { verified: false, reason: `CAR HTTP ${carRes.status}` };
  const car = await readBounded(carRes, t.upload.maxCarBytes, "CAR fetch");
  const v = verifyCar(t, car, dag);   // throws on any mismatch: header, block hash, missing or extra block
  const fileRes = await bounded(fetchFn, `${opts.gateway}${t.expectedCid}`, { method: "GET" }, opts.probeTimeoutMs * 3);
  if (fileRes.status !== 200) return { verified: false, reason: `file HTTP ${fileRes.status}`, ...v };
  const file = await readBounded(fileRes, t.wasm.bytes + 1, "file fetch");
  if (file.length !== t.wasm.bytes || sha(file) !== t.wasm.sha256) return { verified: false, reason: "file bytes differ", ...v };
  return { verified: true, probes, ...v, fileSha256: t.wasm.sha256 };
}

export async function main(argv, { fetchFn = fetch, opts: o = {}, out = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const opts = { ...DEFAULTS, ...o };
  const execute = argv.includes("--execute"), approve = argv[argv.indexOf("--approve") + 1];
  const { t, bytes, dag } = await loadArtifact();
  const plan = planOf(t, opts), digest = planSha(plan);
  const hand = handoffState(opts.journalDir), prior = priorAttempts(opts.attempts);
  let cred = { path: opts.credentialFile, present: false, mode: null };
  try { const st = fs.statSync(opts.credentialFile); cred = { path: opts.credentialFile, present: st.isFile(), mode: (st.mode & 0o777).toString(8) }; } catch {}
  const report = { plan, planSha256: digest, artifactVerified: true, handoff: hand, priorAttempts: prior.length, credential: cred };
  if (!execute) { out(JSON.stringify({ dryRun: true, ...report }, null, 2)); return { dryRun: true, planSha256: digest }; }
  if (approve !== digest) refuse(`--approve must equal the plan sha256 ${digest}`);
  if (hand.busy.length) refuse(`wallet handoff not idle: ${hand.busy.join("; ")}`);
  if (prior.length) refuse(`an earlier attempt is journaled (${opts.attempts}); no retries: archive it deliberately after review`);
  if (!cred.present || cred.mode !== "600") refuse("the documented credential file is missing or not mode 600");
  // already pinned (e.g. a late success of an earlier upload)? then only verify
  let present = null;
  try { const r = await bounded(fetchFn, `${opts.gateway}${t.expectedCid}?format=raw`, { method: "GET" }, opts.probeTimeoutMs); await r.arrayBuffer().catch(() => {}); present = r.status; }
  catch { refuse("the pre-upload presence probe failed; not uploading blind"); }
  if (present === 200) {   // only verify; a readback failure here is reported, never followed by an upload
    const rb = await readback({ t, dag, fetchFn, opts, sleep }).catch((e) => ({ verified: false, reason: e?.name === "UploadRefusal" ? e.message : "readback failed" }));
    journal(opts.attempts, { event: "already-present", planSha256: digest, readback: rb }); out(JSON.stringify({ alreadyPresent: true, readback: rb }));
    return { alreadyPresent: true, readback: rb };
  }
  const key = readCredential(opts.credentialFile, opts.credentialName);
  const hand2 = handoffState(opts.journalDir);   // re-check immediately before sending
  if (hand2.busy.length) refuse(`wallet handoff became busy: ${hand2.busy.join("; ")}`);
  journal(opts.attempts, { event: "attempt", planSha256: digest, cid: t.expectedCid, bytes: bytes.length, sha256: sha(bytes) });
  let res;
  try { res = await bounded(fetchFn, plan.request.url, { method: "POST", headers: { "content-type": "application/octet-stream", "x-api-key": key }, body: bytes }, opts.uploadTimeoutMs); }
  catch (e) { const kind = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out (outcome UNKNOWN: the object may still land)" : /redirect/i.test(String(e?.cause?.message ?? e?.message)) ? "redirect refused" : "request failed (outcome UNKNOWN)";
    journal(opts.attempts, { event: "outcome", result: "unknown", kind }); out(JSON.stringify({ result: "unknown", kind })); return { result: "unknown", kind }; }
  if (res.status !== 200) { const c = await classify(res); journal(opts.attempts, { event: "outcome", result: "failed", ...c }); out(JSON.stringify({ result: "failed", ...c })); return { result: "failed", ...c }; }
  await res.arrayBuffer().catch(() => {});
  journal(opts.attempts, { event: "outcome", result: "accepted", status: 200 });
  const rb = await readback({ t, dag, fetchFn, opts, sleep }).catch((e) => ({ verified: false, reason: e?.name === "UploadRefusal" ? e.message : "readback failed" }));
  journal(opts.attempts, { event: "readback", ...rb });
  out(JSON.stringify({ result: "accepted", readback: rb }));
  return { result: "accepted", readback: rb };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e instanceof CanaryRefusal || e?.name === "UploadRefusal" ? `REFUSED: ${e.message}` : "FAILED (details withheld)"); process.exit(2); });
}
