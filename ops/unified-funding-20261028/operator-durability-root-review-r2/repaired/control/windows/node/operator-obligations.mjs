// operator-obligations.mjs - durable records of operator-key effects whose outcome may be unknown (permit r12, SOURCE ONLY, NOT RUN).
//
// CONSUMED BY chain.mjs: the direct operator sender (send) and the sponsored lease path (leaseSend). Module memory is not an obligation
// owner: a restart (fresh process or fresh module instance) must find every attempted write and every signed-but-unsettled sponsored lease
// BEFORE it may make another mutation from the same key. A record is written (atomic replace + fsync of file and directory) BEFORE the
// irreversible effect; a crash between the effect and its result therefore leaves the record, and it is treated as UNKNOWN.
// Never inferred: a consumed nonce is a FENCE (no later write can collide with it), not proof that the recorded operation succeeded.
// A store that cannot be loaded or written refuses new effects (the caller's error) and keeps the file untouched for diagnosis.
// Bounded: only unresolved records are kept (settled ones are removed), at most MAX_RECORDS, each with at most MAX_INTENTS signed intents;
// a full store refuses NEW operations rather than dropping an obligation.
import fs from "node:fs";
import path from "node:path";

export const OPERATOR_WRITES_SCHEMA = "enclave-operator-writes/1";
export const SPONSORED_OBLIGATIONS_SCHEMA = "enclave-sponsored-obligations/1";
export const MAX_RECORDS = 64;
export const MAX_INTENTS = 8;
const big = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);

function writeAtomic(file, text) {
  const dir = path.dirname(file), tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* directory fsync unsupported here (Windows): the rename is the commit */ }
}

/**
 * A strict keyed record file. load errors (unreadable, foreign schema, malformed) THROW on every call: the caller refuses new effects.
 * Absent file = empty (a host's first run); the file is created on the first put.
 */
export function openDurableRecords(file, schema) {
  if (!path.isAbsolute(String(file))) throw Error("durable operator records need an absolute file");
  const load = () => {
    let bytes;
    try { bytes = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return {}; throw Error(`operator obligation store unreadable: ${e.message}`); }
    let j; try { j = JSON.parse(bytes); } catch { throw Error("operator obligation store is malformed: kept for diagnosis, no new effect"); }
    if (!j || j.schema !== schema || !j.records || typeof j.records !== "object" || Array.isArray(j.records)) throw Error("operator obligation store has another schema: kept, no new effect");
    return j.records;
  };
  const save = (records) => writeAtomic(file, JSON.stringify({ schema, records }, big));
  return Object.freeze({
    file, schema,
    list: () => Object.entries(load()).map(([key, r]) => ({ key, ...r })),
    get: (key) => load()[key] ?? null,
    /** durable before return; refuses a NEW key when MAX_RECORDS unresolved obligations already exist (never drops one) */
    put(key, record) {
      const r = load();
      if (!Object.hasOwn(r, key) && Object.keys(r).length >= MAX_RECORDS) throw Error(`operator obligation store is full (${MAX_RECORDS} unresolved): no new effect until some settle`);
      r[key] = record; save(r);
    },
    remove(key) { const r = load(); if (Object.hasOwn(r, key)) { delete r[key]; save(r); } },
  });
}

/** TEST/entry: the configured file, or null. The Host passes <dir>/operator-writes.json; ENCLAVE_OPERATOR_WRITE_JOURNAL is the fallback. */
export function configuredFile(explicit, envName, env = process.env) {
  const f = explicit || String(env[envName] || "").trim();
  return f ? f : null;
}
