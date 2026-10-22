// The durable state of ONE release root (work/site-delivery-hardening-interface.txt §1, plus the reconcile fixes in
// work/claude-site-reconcile-fix-result.md), shared by local-root targets and the ssh agent.
//
//   - Identity: state.rootId is generated once and named by every operation that changes or settles anything, so a
//     journal can never be settled against a different root that happens to carry the same target name.
//   - Fencing: every change carries an opId chosen by the orchestrator and applies only at the generation the
//     orchestrator observed (compare-and-swap). An undo reverts only that activation, only while it is still the latest
//     change (A-B-A safe). An undo is a new generation, never a rewind.
//   - Cancellation: `cancel <opId>` durably records a tombstone for an operation that has not run. A late arrival of that
//     same operation then finds its recorded outcome ("cancelled") and never executes. If the operation won the race,
//     cancel returns its real result instead.
//   - History: ops/<id>.json is published atomically (tmp + fsync + link without overwrite): never a partial final file.
//     state.json (tmp + fsync + rename) is the commit point, and its lastOp re-publishes a lost history entry.
//   - Recovery: a change interrupted by a crash, or a rollback whose reload or probe could not be confirmed, stays in
//     state.pending. It is retried before anything else runs; until it is confirmed, the root reports "pending" and
//     never claims it was restored.
//   - Lock: an OS lock (flock(2) through util-linux `flock`), held by a helper whose stdin is our pipe. The kernel
//     releases it when the holder exits, crashes included. The lock file is never removed, so no takeover race exists.
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { verifyRelease } from "./release.mjs";

const CID = /^b[a-z2-7]{58}$/, OPID = /^[0-9a-f]{32}$/, ROOTID = /^[0-9a-f]{32}$/, UNDOID = /^undo-[0-9a-f]{32}-[1-9]$/;
export const MAX_UNDO_ATTEMPTS = 9;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export class LockedError extends Error {}
/** The operation did not run because the root is not the one it was addressed to. */
export class WrongRootError extends Error {}
/** An earlier change could not be confirmed restored; nothing new runs until it is. */
export class RecoveryError extends Error {}

// ---- the OS lock -----------------------------------------------------------------------------------------------------
/**
 * Hold root/.site-release.lock with flock(2). `wait` seconds (0 = refuse at once if held). -> release()
 * The helper is `flock -x [-n|-w S] FILE cat`: cat starts only once the kernel granted the lock, and it echoes a byte we
 * write, which is the acknowledgement. Closing our end of its stdin (or our death) ends cat, then flock, then the lock.
 */
export function lockRoot(root, { wait = 0 } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, ".site-release.lock");
  return new Promise((resolve, reject) => {
    const helper = spawn(process.env.SITE_RELEASE_FLOCK || "flock", ["-x", ...(wait ? ["-w", String(wait)] : ["-n"]), lock, "cat"],
      { stdio: ["pipe", "pipe", "ignore"] });
    let held = false;
    helper.on("error", (e) => reject(new Error(e.code === "ENOENT" ? "this tool needs util-linux `flock` (Linux) for its root lock; there is no racy fallback" : e.message)));
    helper.stdout.once("data", () => {
      held = true;
      resolve(() => new Promise((done) => { helper.once("close", () => done()); helper.stdin.end(); }));
    });
    helper.on("close", (code) => { if (!held) reject(new LockedError(`${root} is locked by another release run (flock exit ${code})`)); });
    helper.stdin.on("error", () => {});   // a refused flock exits before reading: our acknowledgement byte meets a closed pipe
    helper.stdin.write("L\n");
  });
}
export async function withLock(root, fn, opts) { const release = await lockRoot(root, opts); try { return await fn(); } finally { await release(); } }

