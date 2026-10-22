// The address book is an on-chain governance root, not a hosted dependency.
// Resolve one complete map at an agreed block before changing any bindings.
import { QuorumError } from "./quorum.js";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO = /^0x0{40}$/i;
const REQUIRED = ["registry", "deployments", "appCatalog"];
const fail = (message) => { throw new QuorumError("Address book: " + message); };

export function decodeAddressBook(raw){
  if (typeof raw !== "string" || !/^0x(?:[0-9a-f]{64}){4,516}$/i.test(raw))
    fail("malformed all() response");
  const hex = raw.slice(2).toLowerCase();
  const word = (i) => hex.slice(i * 64, (i + 1) * 64);
  const number = (i) => {
    const n = BigInt("0x" + word(i));
    if (n > 16384n) fail("array offset or length is out of bounds");
    return Number(n);
  };
  // Solidity's all() returns two canonical, non-overlapping dynamic arrays.
  if (number(0) !== 64) fail("invalid key-array offset");
  const count = number(2);
  if (count > 256 || number(1) !== (3 + count) * 32 ||
      hex.length !== (4 + count * 2) * 64)
    fail("invalid array layout");
  if (number(3 + count) !== count) fail("key/value lengths differ");
  const entries = Object.create(null);
  for (let i = 0; i < count; i++){
    const bytes = word(3 + i).match(/../g).map(b => parseInt(b, 16));
    const end = bytes.indexOf(0);
    const nameBytes = end < 0 ? bytes : bytes.slice(0, end);
    if (!nameBytes.length || nameBytes.some(b => b < 33 || b > 126) ||
        (end >= 0 && bytes.slice(end).some(b => b !== 0)))
      fail("invalid ASCII key");
    const key = String.fromCharCode(...nameBytes);
    if (Object.hasOwn(entries, key)) fail("duplicate key " + key);
    const value = word(4 + count + i);
    if (!/^0{24}[0-9a-f]{40}$/.test(value)) fail("invalid address for " + key);
    // Keep explicit zero values: the caller must distinguish retirement from
    // an entry that has never existed. Never silently resurrect a retired key.
    entries[key] = "0x" + value.slice(24);
  }
  return Object.freeze(entries);
}

export async function readAddressBook(reader, address, snapshot){
  if (!ADDRESS.test(address || "") || ZERO.test(address)) fail("invalid root address");
  const snap = snapshot || await reader.snapshot();
  const [code, raw, ownerRaw] = await Promise.all([
    reader.code(snap, address),
    reader.call(snap, address, "0x10c4e8b0"), // all()
    reader.call(snap, address, "0x8da5cb5b"), // owner(); present in the original deployment
  ]);
  if (!code || code === "0x") fail("root has no code");
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(ownerRaw) || /^0x0{64}$/i.test(ownerRaw))
    fail("missing or malformed administrator");
  const entries = decodeAddressBook(raw);
  for (const key of REQUIRED){
    if (!entries[key] || ZERO.test(entries[key])) fail("required entry " + key + " is unset");
  }
  const codes = await Promise.all(REQUIRED.map(key => reader.code(snap, entries[key])));
  for (let i = 0; i < REQUIRED.length; i++){
    if (!codes[i] || codes[i] === "0x") fail(REQUIRED[i] + " has no code");
  }
  return Object.freeze({ address: address.toLowerCase(), owner: "0x" + ownerRaw.slice(-40).toLowerCase(),
    entries, snapshot: snap });
}
