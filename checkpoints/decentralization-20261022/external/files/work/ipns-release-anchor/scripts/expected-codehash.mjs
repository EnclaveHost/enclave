#!/usr/bin/env node
// The ReleaseAnchor runtime codehash to pin in the publisher's `releaseAnchor.codeHash`, derived from the reviewed
// build (out/), never from a chain: the deployed runtime is the compiled runtime with the one immutable (nameHash)
// filled in. Also scans the runtime for opcodes the contract must not contain (calls, creates, selfdestruct).
//
//   node scripts/expected-codehash.mjs 0x<nameHash>        (nameHash: `ipns-publisher id <key>` prints it)
//   node scripts/expected-codehash.mjs 0x<nameHash> --code 0x<runtime from eth_getCode>   (also compare)
//
// keccak256 comes from foundry's `cast keccak` (the same toolchain that built out/).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = { 0xf0: "CREATE", 0xf1: "CALL", 0xf2: "CALLCODE", 0xf4: "DELEGATECALL", 0xf5: "CREATE2", 0xfa: "STATICCALL", 0xff: "SELFDESTRUCT" };

export function expectedRuntime(nameHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(nameHash) || /^0x0{64}$/.test(nameHash)) throw new Error("nameHash must be a nonzero 32-byte 0x hex");
  const artifactPath = join(root, "out/ReleaseAnchor.sol/ReleaseAnchor.json");
  const artifactRaw = readFileSync(artifactPath);
  const art = JSON.parse(artifactRaw);
  const code = Buffer.from(art.deployedBytecode.object.replace(/^0x/, ""), "hex");
  const refs = Object.values(art.deployedBytecode.immutableReferences ?? {});
  if (refs.length !== 1) throw new Error(`expected exactly one immutable (nameHash), found ${refs.length}`);
  const value = Buffer.from(nameHash.slice(2), "hex");
  for (const { start, length } of refs[0]) {
    if (length !== 32) throw new Error("immutable reference is not 32 bytes");
    value.copy(code, start);
  }
  return {
    runtime: code,
    artifactSha256: createHash("sha256").update(artifactRaw).digest("hex"),
    sourceSha256: createHash("sha256").update(readFileSync(join(root, "src/ReleaseAnchor.sol"))).digest("hex"),
    compiler: art.metadata?.compiler?.version ?? null,
  };
}

export function forbiddenOpcodes(code) {
  const found = [];
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) { i += op - 0x5f; continue; } // PUSH1..PUSH32 data
    if (FORBIDDEN[op]) found.push(`${FORBIDDEN[op]}@${i}`);
  }
  return found;
}

export function keccakHex(buf) {
  return execFileSync("cast", ["keccak", "0x" + Buffer.from(buf).toString("hex")], { encoding: "utf8" }).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [nameHash, flag, onchain] = process.argv.slice(2);
  const r = expectedRuntime(nameHash);
  const out = {
    codeHash: keccakHex(r.runtime),
    runtimeBytes: r.runtime.length,
    forbiddenOpcodes: forbiddenOpcodes(r.runtime),
    artifactSha256: r.artifactSha256,
    sourceSha256: r.sourceSha256,
    compiler: r.compiler,
  };
  if (flag === "--code") out.matchesOnchain = onchain.toLowerCase() === "0x" + r.runtime.toString("hex");
  console.log(JSON.stringify(out, null, 2));
  if (out.forbiddenOpcodes.length || out.matchesOnchain === false) process.exit(1);
}