// ---- primitives ------------------------------------------------------------------------------------------------------
export const fsyncDir = (d) => { const fd = fs.openSync(d, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
export const currentLink = (root) => { try { const v = fs.readlinkSync(path.join(root, "current")); return CID.test(v) ? v : null; } catch { return null; } };
export function swap(root, cid) {
  const tmp = path.join(root, `.link-${randomBytes(4).toString("hex")}`);
  if (cid) { fs.symlinkSync(cid, tmp); fs.renameSync(tmp, path.join(root, "current")); }
  else fs.rmSync(path.join(root, "current"), { force: true });
  fsyncDir(root);
}
// The served headers live at root/headers.caddy (a regular file the web server imports). Moving FORWARD to a newer
// release, headers go first: its CSP union keeps every hash of the last 48h, so the content still being served stays
// valid. Moving BACK, content goes first, for the same reason.
export function setHeaders(root, cid) {
  if (!cid) return;   // the first release's headers stay when the root goes back to nothing: the server imports the file
  const tmp = path.join(root, `.headers-${randomBytes(4).toString("hex")}`);
  fs.copyFileSync(path.join(root, cid, "headers.caddy"), tmp);
  fs.renameSync(tmp, path.join(root, "headers.caddy"));
  fsyncDir(root);
}
export const record = (root, entry) => {
  fs.appendFileSync(path.join(root, "releases.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
};
const run = (argv, timeoutMs) => new Promise((resolve, reject) => {
  execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 1 << 20 }, (e, out, err) =>
    e ? reject(new Error(`${path.basename(argv[0])} failed: ${String(err || e.message).trim().slice(0, 300)}`)) : resolve(out));
});
function get(url, { servername, ca, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "GET", servername, ca, headers: { "cache-control": "no-cache", "accept-encoding": "identity" }, timeout: timeoutMs }, (res) => {
      const chunks = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > 64 << 20) req.destroy(new Error("probe answer too large")); else chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("probe timed out"))); req.on("error", reject); req.end();
  });
}
/** Every probe path must answer exactly the release's bytes; with headers:true every release header must be served. */
export async function probe(target, manifest) {
  const p = target.activate?.probe;
  if (!p) return { probed: false };
  const ca = p.caFile ? fs.readFileSync(p.caFile) : undefined, files = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  for (const rel of p.paths) {
    const want = files.get(rel);
    if (!want) throw new Error(`probe path ${rel} is not a file of release ${manifest.cid}`);
    const r = await get(new URL(rel, p.url.replace(/\/?$/, "/")).href, { servername: p.servername, ca });
    if (r.status !== 200 || sha256(r.body) !== want) throw new Error(`the server answered ${rel} with ${r.status === 200 ? "other bytes" : "HTTP " + r.status}, not release ${manifest.cid}`);
    if (p.headers) for (const [k, v] of Object.entries(manifest.headers))
      if (r.headers[k.toLowerCase()] !== v) throw new Error(`the server's ${k} header is not the release's (${rel})`);
  }
  return { probed: true, paths: p.paths.length };
}
const reload = (target) => (target.activate?.reload ? run(target.activate.reload, target.activate.reloadTimeoutMs ?? 30000) : Promise.resolve());
/** Serve `cid` (or nothing) and CONFIRM it: reload must succeed and the probe must see it. Throws otherwise. */
async function serveConfirmed(target, cid, order) {
  if (order === "headers-first") { setHeaders(target.root, cid); swap(target.root, cid); }
  else { swap(target.root, cid); setHeaders(target.root, cid); }
  await reload(target);
  if (cid) await probe(target, JSON.parse(fs.readFileSync(path.join(target.root, cid, "release.json"), "utf8")));
}

