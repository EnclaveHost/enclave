// relay/state-replica.mjs - the platform API's durable state on Enclave hosts (docs/network/hosted-platform-api.md).
//
// The relay keeps ALL of its durable state as files in one data directory: store.js JsonStore / atomicWriteJson
// (accounts, orders, Stripe events, secrets, domains, certs, sessions journal, referrals, placement, network), the
// account-session signing key, route grace, featured views, pads. This module replicates exactly that directory between
// the members of a platform-API group (measured control guests, metal/guest/platform-api-role.mjs). It does not know or
// parse what the files mean.
//
// Model: one PRIMARY per epoch, elected by a majority of the static member list; quorum primary/backup.
//   - vote: a member grants epoch E at most once, only if E is above everything it promised, and only once the previous
//     primary's lease can no longer be valid (no contact for leaseMs), and not during its first leaseMs after joining (a
//     member that rebooted forgot its votes).
//   - commit: the primary scans the directory, sends the change (or a full snapshot to a member that lags) to every member,
//     and calls it committed once a MAJORITY (itself included) applied it. The relay's HTTP response is released only after
//     that (platform-api-role.mjs response barrier). An acknowledged write is therefore on a majority, and any majority
//     that elects a successor contains it: the winner adopts the most advanced state among its voters.
//   - lease: every majority-acknowledged commit or heartbeat renews the primary's lease to (send time + leaseMs - margin).
//     The primary stops the relay as soon as it cannot renew. A member grants a new epoch only after leaseMs without
//     contact, which is after that lease ends (bounded clock drift; margin = leaseMs / 5).
//   - every message is AEAD under the group's state key K (AES-256-GCM, the message kind in the AAD). Only members that
//     received K (sealed to their attested key) can read, forge or replay into a current epoch. Archives are the same
//     ciphertext.
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const REPLICA_FORMAT = "enclave-platform-api-replica/v1";
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
export class ReplicaError extends Error { constructor(message, code) { super(message); this.name = "ReplicaError"; this.code = code; } }

// ---- AEAD(K) ---------------------------------------------------------------------------------------------------------
const aad = (kind) => Buffer.from(REPLICA_FORMAT + "\n" + kind);
/** seal a JSON-able object under K: iv(12) || ciphertext || tag(16) */
export function sealMessage(key, kind, obj) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new ReplicaError("the state key is 32 bytes", "key");
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(kind));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}
/** open what sealMessage made for this kind; throws ReplicaError("…", "auth") on any tampering, another key or kind */
export function openMessage(key, kind, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28 || buf.length > MAX_MESSAGE_BYTES) throw new ReplicaError("malformed sealed message", "auth");
  try {
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    d.setAAD(aad(kind)); d.setAuthTag(buf.subarray(buf.length - 16));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString("utf8"));
  } catch { throw new ReplicaError("the message does not open under this group's key", "auth"); }
}

