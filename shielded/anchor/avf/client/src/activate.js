// activate.js -- running a staged update (client/DESIGN.md "Activation"; LAB, CLI only). The installed artifact, given out
// of band, is the LAUNCHER and the only root of code trust: it runs every maintenance command itself, and only `run`
// executes a newer ACTIVE version. Code never comes from a path twice: a recorded artifact is read ONCE into memory, held
// to its record (sha256, size, its own version line), and those very bytes are handed to `node --input-type=module -` over
// a pipe only this process writes. A file swapped after the read cannot change what runs.
//   activateStaged(store, { dir, clientVersion })  explicit only (`pvm-client activate`; `update` never activates):
//     the staged record must be newer than max(active, this client); its bytes are read once and verified; a START CHECK
//     runs them, from memory, with `version` in a scrubbed environment (no NODE_OPTIONS, HOME and XDG_CONFIG_HOME an empty
//     scratch directory, no --state) and requires exactly their recorded version; then the store's compare-and-swap
//     records `active` -- only if, on the NEWEST state, the staged record is still exactly the one verified and nothing
//     newer is active. The commit spreads the newest state, so a concurrent policy commit or key rotation survives.
//   launchActive(active, { dir, stateDir, args })  what `run` does when a newer version is active: the recorded bytes,
//     read once and verified, run with the user's args plus explicit --state and --install-dir (a child fed over stdin
//     has no path of its own), and ENCLAVE_PVM_CLIENT_DELEGATED=<version>:<sha256>, so the child runs `run` itself and
//     never delegates again (one hop). Missing or changed bytes: refused, nothing runs -- NO fallback to an older client.
// Nothing here moves a floor backward: active only grows (active <= staged), there is no rollback, and a failed start
// check, a crash or a lost race records nothing. `hold` and `afterVerify` are test barriers only; the CLI passes neither.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { semverCmp, VERSION_MARKER, CLIENT_VERSION } from "./trust.js";

export const DELEGATED = "ENCLAVE_PVM_CLIENT_DELEGATED";
const START_TIMEOUT_MS = 30000, START_OUTPUT_MAX = 65536;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The fields that name an artifact; staged and active records are compared on exactly these. */
export const recordOf = (s) => ({ version: s.version, sha256: s.sha256, size: s.size, file: s.file, sourceCommit: s.sourceCommit });
const sameRecord = (a, b) => !!a && !!b && ["version", "sha256", "size", "file", "sourceCommit"].every((k) => a[k] === b[k]);

/** Read a recorded artifact ONCE and hold the bytes to the record: { ok, bytes } | { ok: false, reason, found }. */
export function readRecorded(dir, rec) {
  let bytes;
  try { bytes = fs.readFileSync(path.join(dir, rec.file)); }
  catch (e) { return { ok: false, found: "missing", reason: `${rec.file} cannot be read (${e.code || e.message})` }; }
  const h = sha256(bytes);
  if (h !== rec.sha256) return { ok: false, found: h, reason: `${rec.file} does not hold the recorded bytes (sha256 ${h}, recorded ${rec.sha256})` };
  if (rec.size !== undefined && bytes.length !== rec.size) return { ok: false, found: h, reason: `${rec.file} is ${bytes.length} bytes, recorded ${rec.size}` };
  const first = bytes.subarray(0, 200).toString("utf8").split("\n")[0];
  if (!first.startsWith(`${VERSION_MARKER}${rec.version} `)) return { ok: false, found: h, reason: `${rec.file}'s own version line is not ${rec.version}` };
  return { ok: true, bytes };
}

/** Run in-memory bytes as an ES module: the child reads its program from a pipe only this process writes, never a path. */
export function runBytes(bytes, args, { env, cwd, stdio = ["pipe", "inherit", "inherit"] } = {}) {
  const c = spawn(process.execPath, ["--input-type=module", "-", ...args], { env, cwd, stdio });
  c.stdin.on("error", () => {});   // a child that dies before reading its program: its exit says so
  c.stdin.end(bytes);
  return c;
}
const ended = (c) => new Promise((r) => { c.on("error", (e) => r({ error: e })); c.on("close", (code, sig) => r({ code, sig })); });
const childEnv = (over = {}) => { const e = { ...process.env }; delete e.NODE_OPTIONS; delete e[DELEGATED]; return { ...e, ...over }; };

