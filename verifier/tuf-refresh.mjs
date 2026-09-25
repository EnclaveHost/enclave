#!/usr/bin/env node
// verifier/tuf-refresh.mjs: the TUF-verified refresh of the pinned Sigstore trusted root (docs/security/independent-verifier-plan.md, M4).
//
// The consumers verify release provenance against verifier/roots/sigstore-trusted-root.json, a copy of Sigstore's
// `trusted_root.json` target. Until now that copy was reached by following hashes through TUF metadata WITHOUT verifying
// the metadata's signatures (its SOURCES.json says so). This module refreshes it the way TUF prescribes, from PINNED
// trust: the starting root is verifier/roots/sigstore-tuf-root.json (the highest root metadata verified so far; the
// chain back to root v1 is recorded in roots/SOURCES.json, and v1 is anchored by two independent sources), and from it
// @freedomofpress/tuf-browser walks root rotations (N+1 exactly, each signed to the threshold of BOTH the old and the
// new root, never expired), then timestamp -> snapshot -> targets (signatures to threshold, versions never lower than
// the cached ones, expiry against the clock, lengths and hashes from the role above), then the target by its hash and
// length. Every role is cached in a file backend as it verifies (the TUF client's own order), so an update that fails
// half-way leaves the cache spec-consistent and the PINNED FILES untouched: the trusted root and the starting root are
// replaced only on a fully verified refresh, atomically, and only when the caller says --write. Nothing here is a new
// authority: a mirror or a CDN can only refuse to serve; it cannot serve anything the chain from the pinned root does
// not sign. The clock is the machine's (the client's freeze check), so an expired timestamp refuses, as it should.
//
//   node verifier/tuf-refresh.mjs refresh [--metadata-url U] [--targets-url U] [--starting-root F] [--state DIR] [--target trusted_root.json]
//                                         [--out report.json] [--write]      exit 0 verified (changed or not), 1 refused, 2 usage
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOTS_DIR = path.join(REPO, "verifier", "roots");
export const TRUSTED_ROOT_FILE = path.join(ROOTS_DIR, "sigstore-trusted-root.json");
export const STARTING_ROOT_FILE = path.join(ROOTS_DIR, "sigstore-tuf-root.json");
export const SIGSTORE_METADATA_URL = "https://tuf-repo-cdn.sigstore.dev/";
export const SIGSTORE_TARGETS_URL = "https://tuf-repo-cdn.sigstore.dev/targets/";
export const TARGET_NAME = "trusted_root.json";
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

// A file backend for the TUF client: one file per cache key under dir, written atomically. read() gives the parsed
// metafile the client expects; the raw bytes are what the client wrote (it verifies hashes over them).
export function createFileBackend(dir) {
  const safe = (key) => { if (/(^|\/)\.\.(\/|$)|\\|^\//.test(key)) throw new Error(`backend key ${JSON.stringify(key)} is not allowed`); return path.join(dir, key); };
  const writeAtomic = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); };
  return {
    dir,
    async read(key) { try { return JSON.parse(fs.readFileSync(safe(key), "utf8")); } catch (e) { if (e.code === "ENOENT") return undefined; throw e; } },
    async write(key, value) { writeAtomic(safe(key), JSON.stringify(value)); },
    async writeRaw(key, bytes) { writeAtomic(safe(key), Buffer.from(bytes)); },
    async delete(key) { try { fs.unlinkSync(safe(key)); } catch (e) { if (e.code !== "ENOENT") throw e; } },
    rawOf(key) { try { return fs.readFileSync(safe(key)); } catch { return null; } },
  };
}
const NAMESPACE = "sigstore";
const roleKey = (role) => `${NAMESPACE}/${role}.json`;
const versionOf = (backend, role) => { const raw = backend.rawOf(roleKey(role)); if (!raw) return null; try { const j = JSON.parse(raw.toString("utf8")); return { version: j.signed?.version ?? null, expires: j.signed?.expires ?? null, sha256: sha256hex(raw) }; } catch { return null; } };

