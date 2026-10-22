// The reviewed ReleaseAnchor build (frozen: work/ipns-release-anchor/out) as a deterministic CREATE2 deployment, and
// the IPNS name -> nameHash derivation from the PUBLIC name (no key needed).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { viem } from "./chain.mjs";
import { ANCHOR } from "./paths.mjs";

export const ANCHOR_DIR = ANCHOR;
const ARTIFACT = join(ANCHOR_DIR, "out/ReleaseAnchor.sol/ReleaseAnchor.json");
const SOURCE = join(ANCHOR_DIR, "src/ReleaseAnchor.sol");
// the hashes the frozen candidate was tested and reported at (work/claude-ipns-anchor-result.md)
export const REVIEWED = {
  sourceSha256: "50f9710f8166e89f762d03eb869a06c303e5af8c270e2b975fafffc11776012c",
  artifactSha256: "f592eb23ad60d6b21b7a449b350f4d987f828237ba2cf5d941631b307a56d3b2",
};
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
function varint(buf, i) {
  let v = 0, s = 0;
  for (;;) { const b = buf[i++]; if (b === undefined) throw new Error("truncated varint"); v += (b & 0x7f) * 2 ** s; s += 7; if (!(b & 0x80)) return [v, i]; }
}
/** k51… (CIDv1, libp2p-key, base36) -> the identity multihash bytes of the public key (the "peer multihash"). */
export function peerMultihash(name) {
  if (!/^k[0-9a-z]+$/.test(name)) throw new Error("expected a base36 (k…) IPNS name");
  let n = 0n;
  for (const c of name.slice(1)) n = n * 36n + BigInt(B36.indexOf(c));
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  let [version, i] = varint(bytes, 0);
  let codec;
  [codec, i] = varint(bytes, i);
  if (version !== 1 || codec !== 0x72) throw new Error("not a CIDv1 libp2p-key");
  const mh = bytes.subarray(i);
  const [code, j] = varint(mh, 0);
  const [len, k] = varint(mh, j);
  if (code !== 0x00 || len !== mh.length - k) throw new Error("not an identity multihash");
  return mh;
}
export const nameHash = (name) => viem.keccak256(peerMultihash(name));

/** The frozen artifact, refused unless it is byte-identical to the reviewed one. */
export function artifact() {
  const raw = readFileSync(ARTIFACT);
  const src = readFileSync(SOURCE);
  if (sha256(raw) !== REVIEWED.artifactSha256 || sha256(src) !== REVIEWED.sourceSha256)
    throw new Error("work/ipns-release-anchor out/ or src/ differs from the reviewed build");
  return JSON.parse(raw);
}

const CTOR = [{ type: "address" }, { type: "bytes32" }, { type: "string" }];
export const ANCHOR_ABI = viem.parseAbi([
  "function state() view returns (bytes32 schema, bytes32 nameHash, uint64 seq, string cid, address owner, address delegate, uint64 delegateUntil, bool retired, address successor)",
  "function publish(string cid, uint64 expectedSeq)",
  "function pin(string cid)",
  "function setDelegate(address d, uint64 until)",
  "function retire(address successor)",
]);

/** Everything about one anchor deployment, computed offline. */
export function anchorDeployment({ deployer, salt, owner, nameHash: nh, cid }) {
  const art = artifact();
  const initcode = viem.concat([art.bytecode.object, viem.encodeAbiParameters(CTOR, [owner, nh, cid])]);
  const address = viem.getContractAddress({ opcode: "CREATE2", from: deployer, salt, bytecode: initcode });
  const runtime = Buffer.from(art.deployedBytecode.object.slice(2), "hex");
  const refs = Object.values(art.deployedBytecode.immutableReferences);
  if (refs.length !== 1) throw new Error("expected exactly one immutable");
  for (const { start } of refs[0]) Buffer.from(nh.slice(2), "hex").copy(runtime, start);
  return {
    address, salt, initcode, initcodeHash: viem.keccak256(initcode),
    deployCalldata: viem.concat([salt, initcode]),
    runtimeHex: "0x" + runtime.toString("hex"), codeHash: viem.keccak256(runtime), runtimeBytes: runtime.length,
    build: { ...REVIEWED, compiler: art.metadata?.compiler?.version ?? null },
  };
}
