// TEST SUPPORT: a minimal ERC-1271 contract owner (a contract wallet whose isValidSignature accepts its EOA signer's raw
// signature over the 32-byte digest, low-s only), compiled with solc-js once and cached by source hash in TMPDIR.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const ERC1271_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract RigSigner1271 {
  address public immutable signer;
  constructor(address s) { signer = s; }
  function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
    if (sig.length != 65) return 0xffffffff;
    bytes32 r = bytes32(sig[0:32]); bytes32 s = bytes32(sig[32:64]); uint8 v = uint8(sig[64]);
    if (v < 27) v += 27;
    if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return 0xffffffff;
    address got = ecrecover(h, v, r, s);
    return got != address(0) && got == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
  }
}
`;
export function erc1271Artifact() {
  const key = createHash("sha256").update(ERC1271_SOURCE).digest("hex").slice(0, 16);
  const cache = path.join(process.env.TMPDIR || "/tmp", `enclave-rig-erc1271-${key}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const out = JSON.parse(require("solc").compile(JSON.stringify({ language: "Solidity", sources: { "S.sol": { content: ERC1271_SOURCE } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["S.sol"].RigSigner1271, r = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  fs.writeFileSync(cache, JSON.stringify(r));
  return r;
}