// refreshTrustedRoot -> { ok, bytes, sha256, changed, versions: { root, timestamp, snapshot, targets }, startingRootVersion, reasons } | { ok: false, error, versions, reasons }
export async function refreshTrustedRoot({ metadataUrl = SIGSTORE_METADATA_URL, targetsUrl = SIGSTORE_TARGETS_URL, startingRoot = null, startingRootFile = STARTING_ROOT_FILE,
                                           stateDir = null, backend = null, target = TARGET_NAME, currentTrustedRoot = null, currentTrustedRootFile = TRUSTED_ROOT_FILE, log = () => {} } = {}) {
  const reasons = [];
  const rootText = startingRoot ?? fs.readFileSync(startingRootFile, "utf8");
  let startingRootVersion = null;
  try { startingRootVersion = JSON.parse(rootText).signed.version; } catch { return { ok: false, error: "the starting root is not TUF root metadata", versions: {}, reasons }; }
  const be = backend ?? createFileBackend(stateDir ?? fs.mkdtempSync(path.join(REPO, ".tuf-state-")));
  const before = { root: versionOf(be, "root"), timestamp: versionOf(be, "timestamp"), snapshot: versionOf(be, "snapshot"), targets: versionOf(be, "targets") };
  let current = null;
  try { current = currentTrustedRoot ?? fs.readFileSync(currentTrustedRootFile); } catch { current = null; }
  const { TUFClient } = await import("@freedomofpress/tuf-browser");
  const client = new TUFClient(String(metadataUrl).replace(/\/?$/, "/"), rootText, NAMESPACE, String(targetsUrl).replace(/\/?$/, "/"), { backend: be });
  let bytes;
  // The client separates the update (root rotations, timestamp, snapshot, targets) from the target fetch; both, in order.
  // Its update returns early when the served timestamp equals the cached one. After an update that failed half-way
  // (timestamp cached, snapshot or targets not), that early return would leave the cached snapshot/targets stale for as
  // long as the timestamp version stands (measured 2026-09-25 against a minted repository), so the chain below the
  // timestamp is checked for consistency here and, when it is not, the cached timestamp is dropped and the update run
  // once more: the same signatures are verified again, nothing is trusted that was not.
  const consistent = () => {
    const t = versionOf(be, "timestamp"), sn = versionOf(be, "snapshot"), tg = versionOf(be, "targets");
    if (!t) return true;
    const tj = JSON.parse(be.rawOf(roleKey("timestamp")).toString("utf8")), want = tj.signed?.meta?.["snapshot.json"]?.version;
    if (!sn || sn.version !== want) return false;
    const sj = JSON.parse(be.rawOf(roleKey("snapshot")).toString("utf8")), wantT = sj.signed?.meta?.["targets.json"]?.version;
    return !!tg && tg.version === wantT;
  };
  try {
    await client.updateTUF();
    if (!consistent()) { reasons.push("the cached chain below the timestamp was incomplete (an earlier update stopped half-way): the timestamp is re-verified and the snapshot and targets fetched again"); await be.delete(roleKey("timestamp")); await client.updateTUF(); }
    if (!consistent()) throw new Error("the cached snapshot/targets do not match the verified timestamp after the update");
    bytes = Buffer.from(await client.getTarget(target));
  }
  catch (e) {
    const after = { root: versionOf(be, "root"), timestamp: versionOf(be, "timestamp"), snapshot: versionOf(be, "snapshot"), targets: versionOf(be, "targets") };
    reasons.push(`REFUSED: ${e.message}`);
    return { ok: false, error: e.message, startingRootVersion, versions: after, before, reasons, current: current ? { sha256: sha256hex(current), bytes: current.length } : null };
  }
  // the client caches the root only after a rotation: with none, the starting root IS the current root
  const startingRaw = Buffer.from(rootText, "utf8");
  const versions = { root: versionOf(be, "root") ?? { version: startingRootVersion, expires: JSON.parse(rootText).signed?.expires ?? null, sha256: sha256hex(startingRaw) }, timestamp: versionOf(be, "timestamp"), snapshot: versionOf(be, "snapshot"), targets: versionOf(be, "targets") };
  const digest = sha256hex(bytes);
  let parsed; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return { ok: false, error: "the target is not JSON", startingRootVersion, versions, before, reasons: [...reasons, "REFUSED: the fetched target is not JSON"] }; }
  if (!Array.isArray(parsed.certificateAuthorities) || !Array.isArray(parsed.tlogs)) return { ok: false, error: "the target is not a Sigstore trusted root", startingRootVersion, versions, before, reasons: [...reasons, "REFUSED: the target has no certificateAuthorities/tlogs"] };
  const changed = !current || sha256hex(current) !== digest;
  reasons.push(`TUF: root v${startingRootVersion} -> v${versions.root?.version ?? startingRootVersion} (${(versions.root?.version ?? startingRootVersion) - startingRootVersion} rotation(s)), timestamp v${versions.timestamp?.version}, snapshot v${versions.snapshot?.version}, targets v${versions.targets?.version}; ${target} ${digest.slice(0, 16)}... (${bytes.length} bytes) ${changed ? "DIFFERS from the pinned copy" : "equals the pinned copy"}`);
  return { ok: true, bytes, sha256: digest, changed, startingRootVersion, versions, before, reasons, current: current ? { sha256: sha256hex(current), bytes: current.length } : null, rootRaw: be.rawOf(roleKey("root")) ?? startingRaw };
}