/** The start check: the verified bytes, from memory, in a scrubbed environment, answer `version` with exactly `version`. */
export async function startCheck(bytes, version) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-start-"));
  try {
    const c = runBytes(bytes, ["version"], { env: childEnv({ HOME: scratch, XDG_CONFIG_HOME: scratch }), cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", timedOut = false;
    c.stdout.on("data", (d) => { out += d; if (out.length > START_OUTPUT_MAX) c.kill("SIGKILL"); });
    c.stderr.on("data", () => {});
    const t = setTimeout(() => { timedOut = true; c.kill("SIGKILL"); }, START_TIMEOUT_MS);
    const e = await ended(c); clearTimeout(t);
    if (e.error) return `it could not be started (${e.error.message})`;
    if (e.sig) return timedOut ? `it did not answer within ${START_TIMEOUT_MS / 1000} s` : `it ended by signal ${e.sig}`;
    if (e.code !== 0) return `it exited ${e.code}`;
    const lines = out.split("\n").filter(Boolean);
    let v = null; try { v = lines.length === 1 ? JSON.parse(lines[0]) : null; } catch {}
    if (!v || typeof v !== "object" || v.client !== "enclave-pvm-client" || v.version !== version)
      return `it answered ${JSON.stringify(out.slice(0, 200))}, not exactly one line naming version ${version}`;
    return null;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

/** Explicit activation of the staged update: { ok, version, sha256, gen, already? } | { ok: false, step, reasons, expected?, found? }. */
export async function activateStaged(store, { dir, clientVersion = CLIENT_VERSION, hold = null, afterVerify = null } = {}) {
  const no = (step, reason, extra = {}) => ({ ok: false, step, reasons: [reason], ...extra });
  const cur = store.latest();
  if (!cur) return no("nothing newer", "no client installed");
  const s = cur.state.staged, a = cur.state.active || null;
  if (!s) return no("nothing newer", "nothing is staged");
  const rec = recordOf(s);
  if (a && sameRecord(a, rec)) return { ok: true, version: a.version, sha256: a.sha256, gen: cur.gen, already: true };
  const floor = a && semverCmp(a.version, clientVersion) > 0 ? a.version : clientVersion;
  if (semverCmp(rec.version, floor) <= 0) return no("nothing newer", `staged ${rec.version} is not newer than ${a ? `the active ${a.version} or ` : ""}this client ${clientVersion}: nothing to activate`);
  const got = readRecorded(dir, rec);
  if (!got.ok) return no("file", `${got.reason}: nothing activated, nothing run`, { expected: { version: rec.version, sha256: rec.sha256, file: rec.file }, found: got.found });
  if (afterVerify) await afterVerify();
  const why = await startCheck(got.bytes, rec.version);
  if (why) return no("start check", `${rec.version} failed its start check: ${why}; nothing activated`);
  let r, step = null;
  try {
    r = await store.update(async (state) => {
      if (hold) await hold(state);
      step = null;
      const ns = state.staged ? recordOf(state.staged) : null, na = state.active || null;
      if (na && sameRecord(na, rec)) return { same: true };
      if (!sameRecord(ns, rec)) { step = "changed while activating"; return { refuse: `the staged update changed while activating (staged is now ${ns ? `${ns.version} ${ns.sha256.slice(0, 12)}` : "nothing"}): nothing activated; run activate again` }; }
      if (na && semverCmp(na.version, rec.version) >= 0) { step = "nothing newer"; return { refuse: `${na.version} is already active: ${rec.version} cannot replace it` }; }
      return { state: { ...state, active: rec } };
    });
  } catch (e) { return no("commit", `could not record the activation durably (${e.message}): nothing activated`); }
  if (!r.ok) return no(step || "nothing newer", r.reason);
  return { ok: true, version: rec.version, sha256: rec.sha256, gen: r.gen, ...(r.same ? { already: true } : {}) };
}

// the user's args with --state and --install-dir replaced by the resolved ones: the child has no path of its own
function withDirs(args, stateDir, installDir) {
  const out = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === "--state" || args[i] === "--install-dir") { i++; continue; } out.push(args[i]); }
  return [...out, "--state", stateDir, "--install-dir", installDir];
}

/** `run` under a newer active version: { refused } (nothing ran) | { error } | { code, sig } (the child's own end). */
export async function launchActive(active, { dir, stateDir, args, hold = null }) {
  const got = readRecorded(dir, active);
  if (!got.ok) return { refused: { step: "launch", refused: `the active client ${active.version} cannot start: ${got.reason}; nothing was run (no fallback to an older client)`, sent: false,
                                   expected: { version: active.version, sha256: active.sha256, file: active.file }, found: got.found } };
  if (hold) await hold();
  const e = await ended(runBytes(got.bytes, ["run", ...withDirs(args, stateDir, dir)], { env: childEnv({ [DELEGATED]: `${active.version}:${active.sha256}` }) }));
  if (e.error) return { error: `the active client ${active.version} could not be started (${e.error.message})` };
  return { code: e.code, sig: e.sig };
}
