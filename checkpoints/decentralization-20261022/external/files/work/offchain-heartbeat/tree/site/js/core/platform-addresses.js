// Serverless platform governance: follow the explicitly selected on-chain book
// through agreeing RPC reads. No hosted API, retained authority cache, or
// mutation of the saved profile's trust root.
import { INDEPENDENT, ADDRESS_BOOK_ADDRESS, __applyAddresses } from "./config.js";
import { createQuorumReader, QuorumError } from "./quorum.js";
import { readAddressBook } from "./addressbook-reader.js";
import { emit } from "./util.js";

export const platformBookEnabled = INDEPENDENT.state === "on" && !!INDEPENDENT.profile.addressBook;
let _reader, _last;
const retired = new Set();
const ZERO = /^0x0{40}$/i;

export function platformBookReader(){
  if (!platformBookEnabled) return null;
  const p = INDEPENDENT.profile;
  return _reader ||= createQuorumReader({rpcs:[...p.rpcs],quorum:p.quorum,confirmations:p.confirmations,
    maxBlockAgeSeconds:p.maxBlockAgeSeconds,chainId:p.chainId});
}

export async function resolvePlatformAddresses({ reader = platformBookReader(), snapshot } = {}){
  if (!platformBookEnabled) return null;
  const result = await readAddressBook(reader, ADDRESS_BOOK_ADDRESS, snapshot);
  if (_last && (result.snapshot.number < _last.snapshot.number ||
      (result.snapshot.number === _last.snapshot.number && result.snapshot.hash !== _last.snapshot.hash)))
    throw new QuorumError("The address-book read is older than, or conflicts with, this tab's verified state. Retry.");
  // Retain old targets to refuse calldata prepared before a background refresh.
  const before = _last?.entries || INDEPENDENT.profile.contracts;
  for (const key of ["deployments", "appCatalog", "registry", "paymentRouter", "featured", "reviews", "hostReviews", "secretVault"]){
    if (before[key] && result.entries[key] && before[key] !== result.entries[key]) retired.add(before[key].toLowerCase());
  }
  const active = new Set(Object.values(result.entries).filter(a => !ZERO.test(a)));
  for (const address of active) retired.delete(address);
  // Optional zero entries disable a service. Missing entries leave explicitly
  // selected services alone (the original book has no session factory entry).
  const map = Object.fromEntries(Object.entries(result.entries).map(([k,v])=>[k,ZERO.test(v) ? "" : v]));
  const changed = __applyAddresses(map);
  _last = result;
  if (changed.length && typeof document !== "undefined")
    emit("enclave:addresses", {changed,book:result.entries,owner:result.owner});
  return {...result, changed};
}

// A freshly prepared operation may proceed only while governance resolution is
// available. Do not silently retarget calldata prepared for a retired contract.
export async function assertPlatformTransactionCurrent(to, data = "0x"){
  if (!platformBookEnabled) return;
  const result = await resolvePlatformAddresses();
  if (result.changed.length)
    throw new QuorumError("Platform contract addresses changed. Review and prepare the operation again.");
  const targets = [String(to || "").toLowerCase()];
  // ERC-20 approve carries the actual spending contract in its first argument.
  if (/^0x095ea7b30{24}[0-9a-f]{40}[0-9a-f]{64}$/i.test(data))
    targets.push("0x" + data.slice(34,74).toLowerCase());
  if (targets.some(a => retired.has(a)))
    throw new QuorumError("This operation targets a retired platform contract. Prepare it again.");
}
