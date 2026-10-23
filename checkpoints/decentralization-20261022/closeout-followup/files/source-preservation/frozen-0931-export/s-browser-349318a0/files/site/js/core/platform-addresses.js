// Serverless platform governance: follow the explicitly selected on-chain book
// through agreeing RPC reads. No hosted API, retained authority cache, or
// mutation of the saved profile's trust root.
import { INDEPENDENT, ADDRESS_BOOK_ADDRESS, __applyAddresses, profileGuardedRpc, assertProfileCurrent } from "./config.js";
import { createQuorumReader, QuorumError, jsonRpc } from "./quorum.js";
import { readAddressBook } from "./addressbook-reader.js";
import { emit } from "./util.js";

export const platformBookEnabled = INDEPENDENT.state === "on" && !!INDEPENDENT.profile.addressBook;
let _reader, _last, _active = new Set();
const retired = new Set();
// ledgers among the retired targets: an admin migration leaves owners' records (and funds) on the old ledger
const retiredLedgerSet = new Set();
const ZERO = /^0x0{40}$/i;
// Every ledger the book has named for "deployments": the profile's list (complete through its block `through`, found by
// the profile's generator in the book's own history with every RPC agreeing; covered by the profile's fingerprint), then
// what scanLedgerHistory() reads from the book after that block. Independent of how long any tab has been open.
const historySet = new Set((platformBookEnabled && INDEPENDENT.profile.ledgerHistory?.ledgers) || []);
let historySynced = platformBookEnabled && INDEPENDENT.profile.ledgerHistory ? INDEPENDENT.profile.ledgerHistory.through : null;

export function platformBookReader(){
  if (!platformBookEnabled) return null;
  const p = INDEPENDENT.profile;
  return _reader ||= createQuorumReader({rpcs:[...p.rpcs],quorum:p.quorum,confirmations:p.confirmations,
    maxBlockAgeSeconds:p.maxBlockAgeSeconds,chainId:p.chainId,rpc:profileGuardedRpc(jsonRpc())});
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
    if (before[key] && result.entries[key] && before[key].toLowerCase() !== result.entries[key].toLowerCase()){
      retired.add(before[key].toLowerCase());
      if (key === "deployments") retiredLedgerSet.add(before[key].toLowerCase());
    }
  }
  const active = new Set(Object.values(result.entries).filter(a => !ZERO.test(a)).map(a => a.toLowerCase()));
  for (const address of historySet) if (!active.has(address)){ retired.add(address); retiredLedgerSet.add(address); }
  for (const address of active){ retired.delete(address); retiredLedgerSet.delete(address); }
  _active = active;
  // Optional zero entries disable a service. Missing entries leave explicitly
  // selected services alone (the original book has no session factory entry).
  const map = Object.fromEntries(Object.entries(result.entries).map(([k,v])=>[k,ZERO.test(v) ? "" : v]));
  const changed = __applyAddresses(map);
  _last = result;
  if (changed.length && typeof document !== "undefined")
    emit("enclave:addresses", {changed,book:result.entries,owner:result.owner});
  return {...result, changed};
}

/* Ledgers the administrator replaced: the profile's initial ledger when the book now names another, the profile's
   ledger history, what scanLedgerHistory() found after it, and any replaced while this tab was open - never one the book
   names now. Owners' records and escrow stay on them. */
export const retiredLedgers = () => [...retiredLedgerSet].filter((a) => !_active.has(a));

// keccak256("AddressSet(bytes32,address)") and the "deployments" key (EnclaveAddressBook.sol), checked by the unit tests
const SET_TOPIC = "0xb37614c7d254ea8d16eb81fa11dddaeb266aa8ba4917980859c7740aff30c691";
const KEY_DEPLOYMENTS = "0x6465706c6f796d656e7473000000000000000000000000000000000000000000";
export const HISTORY_SPAN = 2000, HISTORY_CHUNKS_PER_CALL = 40;   // public RPCs cap eth_getLogs ranges