// ---- durable state and history -----------------------------------------------------------------------------------
const statePath = (root) => path.join(root, "state.json");
function readState(root) {
  let s;
  try { s = JSON.parse(fs.readFileSync(statePath(root), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (s?.v !== 1 || !ROOTID.test(s.rootId || "") || !Number.isSafeInteger(s.generation) || s.generation < 0 || !(s.current === null || CID.test(s.current)))
    throw new Error(`${statePath(root)} is not a release-root state (or predates root identity); refusing to guess`);
  return s;
}
function writeState(root, s) {
  const tmp = path.join(root, `.state-${randomBytes(4).toString("hex")}`);
  const fd = fs.openSync(tmp, "wx", 0o644);
  try { fs.writeSync(fd, JSON.stringify(s, null, 1) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, statePath(root));
  fsyncDir(root);
}
const opsDir = (root) => path.join(root, "ops");
const opPath = (root, id) => path.join(opsDir(root), `${id}.json`);
function readOp(root, id) { try { return JSON.parse(fs.readFileSync(opPath(root, id), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
/** Publish an operation's result once, atomically: tmp + fsync, then link (never overwrites), then fsync the dir. */
function writeOp(root, id, result) {
  fs.mkdirSync(opsDir(root), { recursive: true });
  const tmp = path.join(opsDir(root), `.tmp-${id}-${randomBytes(4).toString("hex")}`);
  const fd = fs.openSync(tmp, "wx", 0o644);
  try { fs.writeSync(fd, JSON.stringify(result) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, opPath(root, id)); } catch (e) { if (e.code !== "EEXIST") throw e; }
  fs.rmSync(tmp, { force: true });
  fsyncDir(opsDir(root));
  return readOp(root, id);
}
const now = () => new Date().toISOString();

/** The root's state, created (with its identity) on first use. Under the lock. */
function ensureState(root) {
  const s = readState(root);
  if (s) return s;
  const fresh = { v: 1, rootId: randomBytes(16).toString("hex"), generation: 0, current: currentLink(root), pending: null, lastOp: null };
  writeState(root, fresh);
  return fresh;
}
/** Finish what an earlier run left, under the lock. Throws RecoveryError while it cannot be confirmed. -> state */
async function recover(target) {
  const root = target.root;
  for (const n of fs.existsSync(opsDir(root)) ? fs.readdirSync(opsDir(root)) : []) if (n.startsWith(".tmp-")) fs.rmSync(path.join(opsDir(root), n), { force: true });
  const s = ensureState(root);
  if (s.pending) {
    const p = s.pending;
    // a rollback that could not be confirmed carries its own target; an interrupted change goes back to what was served
    // (an interrupted activation goes BACK to an older release: content first; an interrupted undo goes forward again to
    // the newer activation it was undoing: headers first. An interrupted undo is "failed": a new attempt may follow.)
    const r = p.restore ?? { to: p.prev, generation: p.prevGeneration, order: p.kind === "undo" ? "headers-first" : "content-first",
      finalOp: { opId: p.opId, kind: p.kind, cid: p.cid, outcome: p.kind === "undo" ? "failed" : "rolled-back", generation: p.prevGeneration, previous: p.prev,
        reason: "interrupted: an earlier run stopped mid-change; the root was restored to what it served before", at: now() } };
    try { await serveConfirmed(target, r.to, r.order); }
    catch (e) {
      writeState(root, { ...s, pending: { ...p, restore: r, lastRestoreError: String(e.message).slice(0, 300), at: now() } });
      throw new RecoveryError(`the root could not confirm restoring ${r.to ?? "nothing"} after ${p.opId} (${String(e.message).slice(0, 200)}); it stays pending`);
    }
    const next = { ...s, generation: r.generation, current: r.to, pending: null, lastOp: r.finalOp };
    writeState(root, next);
    record(root, { cid: r.to, previous: p.cid, rollback: true, why: r.finalOp.reason ?? r.finalOp.outcome, opId: r.finalOp.opId });
    writeOp(root, r.finalOp.opId, r.finalOp);
    return next;
  }
  if (s.lastOp && !readOp(root, s.lastOp.opId)) writeOp(root, s.lastOp.opId, s.lastOp);   // committed, then crashed before the history
  return s;
}
const fence = (s, rootId) => { if (s.rootId !== rootId) throw new WrongRootError(`this root is ${s.rootId}, not ${rootId}: refusing an operation addressed to another root`); };
/** A change that failed, then had to be undone: confirm the undo, or keep it pending. -> the recorded result */
async function settleFailure(target, s, base, finalOp, restoreTo, order) {
  const root = target.root, restore = { to: restoreTo, generation: s.generation, order, finalOp };
  writeState(root, { ...s, pending: { ...readState(root).pending, restore } });
  try { await serveConfirmed(target, restoreTo, order); }
  catch (e) {
    writeState(root, { ...readState(root), pending: { ...readState(root).pending, lastRestoreError: String(e.message).slice(0, 300) } });
    return { ...base, outcome: "pending", reason: `${finalOp.reason}; then restoring ${restoreTo ?? "nothing"} could not be confirmed (${String(e.message).slice(0, 200)})` };
  }
  writeState(root, { ...s, pending: null, lastOp: finalOp });
  record(root, { cid: restoreTo, previous: base.cid, rollback: true, why: String(finalOp.reason).slice(0, 200), opId: finalOp.opId });
  return writeOp(root, finalOp.opId, finalOp);
}

// ---- operations ------------------------------------------------------------------------------------------------------
/** -> {rootId, generation, current, pending} (creates the root's identity on first use) */
export const rootStatus = (target) => withLock(target.root, async () => {
  let s, pending = false;
  try { s = await recover(target); } catch (e) { if (!(e instanceof RecoveryError)) throw e; s = readState(target.root); pending = true; }
  return { rootId: s.rootId, generation: s.generation, current: s.current, pending };
}, { wait: 60 });

/**
 * Activate `cid` as `opId`, only on root `rootId` at `expectGeneration`. -> the recorded result {outcome: "committed" |
 * "refused" | "rolled-back" | "cancelled" (a tombstone was there first) | "pending" (rollback not yet confirmed), ...}.
 */
export function rootActivate(target, { opId, cid, expectGeneration, rootId }) {
  if (!OPID.test(opId) || !CID.test(cid) || !Number.isSafeInteger(expectGeneration) || !ROOTID.test(rootId || "")) throw new Error("activate needs an opId, a CID, the expected generation and the root id");
  const root = target.root;
  return withLock(root, async () => {
    const s = await recover(target);
    fence(s, rootId);
    const prior = readOp(root, opId);
    if (prior) return { ...prior, replay: true };
    const base = { opId, kind: "activate", cid, expectGeneration, generation: s.generation, previous: s.current, rootId };
    if (s.generation !== expectGeneration)
      return writeOp(root, opId, { ...base, outcome: "refused", reason: `the root is at generation ${s.generation}, not ${expectGeneration}: another change happened since this rollout looked`, at: now() });
    let manifest;
    try { manifest = verifyRelease(path.join(root, cid)); if (s.current) verifyRelease(path.join(root, s.current)); }
    catch (e) { return writeOp(root, opId, { ...base, outcome: "refused", reason: `the release is not present and verified here: ${e.message}`, at: now() }); }
    writeState(root, { ...s, pending: { opId, kind: "activate", cid, prev: s.current, prevGeneration: s.generation, at: now() } });
    try {
      setHeaders(root, cid);
      await reload(target);
      swap(root, cid);
      const probed = await probe(target, manifest);
      const lastOp = { ...base, outcome: "committed", generation: s.generation + 1, probed: probed.probed, at: now() };
      writeState(root, { ...s, generation: s.generation + 1, current: cid, pending: null, lastOp });
      record(root, { cid, previous: s.current, opId, generation: s.generation + 1 });
      return writeOp(root, opId, lastOp);
    } catch (e) {
      return settleFailure(target, s, base, { ...base, outcome: "rolled-back", reason: String(e.message).slice(0, 300), at: now() }, s.current, "content-first");
    }
  });
}

/**
 * Undo activation `opId`, attempt `attempt` (1..9), only while that activation is still the root's latest change.
 * -> {outcome: "committed" (undone) | "superseded" | "nothing-to-undo" | "failed" (still serving the activation;
 * a new attempt may follow) | "cancelled" | "pending", ...}
 */
export function rootUndo(target, { opId, attempt = 1, rootId }) {
  if (!OPID.test(opId) || !(Number.isInteger(attempt) && attempt >= 1 && attempt <= MAX_UNDO_ATTEMPTS) || !ROOTID.test(rootId || ""))
    throw new Error("undo needs the activation's opId, an attempt 1..9 and the root id");
  const root = target.root, id = `undo-${opId}-${attempt}`;
  return withLock(root, async () => {
    const s = await recover(target);
    fence(s, rootId);
    const prior = readOp(root, id);
    if (prior) return { ...prior, replay: true };
    for (let a = 1; a < attempt; a++) { const p = readOp(root, `undo-${opId}-${a}`); if (p?.outcome === "committed") return { ...p, replay: true }; }
    const orig = readOp(root, opId) ?? (s.lastOp?.opId === opId ? s.lastOp : null);
    const base = { opId: id, kind: "undo", of: opId, attempt, cid: orig?.previous ?? null, expectGeneration: orig?.generation ?? null, generation: s.generation, previous: s.current, rootId };
    const done = (outcome, reason) => writeOp(root, id, { ...base, outcome, reason, at: now() });
    if (!orig || orig.outcome !== "committed") return done("nothing-to-undo", orig ? `that activation was ${orig.outcome}` : "this root never accepted that activation");
    if (s.generation !== orig.generation || s.current !== orig.cid)
      return done("superseded", `a newer change (generation ${s.generation}) replaced that activation; it is left alone`);
    try { if (orig.previous) verifyRelease(path.join(root, orig.previous)); }
    catch (e) { return done("failed", `the release to go back to is not present and verified: ${e.message}`); }
    writeState(root, { ...s, pending: { opId: id, kind: "undo", cid: orig.previous, prev: s.current, prevGeneration: s.generation, at: now() } });
    try {
      await serveConfirmed(target, orig.previous, "content-first");
      const lastOp = { ...base, outcome: "committed", generation: s.generation + 1, at: now() };
      writeState(root, { ...s, generation: s.generation + 1, current: orig.previous, pending: null, lastOp });
      record(root, { cid: orig.previous, previous: s.current, rollback: true, why: `undo of ${opId}`, opId: id, generation: s.generation + 1 });
      return writeOp(root, id, lastOp);
    } catch (e) {
      // back to the activation it was undoing (forward again: headers first), confirmed, before reporting "failed"
      return settleFailure(target, s, base, { ...base, outcome: "failed", reason: `the undo could not be confirmed (${String(e.message).slice(0, 200)}); still serving ${s.current}`, at: now() },
        s.current, "headers-first");
    }
  });
}

/**
 * Settle an operation the orchestrator lost track of: its recorded result if it ran (or a recovery is still pending for
 * it), otherwise a durable "cancelled" tombstone, so the same operation can never run later. -> the result
 */
export function rootCancel(target, { opId, rootId }) {
  if (!(OPID.test(opId) || UNDOID.test(opId)) || !ROOTID.test(rootId || "")) throw new Error("cancel needs an operation id and the root id");
  const root = target.root;
  return withLock(root, async () => {
    let s;
    try { s = await recover(target); }
    catch (e) {
      if (!(e instanceof RecoveryError)) throw e;
      s = readState(root); fence(s, rootId);
      if (s.pending?.opId === opId) return { opId, outcome: "pending", reason: e.message, generation: s.generation, current: s.current, rootId };
    }
    fence(s, rootId);
    const prior = readOp(root, opId) ?? (s.lastOp?.opId === opId ? writeOp(root, opId, s.lastOp) : null);
    if (prior) return { ...prior, replay: true };
    return writeOp(root, opId, { opId, kind: opId.startsWith("undo-") ? "undo" : "activate", outcome: "cancelled",
      reason: "cancelled before it ran: if it arrives later it will find this record and not run", generation: s.generation, current: s.current, rootId, at: now() });
  }, { wait: 60 });
}

/** The recorded result of an operation (a read, apart from finishing recovery). Reporting only: settle with cancel. */
export function rootResult(target, { opId, rootId }) {
  if (!(OPID.test(opId) || UNDOID.test(opId)) || !ROOTID.test(rootId || "")) throw new Error("result needs an operation id and the root id");
  return withLock(target.root, async () => {
    let s;
    try { s = await recover(target); }
    catch (e) { if (!(e instanceof RecoveryError)) throw e; s = readState(target.root); if (s.pending?.opId === opId) { fence(s, rootId); return { opId, outcome: "pending", reason: e.message }; } }
    fence(s, rootId);
    return readOp(target.root, opId) ?? (s.lastOp?.opId === opId ? s.lastOp : { opId, outcome: "unknown-op", generation: s.generation, current: s.current });
  }, { wait: 60 });
}
