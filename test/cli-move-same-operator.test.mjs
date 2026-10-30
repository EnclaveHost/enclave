// `enclave --independent move` refuses a target run by the SAME operator key as the current lease holder, before any host
// or directory is contacted (work/independent-move-fix-interface.txt). The deployed ledger's release(id) names no lease,
// only the operator, so a late release from the source could end such a target's lease while its app runs; until the
// ledger can condition a release on the lease it means (work/lease-epoch-proposal.txt) the CLI does not offer that move.
// Same-operator move parity stays OPEN; this is the temporary refusal, not parity.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak256, toBytes } from "viem";
import { haveTools, startRig, openSession, KEYS } from "./helpers/cli-independent-rig.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = process.env.ENCLAVE_CLI_ENTRY || path.join(REPO, "cli", "enclave.mjs");
const GUARD = pathToFileURL(path.join(REPO, "test/helpers/cli-network-guard.mjs")).href;
const SIB_ENDPOINT = "https://sibling.independent.test", SIBLING = keccak256(toBytes(SIB_ENDPOINT));
const OTHER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";   // anvil #4: another operator
const OTHER_ENDPOINT = "https://other.independent.test", OTHER = keccak256(toBytes(OTHER_ENDPOINT));
const skip = haveTools();
const T = skip ? { skip, timeout: 180000 } : { timeout: 180000 };
let r, tmp, pinsFile, netLog, sessionDir, directory, directoryHits = 0;

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-move-sameop-"));
  pinsFile = path.join(tmp, "pins.json"); fs.writeFileSync(pinsFile, JSON.stringify(r.pins));
  netLog = path.join(tmp, "net.log"); fs.writeFileSync(netLog, "");
  sessionDir = path.join(tmp, "sessions");
  // a directory that counts every request: the refusal must come before any is made
  directory = http.createServer((req, res) => { directoryHits++; res.writeHead(404); res.end(); });
  r.stops.push(r.closeServer(directory));
  await new Promise((ok) => directory.listen(0, "127.0.0.1", ok));
  for (const [key, endpoint] of [[KEYS.operator, SIB_ENDPOINT], [OTHER_KEY, OTHER_ENDPOINT]])
    await r.write(r.wc(key), r.addresses.registry, r.A.registry4.abi, "register", [endpoint, "independent/host", "0x" + "00".repeat(32), 1000n, 0n,
      "0x0000000000000000000000000000000000000000"]);
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

function cli(args) {
  const base = ["--independent", "--contract-pins", pinsFile, "--usdc-token", r.addresses.usdc, "--rpc", r.rpcs.join(","), "--confirmations", "1", "--yes"];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, ...base], { cwd: tmp, env: {
      PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "conf"), ENCLAVE_SESSION_DIR: sessionDir, ENCLAVE_KEY: KEYS.owner,
      ENCLAVE_API_BASE: r.apiOrigin, ENCLAVE_ADDRESS_BOOK: "0x" + "ab".repeat(20), NODE_OPTIONS: `--import=${GUARD}`,
      ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(r.apiPort) } });
    let out = "", err = "";
    const killer = setTimeout(() => { err += "\n[test: CLI killed after 150 s]"; p.kill("SIGKILL"); }, 150000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err }); });
  });
}

test("move to a host of the SAME operator is refused with the reason, before any host or directory is contacted; another operator's host passes that check", T, async () => {
  const s = await openSession(r, { sessionDir, actions: ["api.status", "api.restart", "api.placement"] });
  const id = await s.createViaVault();
  await r.write(r.wc(KEYS.owner), r.addresses.usdc, r.A.usdc.abi, "approve", [r.addresses.ledger, 5_000_000n]);
  await r.write(r.wc(KEYS.owner), r.addresses.ledger, r.A.ledger.abi, "fund", [id, 2_000_000n]);
  await r.write(r.wc(KEYS.operator), r.addresses.ledger, r.A.ledger.abi, "claim", [id, r.runner]);
  await r.mine(); await r.mine();
  const dirs = ["--directories", `http://127.0.0.1:${directory.address().port}`, "--state-dir", path.join(tmp, "mstate")];
  const x = await cli(["move", id, SIBLING, ...dirs]);
  assert.equal(x.code, 1, x.err + x.out);
  assert.match(x.err, /is run by the same operator \(0x[0-9a-f]{40}\) as the current host/);
  assert.match(x.err, /a release names no lease, only the operator, so a move between two hosts of one operator cannot be made safe/);
  assert.match(x.err, /nothing was sent/);
  assert.equal(directoryHits, 0, "no directory was asked for any management record");
  // the control: a host of ANOTHER operator gets past that check and stops only at its missing management record
  const y = await cli(["move", id, OTHER, ...dirs]);
  assert.equal(y.code, 1, y.err + y.out);
  assert.doesNotMatch(y.err, /same operator/);
  assert.match(y.err, /publishes no usable management endpoint.*nothing was sent/);
  const d = await r.pc.readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "get", args: [id] });
  assert.equal(d.runner.toLowerCase(), r.runner.toLowerCase(), "the lease is untouched");
  assert.equal(r.apiHits.length, 0, "the stand-in Enclave API was never called");
  assert.equal(fs.readFileSync(netLog, "utf8").trim(), "", "no non-loopback connection was attempted");
});