/* Bring the ledger history from the profile's `through` up to `snap`: the book's own AddressSet("deployments", …) events,
   at most HISTORY_CHUNKS_PER_CALL ranges per call, each needing `quorum` RPCs to return the identical log set. A later
   call continues where this one stopped (tab memory only; never stored). Only addresses the book itself set are added,
   and their records are read only after ledger code and selectors check out (independent-chain retiredLedgerRecords).
   -> { complete, through, head, reason? } */
export async function scanLedgerHistory(snap, reader = platformBookReader()){
  if (!platformBookEnabled || historySynced == null)
    return { complete: false, through: null, head: snap.number, reason: "this network profile records no ledger history" };
  for (let chunks = 0; historySynced < snap.number; chunks++){
    if (chunks >= HISTORY_CHUNKS_PER_CALL)
      return { complete: false, through: historySynced, head: snap.number,
        reason: "the address book's history is checked through block " + historySynced + " of " + snap.number + "; the next refresh continues" };
    const from = historySynced + 1, to = Math.min(snap.number, from + HISTORY_SPAN - 1);
    for (const l of await reader.logs(snap, { address: ADDRESS_BOOK_ADDRESS, topics: [SET_TOPIC, KEY_DEPLOYMENTS], fromBlock: from, toBlock: to })){
      if (l.topics.length !== 2 || l.topics[0] !== SET_TOPIC || l.topics[1] !== KEY_DEPLOYMENTS || !/^0x0{24}[0-9a-f]{40}$/.test(l.data))
        throw new QuorumError("Address book: malformed AddressSet record in block " + l.blockNumber);
      const address = "0x" + l.data.slice(26);
      if (ZERO.test(address)) continue;
      historySet.add(address);
      if (_active.size && !_active.has(address)){ retired.add(address); retiredLedgerSet.add(address); }
    }
    historySynced = to;
  }
  return { complete: true, through: historySynced, head: snap.number };
}

/* The two calls an owner (or, once the ledger itself is retired, anyone) still makes on a replaced ledger to get funds
   home: refund(id), which always pays the record's OWNER, and suspend (setActive(id, false)). Nothing that creates,
   funds, approves or reconfigures. */
const SEL_REFUND = "0x7249fbb6", SEL_SET_ACTIVE = "0x6485d678";
export function isLedgerRecoveryCall(data){
  const d = String(data || "").toLowerCase();
  if (d.startsWith(SEL_REFUND) && /^0x7249fbb6[0-9a-f]{64}$/.test(d)) return true;
  return d.startsWith(SEL_SET_ACTIVE) && /^0x6485d678[0-9a-f]{64}0{64}$/.test(d);
}

// A freshly prepared operation may proceed only while governance resolution is
// available. Do not silently retarget calldata prepared for a retired contract;
// recovery calls to a replaced ledger stay possible (isLedgerRecoveryCall).
export async function assertPlatformTransactionCurrent(to, data = "0x"){
  // every transaction path asks here first, in either mode: a tab whose profile changed elsewhere sends nothing
  try { assertProfileCurrent(); } catch(e){ throw new QuorumError(e.message); }
  if (!platformBookEnabled) return;
  const result = await resolvePlatformAddresses();
  if (result.changed.length)
    throw new QuorumError("Platform contract addresses changed. Review and prepare the operation again.");
  const targets = [String(to || "").toLowerCase()];
  // ERC-20 approve carries the actual spending contract in its first argument.
  if (/^0x095ea7b30{24}[0-9a-f]{40}[0-9a-f]{64}$/i.test(data))
    targets.push("0x" + data.slice(34,74).toLowerCase());
  const recovery = targets.length === 1 && retiredLedgerSet.has(targets[0]) && isLedgerRecoveryCall(data);
  if (!recovery && targets.some(a => retired.has(a)))
    throw new QuorumError("This operation targets a retired platform contract. Prepare it again.");
}
