// The component fetcher, against a CONTROLLED LOCAL fixture that behaves like fetch-cid.py:
// positional <cid> <out> [cap] [gateway], writes the file, prints "ok <bytes> <sha256>".
// No gateway, no network. The bug this pins: main.mjs called it as `--cid X --stdout`.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cidFetcher, CID_RE } from "./fetchcid.mjs";

const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const PAYLOAD = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]), crypto.randomBytes(120)]);

/** A stand-in for fetch-cid.py that INSISTS on the real argument form. */
function fixture({ payload = PAYLOAD, exitCode = 0, slow = false } = {}) {
  const calls = [];
  const run = async (python, args) => {
    calls.push({ python, args });
    const [script, cid, out, cap, gw] = args;
    if (String(cid).startsWith("--")) { const e = new Error("usage: fetch-cid.py <cid> <out> [max bytes] [gateway]"); e.code = 2; e.stderr = e.message; throw e; }
    if (!out || String(out).startsWith("--")) { const e = new Error("usage: fetch-cid.py <cid> <out>"); e.code = 2; e.stderr = e.message; throw e; }
    if (slow) { const e = new Error("timed out"); e.killed = true; throw e; }
    if (exitCode !== 0) { const e = new Error("fetch/verify failed"); e.code = exitCode; e.stderr = `fetch/verify failed for ${cid}: gateway 500`; throw e; }
    await fs.writeFile(out, payload);
    return { stdout: `ok ${payload.length} ${crypto.createHash("sha256").update(payload).digest("hex")}\n`, stderr: "" };
  };
  return { run, calls };
}

test("it calls fetch-cid.py the way fetch-cid.py actually works", async () => {
  const f = fixture();
  const bytes = await cidFetcher({ script: "C:\\node\\fetch-cid.py", run: f.run, maxBytes: 1024 })(CID);
  assert.deepEqual(bytes, PAYLOAD);
  const [call] = f.calls;
  assert.equal(call.args[0], "C:\\node\\fetch-cid.py");
  assert.equal(call.args[1], CID, "the CID is POSITIONAL, not --cid");
  assert.ok(call.args[2] && !call.args[2].startsWith("--"), "an output PATH, not --stdout");
  assert.equal(call.args[3], "1024", "the byte cap is the third positional");
  assert.equal(call.args.length, 4, "and no gateway unless one is configured");
});

test("the old call form would have been refused, and says so plainly", async () => {
  const f = fixture();
  // the shape main.mjs used: --cid CID --stdout
  const bad = async () => { const e = new Error("usage"); e.code = 2; e.stderr = "usage: fetch-cid.py <cid> <out> [max bytes] [gateway]"; throw e; };
  await assert.rejects(() => cidFetcher({ script: "s.py", run: bad })(CID), /refused the call .* check the argument form/);
});

test("a gateway is passed only when configured, as the fourth positional", async () => {
  const f = fixture();
  await cidFetcher({ script: "s.py", run: f.run, gateway: "https://ipfs.enclave.host" })(CID);
  assert.equal(f.calls[0].args[4], "https://ipfs.enclave.host");
});

test("the child is bounded, and a timeout is named as one", async () => {
  const f = fixture({ slow: true });
  await assert.rejects(() => cidFetcher({ script: "s.py", run: f.run, timeoutMs: 1234 })(CID), /timed out after 1234ms/);
  const f2 = fixture();
  await cidFetcher({ script: "s.py", run: f2.run, timeoutMs: 5000 })(CID);
  assert.equal(f2.calls[0].args.length >= 4, true);
});

test("a failed verification is an error, not an empty component", async () => {
  await assert.rejects(() => cidFetcher({ script: "s.py", run: fixture({ exitCode: 1 }).run })(CID), /gateway 500/);
});

test("bytes on disk are held to what the script said it verified", async () => {
  const run = async (python, args) => {
    await fs.writeFile(args[2], Buffer.from("tampered"));
    return { stdout: `ok 128 ${"ab".repeat(32)}\n`, stderr: "" };   // a count and hash that do not match
  };
  await assert.rejects(() => cidFetcher({ script: "s.py", run })(CID), /said 128 bytes and wrote 8/);
});

