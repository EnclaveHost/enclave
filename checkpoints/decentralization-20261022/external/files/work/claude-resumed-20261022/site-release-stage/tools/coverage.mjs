#!/usr/bin/env node
// coverage.mjs <stage src> <live site dir> <hotfix base dir> : READ-ONLY old-asset / CSP retention evidence for the planned
// `prepare --base <hotfix base dir>`, computed with the STAGED release tool itself (scripts/site-release/*.mjs):
//   1. both trees re-import (kubo-identical importDirectory) to their CIDs: live bafybeieuxt6… and hotfix bafybeig3rai3…;
//   2. every live js/chunks file is in the hotfix base with identical bytes (so retaining the base retains live);
//   3. openBase(hotfix) as prepare will open it (no ledger, no --base-built-at): its CID, that EVERY inherited chunk is dated
//      `now` (kept 48h after the new build), and the CSP script-src hashes it carries;
//   4. those CSP hashes contain every inline-script hash of the LIVE page set (parseScriptSrc of both csp-script-src.txt).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [SRC, LIVE, BASE] = process.argv.slice(2).map((p) => path.resolve(p));
const { importDirectory } = await import(path.join(SRC, "scripts/site-release/unixfs.mjs"));
const { openBase, parseScriptSrc } = await import(path.join(SRC, "scripts/site-release/release.mjs"));
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const LIVE_CID = "bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou", BASE_CID = "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y";
const fail = [];
const liveCid = importDirectory(LIVE).cid, baseCid = importDirectory(path.join(BASE, "site")).cid;
if (liveCid !== LIVE_CID) fail.push(`live tree imports to ${liveCid}`);
if (baseCid !== BASE_CID) fail.push(`hotfix tree imports to ${baseCid}`);
const chunks = (root) => { const out = {}; const d = path.join(root, "js/chunks");
  for (const e of fs.readdirSync(d, { recursive: true, withFileTypes: true })) if (e.isFile()) { const p = path.join(e.parentPath ?? e.path, e.name); out[path.relative(root, p)] = sha(p); } return out; };
const lc = chunks(LIVE), bc = chunks(path.join(BASE, "site"));
const missing = Object.keys(lc).filter((k) => !(k in bc)), differ = Object.keys(lc).filter((k) => k in bc && bc[k] !== lc[k]);
if (missing.length || differ.length) fail.push(`live chunks not retained by the base: missing ${missing.length}, differ ${differ.length}`);
const now = Date.parse("2026-10-23T00:00:00Z");                                 // any build time: no ledger -> dated to it
const b = openBase(BASE, { builtAt: null, now });
if (b.cid !== BASE_CID) fail.push(`openBase names ${b.cid}`);
if (b.ledger !== null) fail.push("the base unexpectedly carries a ledger");
const undated = Object.keys(bc).filter((p) => b.lastBuiltAt(p) !== now);
if (undated.length) fail.push(`${undated.length} base chunks are not dated to the build time`);
const liveCsp = parseScriptSrc(fs.readFileSync(path.join(LIVE, "csp-script-src.txt"), "utf8")).hashes;
const baseHashes = new Set(b.hashes.map((h) => h.hash));
const cspMissing = liveCsp.filter((h) => !baseHashes.has(h));
if (cspMissing.length) fail.push(`live inline-script hashes absent from the base CSP: ${cspMissing.length}`);
console.log(JSON.stringify({ liveCid, baseCid, liveChunks: Object.keys(lc).length, baseChunks: Object.keys(bc).length, liveChunksRetainedByteIdentical: !missing.length && !differ.length,
  baseLedger: b.ledger, inheritedDatedToBuild: !undated.length, liveCspHashes: liveCsp.length, baseCspHashes: baseHashes.size, liveCspCovered: !cspMissing.length, failures: fail }, null, 1));
if (fail.length) { console.error("COVERAGE-FAILED"); process.exit(1); }
console.log("COVERAGE-OK");
