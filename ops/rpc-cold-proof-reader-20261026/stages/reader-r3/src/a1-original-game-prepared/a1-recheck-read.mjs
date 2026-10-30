#!/usr/bin/env node
// A1 original-game recheck runner for root (READ-ONLY; never run by this stage). Usage:
//   ANCHOR_DEPS_ROOT=<checkout> node a1-recheck-read.mjs RECHECK_CONFIG.json INITIAL_A1_EVIDENCE.json > recheck.json
// Transport is the pinned A1 rpc(): loopback-only URLs, streamed byte cap, timeout, redirect:error, JSON-RPC envelope
// checks (./a1-read.mjs: cold-proof-timeout-stage r3 per-class deadlines + monotonic read budget checked before emission +
// end-of-read age check). heliosUrl = our own pinned Helios (verifier); elUrl = our own
// reth (UNTRUSTED proof source). No public RPC, no fallback. Exit 3 = refused (JSON names the code).
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak_256 } from "./test/deps.mjs";
import { headerHash } from "./vendor/anchor-bootstrap.mjs";
import { a1io, finishRead } from "./a1-read.mjs";
import { runRecheck } from "./a1-recheck.mjs";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const initial = new Uint8Array(fs.readFileSync(process.argv[3]));
  const io = a1io(cfg);
  const out = await runRecheck(cfg, initial, io, { keccak: (b) => keccak_256(b), headerHash, sha256, now: () => Date.now() });
  const end = Date.now(); finishRead(io, out, cfg, end);
  process.stdout.write(JSON.stringify({ ...out, at: new Date(end).toISOString() }, null, 1) + "\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ verdict: "refused", code: e.code || "error", message: String(e.message || e).slice(0, 300) }) + "\n");
  process.exitCode = 3;
}
