#!/usr/bin/env node
// A1 original-game recheck runner for root (READ-ONLY; never run by this stage). Usage:
//   ANCHOR_DEPS_ROOT=<checkout> node a1-recheck-read.mjs RECHECK_CONFIG.json INITIAL_A1_EVIDENCE.json > recheck.json
// Transport is the pinned A1 rpc(): loopback-only URLs, streamed byte cap, timeout, redirect:error, JSON-RPC envelope
// checks (./a1-read.mjs sha256 a501a3ec..., unmodified). heliosUrl = our own pinned Helios (verifier); elUrl = our own
// reth (UNTRUSTED proof source). No public RPC, no fallback. Exit 3 = refused (JSON names the code).
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak_256 } from "./test/deps.mjs";
import { headerHash } from "./vendor/anchor-bootstrap.mjs";
import { rpc, loopbackUrl } from "./a1-read.mjs";
import { runRecheck } from "./a1-recheck.mjs";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const initial = new Uint8Array(fs.readFileSync(process.argv[3]));
  const io = { helios: rpc(loopbackUrl(cfg.heliosUrl, "heliosUrl")), el: rpc(loopbackUrl(cfg.elUrl, "elUrl")) };
  const out = await runRecheck(cfg, initial, io, { keccak: (b) => keccak_256(b), headerHash, sha256, now: () => Date.now() });
  process.stdout.write(JSON.stringify({ ...out, at: new Date().toISOString() }, null, 1) + "\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ verdict: "refused", code: e.code || "error", message: String(e.message || e).slice(0, 300) }) + "\n");
  process.exitCode = 3;
}
