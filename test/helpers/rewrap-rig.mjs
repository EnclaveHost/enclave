// Rig pieces for the owner-authorized custody rewrap tests (test/custody-owner-rewrap.test.mjs):
//   - an ERC-1271 contract wallet (an owner key behind isValidSignature, like a passkey credit vault), compiled in a CHILD
//     process (as test/helpers/original-vault-rig.mjs) and cached by source digest;
//   - an HTTP front for a custodian with EXACTLY the original daemon's challenge/release handling
//     (test/fixtures/custodian-9d43e63/custody/v2/daemon.mjs: POST only, 256 KiB bound, Refusal -> { error, message });
//   - the synthetic SNP report for a guest with a chosen launch measurement and HOST_DATA (NOT hardware evidence).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { synthReport } from "./snp-synth.mjs";
import { resign } from "./custody-rig.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WALLET_1271 = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract RigWallet1271 {
  address public owner;
  constructor(address o) { owner = o; }
  function setOwner(address o) external { require(msg.sender == owner, "owner"); owner = o; }
  function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
    if (sig.length != 65) return 0xffffffff;
    bytes32 r = bytes32(sig[0:32]); bytes32 s = bytes32(sig[32:64]); uint8 v = uint8(sig[64]); if (v < 27) v += 27;
    return ecrecover(h, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
  }
}
`;
function compileNow() {
  const solc = createRequire(path.join(ROOT, "package.json"))("solc");
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "W.sol": { content: WALLET_1271 } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["W.sol"].RigWallet1271;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}
export function walletContract() {
  const cache = path.join(process.env.TMPDIR || os.tmpdir(), `enclave-rewrap-wallet-${createHash("sha256").update(WALLET_1271).digest("hex").slice(0, 16)}.json`);
  if (!fs.existsSync(cache)) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), cache], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) throw new Error(`wallet compile failed (${r.status ?? r.signal})`);
  }
  return JSON.parse(fs.readFileSync(cache, "utf8"));
}

/** the original daemon's challenge/release routes over real HTTP, for one custodian (old or current createCustodianV2) */
export async function custodianFront(custodian, { Refusal }) {
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"), client = String(req.socket.remoteAddress || "-");
    try {
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed", message: "POST only." });
      const chunks = []; let n = 0;
      for await (const ch of req) { n += ch.length; if (n > 262144) return json(res, 413, { error: "too_large", message: "Body too large." }); chunks.push(ch); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return json(res, 400, { error: "bad_json", message: "Body must be JSON." }); }
      if (u.pathname === "/v2/custody/challenge") return json(res, 200, custodian.challenge({ client }));
      if (u.pathname === "/v2/custody/release") return json(res, 200, await custodian.release(body));
      return json(res, 404, { error: "not_found", message: "Unknown custody route." });
    } catch (e) {
      if (e instanceof Refusal) return json(res, e.status, { error: e.code, message: e.message });
      return json(res, 422, { error: "refused", message: String(e.message).slice(0, 300) });
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

/** a synthetic SNP report source for a guest: report(reportData64) with this measurement (96 hex) and HOST_DATA (64 hex) */
export const syntheticReport = (S, { measurement, hostData }) => (reportData) =>
  resign(S, synthReport(S, { reportData: Buffer.from(reportData), hostData: Buffer.from(hostData, "hex") }), { measurement });

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  fs.writeFileSync(process.argv[2] + ".tmp", JSON.stringify(compileNow()));
  fs.renameSync(process.argv[2] + ".tmp", process.argv[2]);
}
