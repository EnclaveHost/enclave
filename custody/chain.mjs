// Chain access for custodians (and the JS reference recipient): EnclaveSecretVault, the ledger and the registry, read through
// the vault's own address book.
//
// AGREEMENT. A custodian's release decision rests on chain state, so a single RPC that lies (or lags) must not be able to
// decide it. readRelease() reads the SAME block from every configured RPC (the lowest head among them, minus `confirmations`)
// and requires at least `minAgree` answers and all answers to be identical; anything else throws `chain_unconfirmed` (a 503
// to the caller: retry, never a pass). A single-RPC configuration must say minAgree: 1 explicitly (tests, a custodian
// running its own node).
import { createPublicClient, http, keccak256, toBytes, hexToBytes, bytesToHex, stringToHex, recoverMessageAddress } from "viem";

const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "key", type: "bytes32" }], outputs: [{ type: "address" }] }];
const MEMBER = { type: "tuple[]", components: [{ name: "operator", type: "address" }, { name: "encKey", type: "bytes32" }, { name: "endpoint", type: "string" }] };
export const VAULT_ABI = [
  { type: "function", name: "book", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }, { name: "policyRev", type: "uint64" }, { name: "secretRev", type: "uint64" }, { name: "committeeId", type: "bytes32" }, { name: "paused", type: "bool" }, { name: "rules", type: "bytes" }] },
  { type: "function", name: "bundleOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "secretRev", type: "uint64" }, { name: "epoch", type: "uint32" }, { name: "ciphertext", type: "bytes" }] },
  { type: "function", name: "sharesOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "secretRev", type: "uint64" }, { name: "epoch", type: "uint32" }],
    outputs: [{ name: "complete", type: "bool" }, { name: "source", type: "uint256" }, { name: "commitments", type: "bytes" }, { name: "sealedShares", type: "bytes[]" }] },
  { type: "function", name: "committeeOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }], outputs: [{ name: "creator", type: "address" }, { name: "epoch", type: "uint32" }] },
  { type: "function", name: "epochOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "epoch", type: "uint32" }],
    outputs: [{ name: "threshold", type: "uint8" }, { name: "activatedAt", type: "uint64" }, { name: "members", ...MEMBER }] },
  { type: "function", name: "beneficialOwnerOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "dealsOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "secretRev", type: "uint64" }, { name: "fromEpoch", type: "uint32" }, { name: "toEpoch", type: "uint32" }],
    outputs: [{ name: "bitmap", type: "uint256" }, { name: "deals", type: "bytes[]" }] },
  { type: "function", name: "resharePostsOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "secretRev", type: "uint64" }, { name: "toEpoch", type: "uint32" }, { name: "source", type: "uint256" }],
    outputs: [{ name: "posted", type: "uint8" }, { name: "commitments", type: "bytes" }, { name: "sealedShares", type: "bytes[]" }] },
  { type: "function", name: "sourceOf", stateMutability: "pure", inputs: [{ name: "fromEpoch", type: "uint32" }, { name: "bitmap", type: "uint32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "postDeal", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "toEpoch", type: "uint32" }, { name: "deal", type: "bytes" }], outputs: [] },
  { type: "function", name: "postReshare", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "toEpoch", type: "uint32" }, { name: "source", type: "uint256" }, { name: "commitments", type: "bytes" }, { name: "sealedShare", type: "bytes" }], outputs: [] },
];
const LEDGER_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" }, { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" },
  { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
// EnclaveRegistry.get, decoded as the SCHEMA-1 PREFIX only: later schemas APPENDED fields (prices, proof key, payout wallet,
// caps, region) and keep every earlier offset, so the prefix reads the same on every live registry, and operator + active
// are all a release needs. Decoding the full schema-5 tuple against an older registry misreads its tail and throws, which
// made every custodian refuse every release on Base (2026-10-14, the first hardware canary). relay/api-relay.js sniffs the
// schema for the fields it shows; this reader needs none of them.
export const REGISTRY_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" }] }] }];
const key = (s) => stringToHex(s, { size: 32 });   // ascii, right-padded (no Buffer: this module also runs in the browser)
export const BOOK_KEYS = { deployments: key("deployments"), registry: key("registry") };
export const endpointIdOf = (endpoint) => keccak256(toBytes(endpoint));   // EnclaveRegistry: id = keccak256(bytes(endpoint))

const ZERO = "0x0000000000000000000000000000000000000000";
const VERIFIER_MARK = Symbol.for("enclave.chain-authority.local-verifier");   // network/chain-authority.mjs VERIFIER_CLIENT
const b = (h) => hexToBytes(h === "0x" ? "0x" : h);
const err = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

// one RPC's view of everything a release decision needs, at one block
async function readOne(client, vault, { id, endpoint }, blockNumber) {
  const at = { blockNumber };
  const rd = (address, abi, functionName, args) => client.readContract({ address, abi, functionName, args, ...at });
  const [policy, bundle, bookAddr, beneficialOwner] = await Promise.all([
    rd(vault, VAULT_ABI, "policyOf", [id]), rd(vault, VAULT_ABI, "bundleOf", [id]), rd(vault, VAULT_ABI, "book", []), rd(vault, VAULT_ABI, "beneficialOwnerOf", [id])]);
  const [owner, policyRev, secretRev, committeeId, paused, rules] = policy;
  const [, epoch, ciphertext] = bundle;
  const [ledgerAddr, registryAddr] = await Promise.all([rd(bookAddr, BOOK_ABI, "addr", [BOOK_KEYS.deployments]), rd(bookAddr, BOOK_ABI, "addr", [BOOK_KEYS.registry])]);
  const epId = endpoint ? endpointIdOf(endpoint) : null;
  const [row, reg, shares, ep] = await Promise.all([
    ledgerAddr === ZERO ? null : rd(ledgerAddr, LEDGER_ABI, "get", [id]),
    !epId || registryAddr === ZERO ? null : rd(registryAddr, REGISTRY_ABI, "get", [epId]),
    epoch === 0 ? null : rd(vault, VAULT_ABI, "sharesOf", [id, secretRev, epoch]),
    epoch === 0 ? null : rd(vault, VAULT_ABI, "epochOf", [committeeId, epoch]),
  ]);
  const blk = await client.getBlock({ blockNumber });
  return {
    blockNumber: blk.number, blockTimestamp: Number(blk.timestamp),
    policy: { owner: owner.toLowerCase(), policyRev, secretRev, committeeId, paused, rules: b(rules) },
    bundle: { epoch, ciphertext: b(ciphertext) },
    shares: shares ? { complete: shares[0], source: shares[1], commitments: b(shares[2]), sealedShares: shares[3].map(b) } : null,
    committee: ep ? { threshold: ep[0], members: ep[2].map((m) => ({ operator: m.operator.toLowerCase(), encKey: b(m.encKey), endpoint: m.endpoint })) } : null,
    beneficialOwner: beneficialOwner.toLowerCase(),
    lease: row ? { owner: row.owner.toLowerCase(), runner: row.runner.toLowerCase(), leaseUntil: Number(row.leaseUntil), appRef: row.appRef, envelope: row.configCid } : null,
    endpointId: epId ? epId.toLowerCase() : null,
    endpointOperator: reg && reg.active ? reg.operator.toLowerCase() : null,
  };
}
const digest = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? `n${v}` : v instanceof Uint8Array ? `x${bytesToHex(v)}` : v));