test("nothing is fetched for something that is not a bare CID", async () => {
  const f = fixture();
  for (const bad of ["ipfs://" + CID, "https://gw/ipfs/" + CID, "", null, "../../etc/passwd"])
    await assert.rejects(() => cidFetcher({ script: "s.py", run: f.run })(bad), /not a bare CID/);
  assert.equal(f.calls.length, 0, "and the fetcher is never even invoked");
  assert.equal(CID_RE.test(CID), true);
});

test("the temp file is cleaned up whether it worked or not", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cidtest-"));
  const f = fixture();
  await cidFetcher({ script: "s.py", run: f.run, tmpDir: base })(CID);
  await assert.rejects(() => cidFetcher({ script: "s.py", run: fixture({ exitCode: 1 }).run, tmpDir: base })(CID));
  assert.deepEqual(await fs.readdir(base), [], "no component bytes left lying in temp");
  await fs.rm(base, { recursive: true, force: true });
});

// ---- READINESS.md M6: the fetcher writes no bytecode into the tree it runs from --------------------------------------
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = ["python3", "python"].find((p) => { const r = spawnSync(p, ["-c", "import sys; print(sys.version_info[0])"]); return !r.error && String(r.stdout).trim() === "3"; });

test("the fetcher runs Python with PYTHONDONTWRITEBYTECODE=1, and the rest of the environment is inherited", async () => {
  const seen = [];
  const run = async (python, args, opts) => { seen.push(opts); throw Object.assign(new Error("stop here"), { code: 1, stderr: "x" }); };
  await assert.rejects(() => cidFetcher({ script: "s.py", run })(CID));
  assert.equal(seen[0].env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(seen[0].env.PATH, process.env.PATH, "PATH and the rest are the manager's own");
});

test("a REAL fetch leaves the fetcher's directory unchanged (no __pycache__), where the same fetch without the setting writes one", { skip: !PY && "no python 3" }, async () => {
  const tree = fsSync.mkdtempSync(path.join(os.tmpdir(), "m6-tree-")), elsewhere = fsSync.mkdtempSync(path.join(os.tmpdir(), "m6-out-"));
  fsSync.copyFileSync(path.join(HERE, "../../node/fetch-cid.py"), path.join(tree, "fetch-cid.py"));
  fsSync.copyFileSync(path.join(HERE, "../../../wasm/ipfs_fetch.py"), path.join(tree, "ipfs_fetch.py"));
  const listing = () => fsSync.readdirSync(tree).sort(), before = listing();
  // a gateway that answers 404 to everything: fetch-cid.py imports ipfs_fetch at startup, then fails fast, on this host only
  const gw = http.createServer((q, r) => { r.writeHead(404); r.end(); });
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  const gateway = `http://127.0.0.1:${gw.address().port}`;
  try {
    await assert.rejects(() => cidFetcher({ script: path.join(tree, "fetch-cid.py"), python: PY, gateway, timeoutMs: 30_000 })(CID));
    assert.deepEqual(listing(), before, "the fetcher's directory is exactly as it was: no __pycache__, no .pyc");
    // the control: the same call WITHOUT the setting writes the bytecode this test exists to catch
    const env = { ...process.env }; delete env.PYTHONDONTWRITEBYTECODE;
    await promisify(execFile)(PY, [path.join(tree, "fetch-cid.py"), CID, path.join(elsewhere, "c.wasm"), "1024", gateway], { env, timeout: 30_000 }).catch(() => {});
    assert.ok(listing().includes("__pycache__"), `without the setting the import writes __pycache__ (listing: ${listing().join(", ")})`);
  } finally { gw.close(); fsSync.rmSync(tree, { recursive: true, force: true }); fsSync.rmSync(elsewhere, { recursive: true, force: true }); }
});
