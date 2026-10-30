// update.js -- staging a verified code update (client/DESIGN.md "Updates", "State"; LAB). Two steps, in this order:
// 1. PUBLISH, immutably: the verified bytes go beside the client under a CONTENT-ADDRESSED name,
//    pvm-client-<version>-<sha256>.mjs -- a uniquely named temp file (read-only, fsynced) is link()ed to that name, which
//    never replaces an existing file, then the directory is fsynced. Different bytes always get a different name, so no
//    attempt, refused or not, can write over a file a committed state refers to. If the name exists already, it must hold
//    exactly these bytes (an earlier attempt, or a concurrent stager of the same artifact); anything else there is
//    refused and left untouched.
// 2. COMMIT, monotonically: through the durable store, re-verified against the NEWEST state (keys may have rotated
//    meanwhile), recording { version, sha256, size, file, sourceCommit } only if the version is newer than anything
//    staged, active or running. The same artifact again is idempotent (nothing recorded, success); the same version with other bytes is
//    refused. Release-key rotation lands in the same commit as the staging, so a concurrent policy commit can never lose
//    it (or be lost by it).
// Before step 1 the same decision is taken against the newest state as it is now -- an optimization only: a stale or
// refused update publishes nothing, and the same artifact again re-publishes a staged file that has gone missing. The
// guard is step 2, taken again inside the store's compare-and-swap. So only a stager that loses a race after publishing
// (or crashes, or cannot commit) leaves a file behind: immutable, content-addressed, and named by no committed state
// (which names its file and hash; `pvm-client staged` checks them). Published files are never deleted or replaced here:
// the install directory may be shared by several state directories, and without a lock no deletion can be proven safe
// against a concurrent stager of the same bytes -- a file one state can never name may be another's staged artifact.
//   stageUpdate(store, env, bytes, { dir, currentVersion, hold }) -> { ok, version, file, gen, already? } | { ok: false, reason }
// `hold` is for tests only (an in-process barrier between reading the state and committing); the CLI never passes it.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { verifyUpdate, semverCmp, CLIENT_VERSION } from "./trust.js";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Publish bytes under their content-addressed name without ever replacing a file: { ok, file, created } | { ok: false, reason }. */
export function publishArtifact(dir, name, bytes, sha) {
  const file = path.join(dir, name), tmp = path.join(dir, `.${name}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp, "wx", 0o444);
    try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} return { ok: false, reason: `could not write the verified artifact (${e.code || e.message}): nothing staged` }; }
  let created = true;
  try { fs.linkSync(tmp, file); }
  catch (e) {
    created = false;
    if (e.code !== "EEXIST") { fs.rmSync(tmp, { force: true }); return { ok: false, reason: `could not publish the verified artifact (${e.code || e.message}): nothing staged` }; }
  }
  fs.rmSync(tmp, { force: true });
  if (!created) {   // the name says which bytes it holds: anything else there was not published by this client
    let have = null; try { have = sha256(fs.readFileSync(file)); } catch {}
    if (have !== sha) return { ok: false, reason: `${name} already exists with bytes other than its name says: refusing; it is left untouched and nothing is staged` };
  }
  try { const dfd = fs.openSync(dir, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } }
  catch (e) { return { ok: false, reason: `could not make the verified artifact durable (${e.code || e.message}): nothing staged` }; }
  return { ok: true, file, created };
}

// The monotonic rule, decided on one state: { stage } | { same } | { refuse }. The floor is max(staged, active) -- and the
// running client's own version, which verifyUpdate holds -- except that the staged artifact itself, exactly, is the same
// (idempotent: it re-publishes a missing file, which is how a missing active file is repaired).
function decide(state, m, name) {
  const v = m.version, s = state.staged, a = state.active || null;
  if (s && s.version === v && s.sha256 === m.artifactSha256 && s.file === name && s.sourceCommit === m.sourceCommit) return { same: true };
  if (s && semverCmp(s.version, v) > 0) return { refuse: `update ${s.version} is already staged: ${v} cannot replace it` };
  if (s && semverCmp(s.version, v) === 0) return { refuse: `update ${s.version} is already staged: ${v} cannot replace it (a second signed artifact under the same version: refused, the staged one stands)` };
  if (a && semverCmp(a.version, v) >= 0) return { refuse: `update ${a.version} is active: ${v} cannot replace it` };
  return { stage: true };
}

export async function stageUpdate(store, env, bytes, { dir, currentVersion = CLIENT_VERSION, hold = null } = {}) {
  const cur = store.latest();
  if (!cur) return { ok: false, reason: "no client installed" };
  const first = await verifyUpdate(env, bytes, { state: cur.state, currentVersion, artifact: "pvm-client.mjs" });
  if (!first.ok) return { ok: false, reason: first.reasons[0] };
  const m = first.manifest, name = `pvm-client-${m.version}-${m.artifactSha256}.mjs`;
  const pre = decide(cur.state, m, name);
  if (pre.refuse) return { ok: false, reason: pre.refuse };
  const pub = publishArtifact(dir, name, bytes, m.artifactSha256);   // for `same`: re-publishes the staged file if it went missing
  if (!pub.ok) return { ok: false, reason: pub.reason };
  let r;
  try {
    r = await store.update(async (state) => {
      if (hold) await hold(state);
      const u = await verifyUpdate(env, bytes, { state, currentVersion, artifact: "pvm-client.mjs" });
      if (!u.ok) return { refuse: u.reasons[0] };
      const d = decide(state, u.manifest, name);
      if (d.refuse) return { refuse: d.refuse };
      if (d.same) return { same: true };
      return { state: { ...u.state, staged: { version: u.manifest.version, sha256: u.manifest.artifactSha256, size: u.manifest.size, file: name, sourceCommit: u.manifest.sourceCommit } } };
    });
  } catch (e) { return { ok: false, reason: `could not record the staged update durably (${e.message}): nothing staged` }; }
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, version: r.state.staged.version, file: path.join(dir, r.state.staged.file), gen: r.gen, ...(r.same ? { already: true } : {}) };
}
