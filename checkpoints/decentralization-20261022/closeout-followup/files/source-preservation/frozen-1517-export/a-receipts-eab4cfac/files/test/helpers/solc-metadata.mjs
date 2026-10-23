// solc's trailing CBOR metadata on a runtime: { ipfs: <34-byte multihash>, solc: <major, minor, patch> } followed by its
// 2-byte length. Split it off a compiled runtime, or rebuild the exact bytes a deployed contract carries from its
// published metadata hash (contracts/deployments/source-verification-base.json metadataIpfs) and compiler version.
export function splitCborMetadata(runtimeHex) {
  const b = Buffer.from(String(runtimeHex).replace(/^0x/, ""), "hex"), n = b.readUInt16BE(b.length - 2);
  if (n + 2 > b.length) throw new Error("no CBOR metadata length");
  return { code: b.subarray(0, b.length - 2 - n), tail: b.subarray(b.length - 2 - n) };
}
export function solcCborMetadata(ipfsMultihashHex, compilerVersion) {
  const ipfs = Buffer.from(String(ipfsMultihashHex).replace(/^0x/, ""), "hex");
  if (ipfs.length !== 34) throw new Error("metadataIpfs must be a 34-byte multihash");
  const [maj, min, pat] = /^(\d+)\.(\d+)\.(\d+)/.exec(compilerVersion).slice(1).map(Number);
  const body = Buffer.concat([Buffer.from([0xa2, 0x64]), Buffer.from("ipfs"), Buffer.from([0x58, 0x22]), ipfs, Buffer.from([0x64]), Buffer.from("solc"), Buffer.from([0x43, maj, min, pat])]);
  const len = Buffer.alloc(2); len.writeUInt16BE(body.length);
  return Buffer.concat([body, len]);
}