// THE BLOCK. Every read is pinned to the HIGHEST head any RPC reports (minus `confirmations`), never the lowest: an RPC that
// lags (or claims to) cannot read that block and simply drops out of the agreement, where the lowest head would drag every
// honest RPC back to an old state on which they would then agree (a pause, a revoked image or an ended lease undone;
// review H1). `maxAgeSec`, when set, also refuses a block older than that against this machine's clock (custodians and the
// relay set it; owner tooling, whose stale reads only make the contract refuse its update, need not).
export function createChainReader({ rpcs, vault, minAgree, confirmations = 0, clients: given = null, timeoutMs = 10_000, maxAgeSec = null, now = () => Date.now() }) {
  const clients = given || (rpcs || []).map((url) => createPublicClient({ transport: http(url, { timeout: timeoutMs, retryCount: 1 }) }));
  if (!clients.length) throw new Error("chain: no RPC configured");
  if (!Number.isInteger(minAgree) || minAgree < 1 || minAgree > clients.length) throw new Error(`chain: minAgree must be 1..${clients.length} (state it explicitly)`);
  // the local verifier is ONE authority (custody/chain-source.mjs): never a vote among RPCs, never mixed with them
  if (clients.some((c) => !!c && !!c[VERIFIER_MARK]) && (clients.length !== 1 || minAgree !== 1 || (rpcs && rpcs.length)))
    throw new Error("chain: the local verifier is one chain authority: clients [verifier], minAgree 1, no RPC URLs");
  async function agreed(fn) {
    const heads = await Promise.allSettled(clients.map((c) => c.getBlockNumber({ cacheTime: 0 })));   // never a cached head: it would read a state older than the caller knows
    const ok = heads.filter((h) => h.status === "fulfilled").map((h) => h.value);
    if (ok.length < minAgree) throw err("chain_unconfirmed", `only ${ok.length} of ${clients.length} RPCs answered (need ${minAgree})`);
    const head = ok.reduce((a, x) => (x > a ? x : a)) - BigInt(confirmations);
    const reads = await Promise.allSettled(clients.map((c) => fn(c, head)));
    const got = reads.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (got.length < minAgree) throw err("chain_unconfirmed", `only ${got.length} RPCs could read block ${head} (need ${minAgree})`);
    const d0 = digest(got[0]);
    if (got.some((g) => digest(g) !== d0)) throw err("chain_unconfirmed", `RPCs disagree about block ${head}`);
    return got[0];
  }
  const fresh = (st) => {
    if (maxAgeSec != null && st.blockTimestamp < Math.floor(now() / 1000) - maxAgeSec)
      throw err("chain_stale", `the newest block the RPCs agree on is ${Math.floor(now() / 1000) - st.blockTimestamp} s old (limit ${maxAgeSec} s)`);
    return st;
  };
  return {
    vault,
    clients,
    readRelease: ({ id, endpoint }) => agreed((c, n) => readOne(c, vault, { id, endpoint }, n)).then(fresh),
    readState: ({ id }) => agreed((c, n) => readOne(c, vault, { id, endpoint: null }, n)).then(fresh),
    readEpoch: ({ committeeId, epoch }) => agreed(async (c, n) => {
      const r = await c.readContract({ address: vault, abi: VAULT_ABI, functionName: "epochOf", args: [committeeId, epoch], blockNumber: n });
      return { threshold: r[0], members: r[2].map((m) => ({ operator: m.operator.toLowerCase(), encKey: b(m.encKey), endpoint: m.endpoint })) };
    }),
    readCommittee: ({ committeeId }) => agreed(async (c, n) => {
      const r = await c.readContract({ address: vault, abi: VAULT_ABI, functionName: "committeeOf", args: [committeeId], blockNumber: n });
      return { creator: r[0].toLowerCase(), epoch: r[1] };
    }),
    readDeals: ({ id, secretRev, fromEpoch, toEpoch }) => agreed(async (c, n) => {
      const r = await c.readContract({ address: vault, abi: VAULT_ABI, functionName: "dealsOf", args: [id, secretRev, fromEpoch, toEpoch], blockNumber: n });
      return { bitmap: r[0], deals: r[1].map(b) };
    }),
  };
}

export const recoverOperator = async (message, signature) => {
  if (!/^0x[0-9a-fA-F]{130}$/.test(String(signature || ""))) return null;
  try { return (await recoverMessageAddress({ message, signature })).toLowerCase(); } catch { return null; }
};
