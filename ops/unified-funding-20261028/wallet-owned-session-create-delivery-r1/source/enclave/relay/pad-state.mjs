import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The platform ledger has one authoritative writer. Never acknowledge a
// reservation until both the new contents and their directory entry persist.
// The optional IO adapter allows failure injection without a real ledger.
export function savePadState(file, state, io = fs) {
  const dir = path.resolve(path.dirname(file));
  const firstCreated = io.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(tmp, "wx", 0o600);
    io.writeFileSync(fd, JSON.stringify(state, null, 1));
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(tmp, file);
    // If mkdir created ancestors, persist every new entry too. Existing
    // directories need only the final rename's directory synced.
    const last = firstCreated ? path.dirname(path.resolve(firstCreated)) : dir;
    for (let current = dir; ; current = path.dirname(current)) {
      const dfd = io.openSync(current, io.constants.O_RDONLY | io.constants.O_DIRECTORY);
      try { io.fsyncSync(dfd); } finally { io.closeSync(dfd); }
      if (current === last) break;
    }
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

export function loadPadState(file, io = fs) {
  let text;
  try { text = io.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  // A corrupt existing ledger is an error, never permission to regenerate
  // keys or reset counters. Include no state/key contents in error messages.
  let state;
  try { state = JSON.parse(text); }
  catch { throw new Error("pad ledger is not valid JSON; refusing to reset state"); }
  if (!state || Array.isArray(state) || typeof state !== "object" ||
      typeof state.master !== "string" || state.master.length !== 64 || /[^0-9a-f]/.test(state.master) ||
      typeof state.ledgerKey !== "string" || !state.ledgerKey ||
      !state.seeds || Array.isArray(state.seeds) || typeof state.seeds !== "object")
    throw new Error("pad ledger has invalid identity or seed state; refusing to reset state");
  return state;
}
