#!/usr/bin/env node
// Existing-contracts-first: can the deployed EnclaveAddressBook carry the site release (CID + sequence) instead of a
// new ReleaseAnchor? Read-only: one quorum-agreed block for the reads; eth_call / eth_estimateGas SIMULATIONS of the
// owner's setMany (nothing is signed or sent). The book maps bytes32 -> address (20 bytes), so a CIDv1/sha2-256
// (36 bytes) plus a sequence is split over three keys written together by setMany (atomic: one transaction, and a
// reader at one block hash sees all three from the same state).
//
//   node probe/book-evaluation.mjs [--out FILE]
import { readFileSync, writeFileSync } from "node:fs";
import { Quorum, rpcCall, viem } from "../lib/chain.mjs";
import { WORKSPACE_PROFILE } from "../lib/paths.mjs";

const argv = process.argv.slice(2);
const outFile = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
const profile = JSON.parse(readFileSync(WORKSPACE_PROFILE, "utf8"));
const BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";       // outputs/contract-change-audit/live.json
const OWNER = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";
const CI = "0x000000000000000000000000000000000000c1c1";           // a stand-in for a narrow CI key (never a real key)
const ABI = viem.parseAbi([
  "function owner() view returns (address)",
  "function addr(bytes32) view returns (address)",
  "function count() view returns (uint256)",
  "function all() view returns (bytes32[] keys_, address[] values)",
  "function set(bytes32 key, address value)",
  "function setMany(bytes32[] keys_, address[] values)",
]);
const CIDS = {
  currentIpns: "bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou",
  apexLogosFix: "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y",
};

const key = (s) => { if (s.length > 32) throw new Error("key over 32 bytes"); return viem.toHex(viem.toBytes(s, { size: 32 })); };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function b32decode(s) { let bits = 0, acc = 0; const out = []; for (const c of s) { acc = (acc << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } } return Uint8Array.from(out); }
function b32encode(b) { let bits = 0, acc = 0, out = ""; for (const x of b) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; } } if (bits) out += B32[(acc << (5 - bits)) & 31]; return out; }
/** CIDv1 dag-pb/raw sha2-256 (36 bytes) + seq -> three addresses; and back. */
function encode(cid, seq) {
  const b = b32decode(cid.slice(1));
  if (b.length !== 36 || b[0] !== 1 || b[2] !== 0x12 || b[3] !== 0x20) throw new Error("not a CIDv1 sha2-256");
  const d0 = viem.toHex(b.subarray(4, 24));                                   // digest bytes 0..20
  const d1 = viem.toHex(Uint8Array.from([...b.subarray(24, 36), ...b.subarray(0, 4), 0, 0, 0, 0])); // digest 20..32 + prefix
  const s = viem.toHex(BigInt(seq), { size: 20 });
  return [viem.getAddress(s), viem.getAddress(d0), viem.getAddress(d1)];
}
function decode([s, d0, d1]) {
  const a = viem.toBytes(d0), c = viem.toBytes(d1);
  const b = Uint8Array.from([...c.subarray(12, 16), ...a, ...c.subarray(0, 12)]);
  return { seq: Number(BigInt(s)), cid: "b" + b32encode(b) };
}

const q = new Quorum({ rpcs: profile.review.rpcHosts.map((h) => `https://${h}`), chainId: profile.chainId, quorum: 2, confirmations: 6 });
await q.block();
const code = await q.code(BOOK);
const owner = await q.read(BOOK, ABI, "owner");
const count = Number(await q.read(BOOK, ABI, "count"));
const [keys, values] = await q.read(BOOK, ABI, "all");
const read = q.close();
const sel = (sig) => viem.toFunctionSelector(sig).slice(2);
const out = {
  kind: "book-evaluation", read: { number: read.number, hash: read.hash, ageAtEndSecs: read.ageAtEndSecs, agreeing: read.agreeing },
  book: { address: BOOK, codeHash: viem.keccak256(code), runtimeBytes: (code.length - 2) / 2, owner, count,
    entries: Object.fromEntries(keys.map((k, i) => [viem.hexToString(k, { size: 32 }).replace(/\0+$/, ""), values[i]])),
    selectorsInRuntime: Object.fromEntries(["set(bytes32,address)", "setMany(bytes32[],address[])", "addr(bytes32)", "all()", "owner()",
      "pendingOwner()", "setOwner(address)", "acceptOwnership()"].map((s) => [s, code.includes(sel(s))])) },
};
out.encoding = Object.fromEntries(Object.entries(CIDS).map(([k, cid]) => {
  const vals = encode(cid, 1_000_001);
  return [k, { cid, values: vals, roundTrip: decode(vals).cid === cid && decode(vals).seq === 1_000_001 }];
}));
const keys3 = ["ipns.d9798e4c.seq", "ipns.d9798e4c.d0", "ipns.d9798e4c.d1"].map(key);
const data = viem.encodeFunctionData({ abi: ABI, functionName: "setMany", args: [keys3, encode(CIDS.currentIpns, 1_000_001)] });
out.simulation = {};
for (const [who, from] of [["owner (platform governance EOA)", OWNER], ["a narrow CI key", CI]]) {
  const rpc = `https://${profile.review.rpcHosts[2]}`;
  const call = await rpcCall(rpc, "eth_call", [{ from, to: BOOK, data }, "latest"]);
  const est = await rpcCall(rpc, "eth_estimateGas", [{ from, to: BOOK, data }]);
  out.simulation[who] = { from, eth_call: call.ok ? "ok" : call.error, estimateGas: est.ok ? Number(BigInt(est.result)) : est.error };
}
out.finding = {
  ownerSignedReleaseWithoutNewContract: out.simulation["owner (platform governance EOA)"].eth_call === "ok" && Object.values(out.encoding).every((e) => e.roundTrip),
  narrowCiDelegationPossible: false,
  why: "set/setMany require msg.sender == owner; the book has exactly one writer (the platform governance EOA that also repoints registry, ledger and catalog). It has no per-key writer, expiry or compare-and-swap, so a CI key could write a release only by holding the governance key itself.",
};
if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