// ---- the state directory -----------------------------------------------------------------------------------------------
/** heads are ordered by (epoch, seq) */
export const cmpHead = (a, b) => (a.epoch - b.epoch) || (a.seq - b.seq);
const SAFE_REL = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._@+=-][A-Za-z0-9._@+=\/-]{0,511}$/;
const skip = (name) => name.endsWith(".tmp") || name.startsWith(".replica");
/** -> Map(rel -> { ino, size, mtime, sha }). A file whose (inode, size, mtime) is unchanged keeps its recorded sha. */
export function scanDir(dir, prev = new Map()) {
  const out = new Map();
  const walk = (rel) => {
    let entries; try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { walk(r); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(path.join(dir, r), { bigint: true }); } catch { continue; }
      const was = prev.get(r);
      if (was && was.ino === st.ino && was.size === st.size && was.mtime === st.mtimeNs) { out.set(r, was); continue; }
      let data; try { data = fs.readFileSync(path.join(dir, r)); } catch { continue; }
      out.set(r, { ino: st.ino, size: st.size, mtime: st.mtimeNs, sha: sha256Hex(data) });
    }
  };
  walk("");
  return out;
}
/** what changed between two scans: { changed: {rel: base64}, removed: [rel] } (file contents read now) */
export function diffDir(dir, before, after) {
  const changed = {}, removed = [];
  for (const [rel, f] of after) if (!before.has(rel) || before.get(rel).sha !== f.sha) changed[rel] = fs.readFileSync(path.join(dir, rel)).toString("base64");
  for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel);
  return { changed, removed };
}
export function readAll(dir, scan = scanDir(dir)) {
  const files = {};
  for (const rel of scan.keys()) files[rel] = fs.readFileSync(path.join(dir, rel)).toString("base64");
  return files;
}
const checkRel = (rel) => { if (!SAFE_REL.test(rel)) throw new ReplicaError(`unsafe state path ${JSON.stringify(String(rel).slice(0, 80))}`, "path"); return rel; };
function writeAtomic(dir, rel, data) {
  const f = path.join(dir, checkRel(rel));
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + ".tmp", data, { mode: 0o600 });
  fs.renameSync(f + ".tmp", f);
}
export function applyDelta(dir, { changed = {}, removed = [] }) {
  for (const [rel, b64] of Object.entries(changed)) writeAtomic(dir, rel, Buffer.from(b64, "base64"));
  for (const rel of removed) { try { fs.unlinkSync(path.join(dir, checkRel(rel))); } catch {} }
}
/** make `dir` hold exactly `files` */
export function replaceAll(dir, files) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const rel of Object.keys(files)) checkRel(rel);
  for (const rel of scanDir(dir).keys()) if (!Object.hasOwn(files, rel)) { try { fs.unlinkSync(path.join(dir, rel)); } catch {} }
  for (const [rel, b64] of Object.entries(files)) writeAtomic(dir, rel, Buffer.from(b64, "base64"));
}

// ---- the member ---------------------------------------------------------------------------------------------------------
/**
 * new ReplicaNode({ self, n, key, dir, metaFile, send, leaseMs, now, log, onLeader, onFollower, info, archive, archiveMs })
 *   self      this member's index in the static member list (0..n-1)
 *   send      async (index, Buffer) -> Buffer: deliver a sealed request to member `index`, return its sealed answer
 *   metaFile  where the vote and head survive a restart of this process in the same boot (RAM fs)
 *   info      this member's public routing facts, carried in its heartbeats (the role: its control URL and TLS pin)
 *   archive   async (Buffer sealed snapshot, head) -> void, called by the primary at most every archiveMs when state moved
 */
