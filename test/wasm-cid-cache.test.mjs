// wasm/wasm_manager.py — the run-by-CID cache key must BE the content address.
//
// The manager caches a fetched wasm at APPS_DIR/ipfs-<cid>.wasm and returns the
// file on a hit WITHOUT re-verifying it, which is correct only while the key is
// the exact CID. It used to be re.sub("[^A-Za-z0-9]", "", cid) — a lossy
// transform — so two catalog CIDs differing only outside that class collapsed
// onto one file and the second ran the first one's bytes with no hash check at
// all. The catalog bounds a version's cid by LENGTH only, so any publisher
// could declare "bafy.REAL" beside a real "bafyREAL"; at that point the CID no
// longer names what runs, which is the one assumption the deploy gate rests on.
//
//   run: node --test test/wasm-cid-cache.test.mjs   (needs python3 on PATH)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WASM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "wasm");

// call _resolve_cid in-process and report what happened
function resolveCid(cid, appsDir) {
  const py = `
import sys, os, json
sys.path.insert(0, ${JSON.stringify(WASM_DIR)})
os.environ["WASM_APPS_DIR"] = ${JSON.stringify(appsDir)}
import wasm_manager as m
try:
    print(json.dumps({"ok": True, "path": str(m._resolve_cid(${JSON.stringify(cid)}))}))
except ValueError as e:
    print(json.dumps({"ok": False, "err": str(e)}))
`;
  return JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }).trim().split("\n").pop());
}

const REAL = "bafyrealappaaaaaaaaaaaaaaaaaaaaaaa";

test("a cached CID resolves to the file named by that exact CID", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, `ipfs-${REAL}.wasm`), "REAL BYTES");

  const r = resolveCid(REAL, dir);
  assert.equal(r.ok, true, r.err);
  assert.equal(path.basename(r.path), `ipfs-${REAL}.wasm`);
});

test("a near-miss CID must NOT take the real one's cache entry", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, `ipfs-${REAL}.wasm`), "REAL BYTES");

  // every one of these used to sanitize down onto ipfs-<REAL>.wasm and return
  // it as a hit — the declared CID never checked against the bytes served
  for (const twin of [
    REAL.slice(0, 4) + "." + REAL.slice(4),
    REAL.slice(0, 4) + " " + REAL.slice(4),
    REAL.slice(0, 4) + "/../" + REAL.slice(4),
    REAL.slice(0, 4) + "-" + REAL.slice(4),
    REAL.slice(0, 4) + "%2e" + REAL.slice(4),
  ]) {
    const r = resolveCid(twin, dir);
    assert.equal(r.ok, false, `${JSON.stringify(twin)} resolved to ${r.path}`);
    assert.match(r.err, /bad ipfs cid/);
  }
});

test("shapes that are not a CID are refused rather than sanitized", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const bad of ["", "   ", "../../etc/passwd", "short", "a".repeat(101), "bafy!" + "a".repeat(20)]) {
    const r = resolveCid(bad, dir);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} was accepted`);
  }
});