// Replace the pinned files only from a fully verified refresh: the trusted root, the starting root (the highest root
// verified), and the SOURCES entries. Atomic per file; nothing is written unless r.ok.
export function writePinned(r, { rootsDir = ROOTS_DIR, metadataUrl = SIGSTORE_METADATA_URL, targetsUrl = SIGSTORE_TARGETS_URL, target = TARGET_NAME, now = new Date() } = {}) {
  if (!r?.ok) throw new Error("only a verified refresh is written");
  const write = (file, bytes) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, file); };
  const sourcesFile = path.join(rootsDir, "SOURCES.json");
  let sources = {}; try { sources = JSON.parse(fs.readFileSync(sourcesFile, "utf8")); } catch {}
  const at = now.toISOString().slice(0, 16) + "Z";
  write(path.join(rootsDir, "sigstore-trusted-root.json"), r.bytes);
  sources["sigstore-trusted-root.json"] = { ...(sources["sigstore-trusted-root.json"] || {}), sha256: r.sha256, length: r.bytes.length, refreshedAt: at,
    tuf: { metadataUrl, targetsUrl, target, startingRootVersion: r.startingRootVersion, rootVersion: r.versions.root?.version ?? r.startingRootVersion, timestampVersion: r.versions.timestamp?.version ?? null, snapshotVersion: r.versions.snapshot?.version ?? null, targetsVersion: r.versions.targets?.version ?? null,
           note: "reached through TUF from the pinned starting root (verifier/tuf-refresh.mjs): root rotations, timestamp, snapshot and targets signatures verified to threshold, versions never lower than cached, expiry checked, the target by hash and length" } };
  if (r.rootRaw) {
    write(path.join(rootsDir, "sigstore-tuf-root.json"), r.rootRaw);
    sources["sigstore-tuf-root.json"] = { ...(sources["sigstore-tuf-root.json"] || {}), sha256: sha256hex(r.rootRaw), version: r.versions.root?.version ?? r.startingRootVersion, refreshedAt: at, what: "the highest Sigstore TUF root metadata verified through the rotation chain: the starting root of the next refresh (pinned trust)" };
  }
  write(sourcesFile, JSON.stringify(sources, null, 1) + "\n");
  return { trustedRoot: path.join(rootsDir, "sigstore-trusted-root.json"), startingRoot: path.join(rootsDir, "sigstore-tuf-root.json"), sources: sourcesFile };
}

async function main() {
  const args = process.argv.slice(2), cmd = args.shift();
  const opt = (n, d = null) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
  if (cmd !== "refresh") { console.error("usage: tuf-refresh.mjs refresh [--metadata-url U] [--targets-url U] [--starting-root F] [--state DIR] [--target NAME] [--out F] [--write]"); process.exit(2); }
  const stateDir = opt("state") || path.join(REPO, ".tuf-state");
  const r = await refreshTrustedRoot({ metadataUrl: opt("metadata-url") || SIGSTORE_METADATA_URL, targetsUrl: opt("targets-url") || SIGSTORE_TARGETS_URL, startingRootFile: opt("starting-root") || STARTING_ROOT_FILE, stateDir, target: opt("target") || TARGET_NAME });
  const report = { at: new Date().toISOString(), ok: r.ok, changed: r.changed ?? null, sha256: r.sha256 ?? null, startingRootVersion: r.startingRootVersion ?? null, versions: r.versions, before: r.before ?? null, current: r.current ?? null, reasons: r.reasons, error: r.error ?? null, stateDir };
  if (opt("out")) fs.writeFileSync(opt("out"), JSON.stringify(report, null, 2) + "\n");
  for (const x of r.reasons) console.log(x);
  if (!r.ok) { console.log("tuf-refresh: REFUSED; the pinned files are untouched"); process.exit(1); }
  if (args.includes("--write")) { const w = writePinned(r); console.log(`tuf-refresh: written ${path.relative(REPO, w.trustedRoot)}, ${path.relative(REPO, w.startingRoot)}, ${path.relative(REPO, w.sources)}`); }
  else console.log(`tuf-refresh: verified; ${r.changed ? "the pinned trusted root DIFFERS (run with --write to update it)" : "the pinned trusted root is current"}; not written`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`tuf-refresh: ${e.message}`); process.exit(2); });