export class ReplicaNode {
  constructor({ self, n, key, dir, metaFile, send, leaseMs = 10000, now = Date.now, log = () => {}, onLeader = () => {}, onFollower = () => {},
                info = {}, archive = null, archiveMs = 30000, joinedAt = null, timeoutMs = null, random = Math.random }) {
    if (!Number.isInteger(n) || n < 1 || n > 15) throw new ReplicaError("a group has 1 to 15 members", "config");
    if (!Number.isInteger(self) || self < 0 || self >= n) throw new ReplicaError("self is not a member index", "config");
    Object.assign(this, { self, n, key, dir, metaFile, send, leaseMs, now, log, onLeader, onFollower, info, archive, archiveMs, random });
    this.majority = Math.floor(n / 2) + 1;
    this.margin = Math.floor(leaseMs / 5);
    this.timeoutMs = timeoutMs || Math.max(200, Math.floor(leaseMs / 3));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const meta = this._loadMeta();
    this.promised = meta.promised; this.voted = meta.voted; this.head = meta.head; this.leaderOf = meta.leaderOf;
    this.role = "follower"; this.leader = null; this.leaderInfo = null; this.leaseUntil = 0;
    this.lastContact = now();
    this.quietUntil = (joinedAt ?? now()) + leaseMs;          // a (re)joined member forgot its votes: it waits one lease
    this.index = scanDir(dir);
    this._chain = Promise.resolve();
    this._archived = null; this._archivedAt = 0; this._timer = null; this._busy = false;
  }
  _loadMeta() {
    try { const m = JSON.parse(fs.readFileSync(this.metaFile, "utf8")); if (m.format === REPLICA_FORMAT) return m; } catch {}
    return { format: REPLICA_FORMAT, promised: 0, voted: null, head: { epoch: 0, seq: 0 }, leaderOf: null };
  }
  _saveMeta() {
    const m = { format: REPLICA_FORMAT, promised: this.promised, voted: this.voted, head: this.head, leaderOf: this.leaderOf };
    fs.mkdirSync(path.dirname(this.metaFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.metaFile + ".tmp", JSON.stringify(m), { mode: 0o600 }); fs.renameSync(this.metaFile + ".tmp", this.metaFile);
  }
  status() {
    return { self: this.self, role: this.role, epoch: this.promised, head: this.head, leader: this.role === "leader" ? this.self : this.leader,
             leaseValid: this.leaseValid(), leaderInfo: this.role === "leader" ? this.info : this.leaderInfo };
  }
  leaseValid() { return this.role === "leader" && this.now() < this.leaseUntil; }
  start() {
    if (this._timer) return;
    const tick = () => this._tick().catch((e) => this.log(`tick: ${e.message}`));
    this._timer = setInterval(tick, Math.max(25, Math.floor(this.leaseMs / 6)));
    this._timer.unref?.();
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; if (this.role === "leader") this._stepDown("stopped"); }
  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const t = this.now();
      if (this.role === "leader") {
        if (!this.leaseValid()) return this._stepDown("lease expired");
        if (t - (this._lastBeat || 0) >= Math.floor(this.leaseMs / 3)) { this._lastBeat = t; await this.commit({ heartbeat: true }); }
        if (this.archive && t - this._archivedAt >= this.archiveMs && (!this._archived || cmpHead(this.head, this._archived) !== 0)) await this._archive();
        return;
      }
      // an election only after a lease of silence, staggered so two members rarely collide
      const wait = this.leaseMs + Math.floor(this.random() * this.leaseMs / 2);
      if (t - this.lastContact > wait && t >= this.quietUntil) await this.campaign();
    } finally { this._busy = false; }
  }
  _others() { return [...Array(this.n).keys()].filter((i) => i !== this.self); }
  async _ask(i, msg) {
    let timer;
    try {
      const out = await Promise.race([this.send(i, sealMessage(this.key, "req", msg)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new ReplicaError("timeout", "timeout")), this.timeoutMs); })]);
      return openMessage(this.key, "res", out);
    } catch (e) { return { error: e.code || "unreachable" }; }
    finally { clearTimeout(timer); }
  }
  _stepDown(reason) {
    const was = this.role;
    this.role = "follower"; this.leaseUntil = 0; this.lastContact = this.now();
    if (was !== "follower") { this.log(`step down (${reason})`); this.onFollower(reason); }
  }
  _seeHigher(epoch) {
    if (epoch > this.promised) { this.promised = epoch; this.voted = null; this.leaderOf = null; this._saveMeta(); }
    if (this.role !== "follower") this._stepDown(`epoch ${epoch} is newer`);
  }

  // ---- a member answering ----
  /** the peer endpoint: a sealed request in, a sealed answer out (anything that does not open is refused by the caller) */
  async handle(buf) {
    const msg = openMessage(this.key, "req", buf);
    return sealMessage(this.key, "res", await this._answer(msg));
  }
  async _answer(m) {
    const t = this.now();
    if (!m || typeof m !== "object" || !Number.isInteger(m.epoch) || !Number.isInteger(m.from) || m.from < 0 || m.from >= this.n || m.from === this.self)
      return { ok: false, error: "bad_message" };
    if (m.t === "vote" || m.t === "prevote") {
      if (m.epoch < this.promised || (m.epoch === this.promised && this.voted && this.voted.for !== m.from) || (m.epoch === this.promised && !this.voted))
        return { granted: false, promised: this.promised, head: this.head };
      if (this.role === "leader" && this.leaseValid()) return { granted: false, promised: this.promised, head: this.head, why: "leader" };
      if (t - this.lastContact <= this.leaseMs || t < this.quietUntil) return { granted: false, promised: this.promised, head: this.head, why: "lease" };
      // a pre-vote changes nothing here: a member that cannot win (the primary is alive for the others) disturbs no one
      if (m.t === "prevote") return { granted: true, promised: this.promised, head: this.head };
      this._seeHigher(m.epoch);
      this.voted = { epoch: m.epoch, for: m.from }; this._saveMeta();
      return { granted: true, promised: this.promised, head: this.head };
    }
    if (m.t === "append" || m.t === "snapshot") {
      if (m.epoch < this.promised) return { ok: false, stale: true, promised: this.promised };
      if (m.epoch === this.promised && this.leaderOf !== null && this.leaderOf !== m.from) return { ok: false, stale: true, promised: this.promised };
      if (m.epoch === this.promised && this.voted && this.voted.epoch === m.epoch && this.voted.for !== m.from) return { ok: false, stale: true, promised: this.promised };
      if (m.epoch > this.promised || this.role !== "follower") this._seeHigher(m.epoch);
      this.leaderOf = m.from; this.leader = m.from; this.leaderInfo = m.info || null; this.lastContact = t;
      if (m.t === "snapshot") {
        replaceAll(this.dir, m.files || {});
        this.index = scanDir(this.dir); this.head = m.head; this._saveMeta();
        return { ok: true, head: this.head };
      }
      if (cmpHead(this.head, m.head) === 0) { this._saveMeta(); return { ok: true, head: this.head }; }   // a heartbeat, or a duplicate
      if (cmpHead(this.head, m.base) !== 0) return { ok: false, needSnapshot: true, head: this.head };
      applyDelta(this.dir, m);
      this.index = scanDir(this.dir, this.index); this.head = m.head; this._saveMeta();
      return { ok: true, head: this.head };
    }
    if (m.t === "fetch") {
      if (m.epoch < this.promised) return { ok: false, stale: true, promised: this.promised };
      return { ok: true, head: this.head, files: readAll(this.dir) };
    }
    return { ok: false, error: "unknown" };
  }

  // ---- a member campaigning ----
  async campaign() {
    if (this.role === "leader") return true;
    const epoch = Math.max(this.promised, this.head.epoch) + 1, others = this._others();
    // pre-vote: would a majority grant this epoch now? Nothing is promised by anyone until it would.
    const pre = await Promise.all(others.map((i) => this._ask(i, { t: "prevote", epoch, from: this.self, head: this.head })));
    if (pre.filter((r) => r.granted === true).length + 1 < this.majority) { this.lastContact = this.now(); return false; }
    const before = { promised: this.promised, voted: this.voted, leaderOf: this.leaderOf };
    this.promised = epoch; this.voted = { epoch, for: this.self }; this.leaderOf = this.self; this.role = "candidate"; this._saveMeta();
    const replies = await Promise.all(others.map((i) => this._ask(i, { t: "vote", epoch, from: this.self, head: this.head })));
    const higher = replies.filter((r) => Number.isInteger(r.promised) && r.promised > epoch).map((r) => r.promised);
    if (higher.length) { this._seeHigher(Math.max(...higher)); this.lastContact = this.now(); return false; }
    const grants = replies.map((r, k) => ({ r, i: others[k] })).filter((x) => x.r.granted === true);
    if (grants.length + 1 < this.majority) {
      // an abandoned candidacy: no member that granted it can elect anyone else in this epoch, and this member never
      // leads it, so its own epoch returns to what it was and a live primary is not refused because of it
      if (!grants.length) { Object.assign(this, before); this.voted = before.voted ? { ...before.voted } : null; }
      this.role = "follower"; this.lastContact = this.now(); this._saveMeta(); return false;
    }
    // adopt the most advanced state among the voters: every acknowledged write is on at least one of them
    let best = null;
    for (const g of grants) if (g.r.head && cmpHead(g.r.head, best ? best.r.head : this.head) > 0) best = g;
    if (best) {
      const got = await this._ask(best.i, { t: "fetch", epoch, from: this.self });
      if (!got.ok || !got.files) { this.role = "follower"; this.lastContact = this.now(); return false; }
      replaceAll(this.dir, got.files); this.index = scanDir(this.dir); this.head = got.head;
    }
    // open the epoch: every member gets this exact state, and a majority must hold it before anything is served
    this.role = "leader"; this.leader = this.self;
    const t0 = this.now(), head = { epoch, seq: 1 };
    const files = readAll(this.dir, this.index = scanDir(this.dir, this.index));
    const acks = await Promise.all(others.map((i) => this._ask(i, { t: "snapshot", epoch, from: this.self, head, files, info: this.info })));
    if (acks.some((a) => a.stale)) { this._seeHigher(Math.max(this.promised, ...acks.filter((a) => a.stale).map((a) => a.promised || 0))); return false; }
    if (acks.filter((a) => a.ok).length + 1 < this.majority) { this._stepDown("could not establish the epoch"); return false; }
    this.head = head; this._saveMeta();
    this.leaseUntil = t0 + this.leaseMs - this.margin; this._lastBeat = t0;
    this.log(`primary for epoch ${epoch}`);
    this.onLeader({ epoch });
    return true;
  }

  /**
   * The primary: replicate what changed in the directory since the last commit (or just renew the lease). Serialized.
   * -> true when a majority holds the directory as it is now; false (and this member steps down) when it could not.
   */
  commit({ heartbeat = false } = {}) {
    const run = this._chain.then(() => this._commitOnce(heartbeat));
    this._chain = run.catch(() => {});
    return run;
  }
  async _commitOnce(heartbeat) {
    if (this.role !== "leader") return false;
    const scan = scanDir(this.dir, this.index), delta = diffDir(this.dir, this.index, scan);
    const moved = Object.keys(delta.changed).length > 0 || delta.removed.length > 0;
    if (!moved && !heartbeat) return this.leaseValid();
    const base = this.head, head = moved ? { epoch: base.epoch, seq: base.seq + 1 } : base, t0 = this.now();
    const msg = { t: "append", epoch: this.promised, from: this.self, base, head, ...delta, info: this.info };
    const acks = await Promise.all(this._others().map(async (i) => {
      let r = await this._ask(i, msg);
      if (r.needSnapshot) r = await this._ask(i, { t: "snapshot", epoch: this.promised, from: this.self, head, files: readAll(this.dir, scan), info: this.info });
      return r;
    }));
    const stale = acks.filter((a) => a.stale);
    if (stale.length) {
      this._seeHigher(Math.max(this.promised, ...stale.map((a) => a.promised || 0)));
      if (this.role === "leader") this._stepDown("a member follows a newer epoch");
      return false;
    }
    if (acks.filter((a) => a.ok).length + 1 < this.majority) { this._stepDown(moved ? "a change could not reach a majority" : "the lease could not be renewed"); return false; }
    this.index = scan; this.head = head; this._saveMeta();
    this.leaseUntil = t0 + this.leaseMs - this.margin;
    return true;
  }
  async _archive() {
    const scan = scanDir(this.dir, this.index), head = this.head;
    try {
      await this.archive(sealMessage(this.key, "archive", { format: REPLICA_FORMAT, head, at: this.now(), files: readAll(this.dir, scan) }), head);
      this._archived = head; this._archivedAt = this.now();
    } catch (e) { this.log(`archive failed: ${String(e.message).slice(0, 160)}`); this._archivedAt = this.now(); }
  }
}

/** open an archived snapshot (recovery): -> { head, at, files } */
export function openArchive(key, buf) {
  const o = openMessage(key, "archive", buf);
  if (!o || o.format !== REPLICA_FORMAT || !o.head || typeof o.files !== "object") throw new ReplicaError("not a platform-api archive", "format");
  for (const rel of Object.keys(o.files)) checkRel(rel);
  return o;
}
