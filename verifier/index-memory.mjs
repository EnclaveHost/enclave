// verifier/index-memory.mjs: what a consumer REMEMBERS about the signed release index, so that authenticity (the
// signature, verifier/release-index.mjs) is joined by freshness. One record: the highest publication verified so far
// (the signing run id and attempt, from the certificate), the digest of the bytes that carried it, its tag, and the
// highest floor (minimumRelease) seen. consider() answers for a newly verified index:
//   first-seen     no record yet: accepted and remembered
//   newest-seen    a later publication (higher run id, or the same run's later attempt): accepted and remembered
//   same           the same publication with the same bytes: accepted (idempotent; a re-fetch)
//   replay         an OLDER publication than the one remembered: REFUSED (a genuine old index re-served)
//   equivocation   the same publication with OTHER bytes: REFUSED and remembered as such (two signed indexes for one run
//                  and attempt cannot both be honest; nothing from either is taken, the first bytes included, until a
//                  LATER publication supersedes it; the record survives a process, so a reload refuses both too)
//   floor-regression  a later publication whose floor is below the remembered floor: REFUSED (the floor only rises)
// floor() is the remembered floor, applied by the consumer to the unsigned fallback too, so a fallback can never
// accept below what a verified index already established. The record is a JSON file written atomically (tmp + rename);
// a missing or unreadable file is "no record" and is said so; `persisted` in every answer says whether the record as it
// stands is on disk (a memory that could not be written is not durable, and never says it is); nothing here is ever a
// reason to accept more.
import fs from "node:fs";
import path from "node:path";

const cmpVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const cmpPub = (a, b) => (a.runId - b.runId) || (a.attempt - b.attempt);
const validPub = (p) => p && Number.isSafeInteger(p.runId) && p.runId > 0 && Number.isSafeInteger(p.attempt) && p.attempt > 0;
const validVersion = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0);

export function createIndexMemory({ file = null, now = () => new Date(), log = () => {} } = {}) {
  let state = null, note = null, durable = false;   // durable: the state as it stands has been written to the file (or there is no file to write)
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && raw.schema === "enclave-index-memory/v1" && validPub(raw.publication) && /^[0-9a-f]{64}$/.test(String(raw.digest || "")) && validVersion(raw.minimumRelease)) { state = raw; durable = true; }
      else { note = `the index memory at ${file} is not a record this version understands; starting without one`; log(note); }
    } catch (e) { if (e.code !== "ENOENT") { note = `the index memory at ${file} is unreadable (${e.message}); starting without one`; log(note); } }
  }
  const persist = () => {
    if (!file) { durable = true; return true; }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + "\n"); fs.renameSync(tmp, file); durable = true; return true;
    } catch (e) { durable = false; log(`the index memory could not be written to ${file}: ${e.message}`); return false; }
  };
  const remember = (rec) => { state = { schema: "enclave-index-memory/v1", ...rec, at: now().toISOString() }; return persist(); };

  // { publication: { runId, attempt }, digest, minimumRelease: [x,y,z], tag } -> { ok, kind, why, persisted, remembered }
  function consider({ publication, digest, minimumRelease, tag = null } = {}) {
    if (!validPub(publication)) return { ok: false, kind: "invalid", why: "no publication (run id and attempt) to order by", remembered: state };
    if (!/^[0-9a-f]{64}$/.test(String(digest || ""))) return { ok: false, kind: "invalid", why: "no digest to remember", remembered: state };
    if (!validVersion(minimumRelease)) return { ok: false, kind: "invalid", why: "no floor to remember", remembered: state };
    const rec = { publication: { runId: publication.runId, attempt: publication.attempt }, digest: String(digest).toLowerCase(), minimumRelease: [...minimumRelease], tag };
    if (!state) { const persisted = remember(rec); return { ok: true, kind: "first-seen", why: `first index remembered: run ${rec.publication.runId} attempt ${rec.publication.attempt}`, persisted, remembered: state }; }
    const c = cmpPub(rec.publication, state.publication);
    const seen = `run ${state.publication.runId} attempt ${state.publication.attempt}${state.tag ? ` (${state.tag})` : ""}`;
    if (c < 0) return { ok: false, kind: "replay", why: `replay: publication run ${rec.publication.runId} attempt ${rec.publication.attempt} is older than the remembered ${seen}`, remembered: state };
    if (c === 0) {
      // an equivocated publication stays refused for EVERY set of bytes, the first ones included: two signed indexes for
      // one run and attempt cannot both be honest, and which one is is not the memory's to guess
      if (state.equivocation) return { ok: false, kind: "equivocation", why: `equivocation: publication ${seen} was verified with digest ${state.digest.slice(0, 16)}... and later seen with ${state.equivocation.digest.slice(0, 16)}...; nothing from it is taken (these bytes: ${rec.digest.slice(0, 16)}...)`, persisted: durable, remembered: state };
      if (rec.digest === state.digest) return { ok: true, kind: "same", why: `the remembered publication ${seen}, same bytes`, persisted: durable, remembered: state };
      const persisted = remember({ ...state, equivocation: { digest: rec.digest, tag, seenAt: now().toISOString() } });
      return { ok: false, kind: "equivocation", why: `equivocation: publication ${seen} was verified with digest ${state.digest.slice(0, 16)}..., these bytes are ${rec.digest.slice(0, 16)}...; nothing from either is taken`, persisted, remembered: state };
    }
    if (state.equivocation) { /* a later publication supersedes an equivocated one; the record of it stays in the log line */ log(`index memory: publication ${seen} had equivocated; superseded by run ${rec.publication.runId} attempt ${rec.publication.attempt}`); }
    if (cmpVersion(rec.minimumRelease, state.minimumRelease) < 0) return { ok: false, kind: "floor-regression", why: `floor regression: the remembered floor v${state.minimumRelease.join(".")} is above this index's v${rec.minimumRelease.join(".")}`, remembered: state };
    const persisted = remember(rec);
    return { ok: true, kind: "newest-seen", why: `newer publication: run ${rec.publication.runId} attempt ${rec.publication.attempt} after ${seen}`, persisted, remembered: state };
  }
  return { consider, floor: () => (state ? [...state.minimumRelease] : null), record: () => (state ? structuredClone(state) : null), note: () => note, durable: () => durable, file };
}
