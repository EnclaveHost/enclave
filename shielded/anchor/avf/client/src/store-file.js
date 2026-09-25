// store-file.js -- the CLI's durable, monotonic memory (client/DESIGN.md "State"; LAB). One directory holds a generation
// log: <gen>.json = { gen, state }. The newest generation IS the state.
//   commit: write a uniquely named temp file, fsync it, then link() it to <gen+1>.json -- link fails with EEXIST when
//     another process committed that generation first, which makes the commit a compare-and-swap across processes with no
//     lock to go stale -- then fsync the directory. A crash leaves either the old newest generation or the new one, never
//     a partial file under a generation name.
//   update(fn): read the newest generation, run fn(state) (verification against THAT state), commit gen+1; on EEXIST,
//     re-read and re-run fn, so a stale decision is re-made on the newest state (a policy older than one committed
//     meanwhile becomes a rollback refusal). A refusal is final only when it was made on the newest generation.
// Failures are explicit: an unreadable or inconsistent newest generation is fatal (falling back to an older one would
// itself be a rollback), and a commit that cannot be made durable throws -- the caller sends nothing.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const GEN = /^([1-9]\d{0,14})\.json$/;
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));
const KEEP = 16;
export class StoreError extends Error {}

export class FileStore {
  constructor(dir) { this.dir = dir; }
  gens() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch (e) { if (e.code === "ENOENT") return []; throw new StoreError(`the state directory is unreadable (${e.code})`); }
    return names.map((n) => GEN.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  }
  /** The newest committed generation { gen, state }, or null before install. */
  latest() {
    const g = this.gens();
    if (!g.length) return null;
    const gen = g[g.length - 1];
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(this.dir, `${gen}.json`), "utf8")); }
    catch (e) { throw new StoreError(`the newest state generation ${gen} is unreadable (${e.code || e.message}): refusing -- an older generation would itself be a rollback`); }
    if (!doc || typeof doc !== "object" || doc.gen !== gen || !doc.state || typeof doc.state !== "object")
      throw new StoreError(`state generation ${gen} is inconsistent: refusing`);
    return doc;
  }
  /** Commit { gen, state } iff <gen>.json does not exist yet: true, false (lost the race), or StoreError (not durable). */
  commit(gen, state) {
    const tmp = path.join(this.dir, `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeSync(fd, JSON.stringify({ gen, state }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw new StoreError(`could not write state generation ${gen} (${e.code || e.message})`); }
    try { fs.linkSync(tmp, path.join(this.dir, `${gen}.json`)); }
    catch (e) {
      fs.rmSync(tmp, { force: true });
      if (e.code === "EEXIST") return false;
      throw new StoreError(`could not commit state generation ${gen} (${e.code || e.message})`);
    }
    fs.rmSync(tmp, { force: true });
    try { const dfd = fs.openSync(this.dir, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } }
    catch (e) { throw new StoreError(`could not make generation ${gen} durable (${e.code || e.message})`); }
    for (const g of this.gens()) if (g <= gen - KEEP) fs.rmSync(path.join(this.dir, `${g}.json`), { force: true });   // readers only ever use the newest
    return true;
  }
  /** The first generation (install): refused if any generation exists, including one a concurrent install committed. */
  init(state) {
    if (this.latest()) return { ok: false, reason: "a client is already installed in this state directory: anchors are not replaced in place" };
    if (!this.commit(1, state)) return { ok: false, reason: "a concurrent install committed first: anchors are not replaced in place" };
    return { ok: true, gen: 1, state };
  }
  /**
   * Read-verify-commit, retried on a lost race. fn(state, gen) returns { state } (commit it), { same: true } (nothing to
   * record: already the committed state) or { refuse: reason }. Returns { ok, gen, state } or { ok: false, reason }.
   */
  async update(fn, { tries = 64 } = {}) {
    for (let i = 0; i < tries; i++) {
      const cur = this.latest();
      if (!cur) throw new StoreError("no client installed");
      const r = await fn(cur.state, cur.gen);
      if (r.refuse !== undefined) {
        const now = this.latest();
        if (now && now.gen === cur.gen) return { ok: false, reason: r.refuse, gen: cur.gen };
        continue;   // decided on a stale generation: decide again on the newest
      }
      if (r.same || canon(r.state) === canon(cur.state)) {
        const now = this.latest();
        if (now && now.gen === cur.gen) return { ok: true, gen: cur.gen, state: cur.state, same: true };
        continue;
      }
      if (this.commit(cur.gen + 1, r.state)) return { ok: true, gen: cur.gen + 1, state: r.state };
    }
    throw new StoreError("the state kept changing under this commit: refusing");
  }
}
