import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { savePadState } from "./pad-state.mjs";

const LIMIT = 2 ** 24;
const SHIP_NAME = /^([0-9a-f]{32})-(0|[1-9][0-9]*)-([1-9][0-9]*)\.pads$/;
export function shipmentRange(seed, name) {
  const m = SHIP_NAME.exec(String(name || ""));
  if (!m || m[1] !== seed) return null;
  const index0 = Number(m[2]), count = Number(m[3]);
  return Number.isSafeInteger(index0) && Number.isSafeInteger(count) && index0 < LIMIT && count <= LIMIT - index0 ? { index0, count } : null;
}
function identity(st) {
  return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].map(String).join(":");
}
function syncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Ciphertexts are immutable by shipment name. Metadata is bound to the inode
// and computed bytes; a retry cannot replace pads already acknowledged by a VM.
export function createShipmentStore({ dir }) {
  const root = path.join(dir, "pads-shipments");
  function locate(seed, name) {
    const range = shipmentRange(seed, name);
    if (!range) return null;
    const final = path.join(root, seed, name);
    return { ...range, seed, name, final, meta: final + ".sha256.json" };
  }
  function metadata(p, st) {
    try {
      const m = JSON.parse(fs.readFileSync(p.meta, "utf8"));
      return m.identity === identity(st) && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : null;
    } catch { return null; }
  }
  const store = {
    root, nameHint: "<seed_id>-<index0>-<count>.pads, canonical indices within the pad counter domain",
    plan(seed, name) {
      const p = locate(seed, name);
      if (!p) return null;
      fs.mkdirSync(path.dirname(p.final), { recursive: true, mode: 0o700 });
      return { ...p, tmp: path.join(path.dirname(p.final), "." + name + "." + randomUUID() + ".part") };
    },
    file(seed, name) {
      const p = locate(seed, name);
      if (!p) return null;
      try { return fs.lstatSync(p.final).isFile() ? p.final : null; } catch { return null; }
    },
    list(seed) {
      if (!/^[0-9a-f]{32}$/.test(String(seed || ""))) return [];
      let names;
      try { names = fs.readdirSync(path.join(root, seed)); } catch { return []; }
      return names.flatMap(name => {
        const p = locate(seed, name);
        if (!p) return [];
        try {
          const st = fs.lstatSync(p.final, { bigint: true });
          return st.isFile() ? [{ name, index0: p.index0, count: p.count, bytes: Number(st.size), sha256: metadata(p, st) }] : [];
        } catch { return []; }
      }).sort((a,b) => a.index0-b.index0);
    },
    async digest(seed, name) {
      const p = locate(seed, name);
      if (!p) return null;
      let handle;
      try { handle = await fs.promises.open(p.final, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
      catch (e) { if (e.code === "ENOENT" || e.code === "ELOOP") return null; throw e; }
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) return null;
        const known = metadata(p, before);
        if (known) return known;
        // Upgrade old stores lazily, streaming rather than blocking the relay
        // or allocating a shipment-sized buffer.
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat({ bigint: true });
        if (identity(before) !== identity(after)) throw new Error("shipment changed during hashing");
        const sha256 = hash.digest("hex");
        savePadState(p.meta, { identity: identity(after), sha256 });
        return sha256;
      } finally { await handle.close(); }
    },
    async commit(p, sha256, bytes) {
      const fd = fs.openSync(p.tmp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (fs.fstatSync(fd).size !== bytes) throw new Error("shipment upload length changed");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      try { fs.linkSync(p.tmp, p.final); }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (await store.digest(p.seed, p.name) !== sha256) {
          const conflict = new Error("shipment name already holds different bytes"); conflict.status = 409; throw conflict;
        }
        return;
      }
      // Persist ancestors on first publication, then record the computed hash.
      fs.unlinkSync(p.tmp);
      syncDir(path.dirname(p.final)); syncDir(root); syncDir(path.dirname(root));
      const st = fs.statSync(p.final, { bigint: true });
      savePadState(p.meta, { identity: identity(st), sha256 });
    },
    remove(seed, name) {
      const p = locate(seed, name);
      if (!p) return false;
      try { fs.unlinkSync(p.final); } catch (e) { if (e.code === "ENOENT") return false; throw e; }
      try { fs.unlinkSync(p.meta); } catch (e) { if (e.code !== "ENOENT") throw e; }
      syncDir(path.dirname(p.final)); return true;
    },
  };
  return store;
}
