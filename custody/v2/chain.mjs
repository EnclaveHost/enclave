// Custody reads use a fresh majority-agreed block hash. The vault's authorities are either immutable (vaultKind "pinned",
// the alternate 0x56b8 release) or, for the deployed production vault 0xE486 (vaultKind "book"), the administrator's
// EnclaveAddressBook entries AT THAT SAME BLOCK, which is exactly what the vault itself consults there. The kind is a
// measured/configured pin, never inferred from a revert: an RPC error cannot switch a reader between the two.
import { createPublicClient, http, keccak256, toBytes, hexToBytes, stringToHex, encodeFunctionData, decodeFunctionResult } from "viem";
import { createQuorumReader, checkRpcUrls } from "./quorum.mjs";
import { readPolicyFacts } from "../../network/platform-host-policy.mjs";

export const MACHINE = [
  { name: "identity", type: "address" }, { name: "encKey", type: "bytes32" }, { name: "endpoint", type: "string" },
  { name: "chipId", type: "bytes32" }, { name: "registryId", type: "bytes32" }, { name: "measurement", type: "bytes32" },
];
const M_ARR = { type: "tuple[]", components: MACHINE };
export const HOST_OWNERSHIP_ABI = [
  { type: "function", name: "authority", stateMutability: "view", inputs: [{type:"bytes32"}], outputs: [{type:"address"},{type:"address"},{type:"uint64"},{type:"bytes32"}] },
  { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{type:"address"}] },
];
export const BOOK_ABI = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "key", type: "bytes32" }], outputs: [{ type: "address" }] }];
export const VAULT_KINDS = Object.freeze(["pinned", "book"]);
export const VAULT_V2_ABI = [
  { type: "function", name: "hostOwnership", stateMutability: "view", inputs: [], outputs: [{type:"address"}] },
  { type: "function", name: "hostRegistry", stateMutability: "view", inputs: [], outputs: [{type:"address"}] },
  { type: "function", name: "deploymentLedger", stateMutability: "view", inputs: [], outputs: [{type:"address"}] },
  { type: "function", name: "sessionVaultFactory", stateMutability: "view", inputs: [], outputs: [{type:"address"}] },
  { type: "function", name: "book", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "enclaveOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "owner", type: "address" }, { name: "policyRev", type: "uint64" }, { name: "secretRev", type: "uint64" }, { name: "committeeId", type: "bytes32" }, { name: "paused", type: "bool" }, { name: "rules", type: "bytes" }] },
  { type: "function", name: "bundleOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "committeeId", type: "bytes32" }, { name: "secretRev", type: "uint64" }, { name: "bundle", type: "bytes" }] },
  { type: "function", name: "beneficialOwnerOf", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "committeeOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }],
    outputs: [{ name: "Y", type: "bytes" }, { name: "epoch", type: "uint32" }, { name: "t", type: "uint8" }, { name: "W", type: "uint8" }, { name: "activatedAt", type: "uint64" }] },
  { type: "function", name: "machinesOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "epoch", type: "uint32" }],
    outputs: [{ name: "machines", ...M_ARR }, { name: "enclave", type: "bool[]" }] },
  { type: "function", name: "commitmentsOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "epoch", type: "uint32" }], outputs: [{ type: "bytes" }] },
  { type: "function", name: "pendingOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }],
    outputs: [{ name: "toEpoch", type: "uint32" }, { name: "next", ...M_ARR }, { name: "enclave", type: "bool[]" }, { name: "t", type: "uint8" }, { name: "W", type: "uint8" }, { name: "dealers", type: "uint32[]" }, { name: "expires", type: "uint64" }] },
  { type: "function", name: "dealOf", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "toEpoch", type: "uint32" }, { name: "dealerIndex", type: "uint32" }],
    outputs: [{ name: "dealCommitments", type: "bytes" }, { name: "sealed", type: "bytes[]" }] },
  { type: "function", name: "ackCount", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "toEpoch", type: "uint32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "codeActiveAt", stateMutability: "view", inputs: [{ name: "cid", type: "bytes32" }, { name: "measurement", type: "bytes32" }], outputs: [{ type: "uint64" }] },
  // writes (custodians sign; any funded account submits)
  { type: "function", name: "createIndependentCommittee", stateMutability: "nonpayable",
    inputs: [{ name: "salt", type: "bytes32" }, { name: "machines", ...M_ARR }, { name: "commitments", type: "bytes" },
      { name: "codeSet", type: "bytes32[]" }, { name: "identitySigs", type: "bytes[]" }, { name: "hostSigs", type: "bytes[]" }],
    outputs: [{ name: "committeeId", type: "bytes32" }] },
  { type: "function", name: "createCommittee", stateMutability: "nonpayable",
    inputs: [{ name: "salt", type: "bytes32" }, { name: "m", type: "tuple", components: MACHINE }, { name: "Y", type: "bytes" }, { name: "codeSet", type: "bytes32[]" }, { name: "identitySig", type: "bytes" }, { name: "hostSig", type: "bytes" }],
    outputs: [{ name: "committeeId", type: "bytes32" }] },
  { type: "function", name: "proposeHandover", stateMutability: "nonpayable",
    inputs: [{ name: "cid", type: "bytes32" }, { name: "next", ...M_ARR }, { name: "hostSigs", type: "bytes[]" }, { name: "dealerIndices", type: "uint32[]" }, { name: "approvers", type: "address[]" }, { name: "approvals", type: "bytes[]" }], outputs: [] },
  { type: "function", name: "postDeal", stateMutability: "nonpayable",
    inputs: [{ name: "cid", type: "bytes32" }, { name: "toEpoch", type: "uint32" }, { name: "dealerIndex", type: "uint32" }, { name: "dealCommitments", type: "bytes" }, { name: "sealed", type: "bytes[]" }, { name: "dealer", type: "address" }, { name: "sig", type: "bytes" }], outputs: [] },
  { type: "function", name: "ackHandover", stateMutability: "nonpayable",
    inputs: [{ name: "cid", type: "bytes32" }, { name: "toEpoch", type: "uint32" }, { name: "newCommitments", type: "bytes" }, { name: "machine", type: "address" }, { name: "sig", type: "bytes" }], outputs: [] },
  { type: "function", name: "proposeCode", stateMutability: "nonpayable",
    inputs: [{ name: "cid", type: "bytes32" }, { name: "measurement", type: "bytes32" }, { name: "approvers", type: "address[]" }, { name: "approvals", type: "bytes[]" }], outputs: [] },
  { type: "function", name: "removeCode", stateMutability: "nonpayable",
    inputs: [{ name: "cid", type: "bytes32" }, { name: "measurement", type: "bytes32" }, { name: "approvers", type: "address[]" }, { name: "approvals", type: "bytes[]" }], outputs: [] },
];
export const LEDGER_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" }, { name: "configCid", type: "string" },
  { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" }, { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" },
  { name: "rate", type: "uint256" }, { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" },
  { name: "runner", type: "bytes32" }, { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
// EnclaveRegistry.get, the schema-4 PREFIX (appended fields keep offsets): operator, active and the self-set payoutWallet
export const REGISTRY_V4_ABI = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" },
  { name: "cpuPricePerSec6", type: "uint64" }, { name: "gpuPricePerSec6", type: "uint64" }, { name: "proofKey", type: "address" }, { name: "payoutWallet", type: "address" }] }] }];
export const ERC1271_ABI = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ type: "bytes4" }] }];
const ERC1271_MAGIC = "0x1626ba7e";
const MAX_AUTH_HOSTS = 160, MAX_AUTH_CHECKS = 512;
const key = (s) => stringToHex(s, { size: 32 });
export const BOOK_KEYS = { deployments: key("deployments"), registry: key("registry") };
export const endpointIdOf = (endpoint) => keccak256(toBytes(endpoint));
const ZERO = "0x0000000000000000000000000000000000000000";
const b = (h) => hexToBytes(h === "0x" ? "0x" : h);
const err = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const lc = (a) => String(a).toLowerCase();
const machineOut = (m) => ({ identity: lc(m.identity), encKey: lc(m.encKey), endpoint: m.endpoint, chipId: lc(m.chipId), registryId: lc(m.registryId), measurement: lc(m.measurement) });

async function readCommitteeAt(rd, vault, cid) {
  const [Y, epoch, t, W, activatedAt] = await rd(vault, VAULT_V2_ABI, "committeeOf", [cid]);
  if (!epoch) return null;
  const [[machines, enclave], commitments] = await Promise.all([rd(vault, VAULT_V2_ABI, "machinesOf", [cid, epoch]), rd(vault, VAULT_V2_ABI, "commitmentsOf", [cid, epoch])]);
  return { committeeId: lc(cid), Y: b(Y), epoch: Number(epoch), t: Number(t), W: Number(W), activatedAt: Number(activatedAt),
           machines: machines.map((m, i) => ({ ...machineOut(m), enclave: enclave[i] })), commitments: b(commitments) };
}

// No number-only fallback: every eth_call must name this canonical hash.
const rdOf = (client, block) => async (address, abi, functionName, args = []) => {
  const data=encodeFunctionData({abi,functionName,args});
  const result=await client.request({method:'eth_call',params:[{to:address,data},{blockHash:block.blockHash,requireCanonical:true}]});
  return decodeFunctionResult({abi,functionName,data:result});
};

// book mode: the vault's book (optionally checked against a pin) and its deployments/registry entries at this block
async function bookAuthoritiesAt(rd, vault, bookPin) {
  const book = await rd(vault, VAULT_V2_ABI, "book");
  if (bookPin && lc(book) !== lc(bookPin)) throw err("book_mismatch", "vault address book differs from the configured pin");
  const [ledger, registry] = await Promise.all([rd(book, BOOK_ABI, "addr", [BOOK_KEYS.deployments]), rd(book, BOOK_ABI, "addr", [BOOK_KEYS.registry])]);
  return { book: lc(book), ledger, registry };
}
// the release authorities for one block: the pinned immutables, or the book entries the book-bound vault reads there
async function releaseAuthoritiesAt(rd, vault, auth) {
  if (auth.kind === "book") { const a = await bookAuthoritiesAt(rd, vault, auth.book); return [a.ledger, a.registry]; }
  return Promise.all([rd(vault, VAULT_V2_ABI, "deploymentLedger"), rd(vault, VAULT_V2_ABI, "hostRegistry")]);
}

async function readReleaseAt(client, vault, { id, endpoint }, block, auth) {
  const rd = rdOf(client,block);
  const [policy, bundle, [ledgerAddr, registryAddr], beneficialOwner] = await Promise.all([
    rd(vault, VAULT_V2_ABI, "policyOf", [id]), rd(vault, VAULT_V2_ABI, "bundleOf", [id]),
    releaseAuthoritiesAt(rd, vault, auth),
    rd(vault, VAULT_V2_ABI, "beneficialOwnerOf", [id])]);
  const [owner, policyRev, secretRev, committeeId, paused, rules] = policy;
  if (lc(ledgerAddr) === ZERO || lc(registryAddr) === ZERO) throw err("release_authority_missing", auth.kind === "book" ? "address book has no deployments/registry entry" : "pinned release authorities required");
  const epId = endpoint ? endpointIdOf(endpoint) : null;
  const zeroCid = /^0x0{64}$/.test(committeeId);
  const [row, reg, committee] = await Promise.all([
    ledgerAddr === ZERO ? null : rd(ledgerAddr, LEDGER_ABI, "get", [id]),
    !epId || registryAddr === ZERO ? null : rd(registryAddr, REGISTRY_V4_ABI, "get", [epId]),
    zeroCid ? null : readCommitteeAt(rd, vault, committeeId),
  ]);
  return {
    policy: { owner: lc(owner), policyRev, secretRev, committeeId: lc(committeeId), paused, rules: b(rules) },
    bundle: { committeeId: lc(bundle[0]), secretRev: bundle[1], data: b(bundle[2]) },
    committee,
    beneficialOwner: lc(beneficialOwner),
    lease: row ? { owner: lc(row.owner), runner: lc(row.runner), leaseUntil: Number(row.leaseUntil), appRef: row.appRef, envelope: row.configCid } : null,
    endpointId: epId ? lc(epId) : null,
    endpointOperator: reg && reg.active ? lc(reg.operator) : null,
    ...(auth.policy && epId ? { platform: await platformFactsAt(rd, codeAt(client, block), auth.policy, [epId]) } : {}),
  };
}
// ---- platform host policy facts at THIS block (network/platform-host-policy.mjs readPolicyFacts): the book's two anchor
// halves, its CURRENT owner (and that owner's ERC-1271 answer for the gate's accepted policy, policy.check1271()) and, for
// each host, its registry operator/endpoint and ACCEPTED owner on the pinned ownership extension - all at one block
const codeAt = (client, block) => (a) => client.request({ method: "eth_getCode", params: [a, { blockHash: block.blockHash, requireCanonical: true }] });
const platformFactsAt = (rd, code, policy, registryIds) => readPolicyFacts({ call: rd, code },
  { book: policy.book, hostOwnership: policy.hostOwnership, registryIds, check1271: typeof policy.check1271 === "function" ? policy.check1271() : [] });
// ---- owner read (custody/v2/custodian.mjs ownerRead): the release state, the policy owner's code and, for a contract
// owner, its ERC-1271 verdict on THIS digest and signature, all at ONE agreed block (one fingerprint, the same high-water)
async function readOwnerReadAt(client, vault, { id, digest, sig }, block, auth) {
  const s = await readReleaseAt(client, vault, { id, endpoint: null }, block, auth);
  const owner = s.policy.owner;
  let ownerIsContract = false, erc1271 = null;
  if (owner && owner !== ZERO) {
    const code = await client.request({ method: "eth_getCode", params: [owner, { blockHash: block.blockHash, requireCanonical: true }] });
    ownerIsContract = typeof code === "string" && code !== "0x" && code.length > 2;
    if (ownerIsContract) {
      try { erc1271 = String(await rdOf(client, block)(owner, ERC1271_ABI, "isValidSignature", [digest, sig])).toLowerCase(); }
      catch (e) { if (!/revert/i.test(String(e?.message || e) + String(e?.cause?.message || ""))) throw e; erc1271 = "revert"; }
    }
  }
  return { ...s, ownerIsContract, erc1271 };
}
// vaultKind "book" (the deployed 0xE486 vault): membership reads REQUIRE hostOwnership - the deployed EnclaveHostOwnership
// extension the accepted host wallet is read from - bound to the registry the book names at that block. Release reads
// (the owner's CLI) need only the vault.
// hostPolicy: { book, hostOwnership } - read the platform host policy anchor and host facts with every release and
// authorization snapshot (off when null: the reads and results are unchanged)
export function createChainReaderV2({ rpcs, vault, hostOwnership = null, vaultKind = "pinned", book: bookPin = null, hostPolicy = null, chainId=null, minAgree, confirmations=0,
  clients: given=null, timeoutMs=10000, maxAgeSec=120, maxFutureSec=10, now=()=>Date.now(), checkpoint=null }) {
  if (!VAULT_KINDS.includes(vaultKind)) throw err("bad_config", "vaultKind must be pinned or book", 500);
  if (hostOwnership !== null && (!/^0x[0-9a-fA-F]{40}$/.test(String(hostOwnership)) || /^0x0{40}$/.test(String(hostOwnership)))) throw err("bad_config", "host-ownership pin must be a non-zero address", 500);
  const auth = { kind: vaultKind, book: bookPin, policy: hostPolicy ? { book: lc(hostPolicy.book), hostOwnership: lc(hostPolicy.hostOwnership), check1271: hostPolicy.check1271 || null } : null };
  if (!given) checkRpcUrls(rpcs);                       // one host is one vote: case, trailing dot, port and path aliases count once
  const clients = given || (rpcs || []).map(url=>createPublicClient({transport:http(url,{timeout:timeoutMs,retryCount:0})}));
  const agreed=createQuorumReader({clients,minAgree,chainId,confirmations,timeoutMs,maxAgeSec,maxFutureSec,now,checkpoint});
  // pinned: the vault's own immutables. book: the book's registry at this block, and the configured ownership extension,
  // which must name that same registry (an admin registry migration needs a re-pinned extension, never a silent mix).
  async function hostAuthorities(rd) {
    if (auth.kind === "book") {
      if (!hostOwnership) throw err("host_authority_missing", "a book-bound vault needs the host-ownership pin for membership reads");
      const [{ registry }, enclave] = await Promise.all([bookAuthoritiesAt(rd, vault, auth.book), rd(vault, VAULT_V2_ABI, "enclaveOwner").then(lc)]);
      if (lc(registry) === ZERO) throw err("host_authority_missing", "address book has no registry entry");
      if (lc(await rd(hostOwnership, HOST_OWNERSHIP_ABI, "registry")) !== lc(registry)) throw err("host_authority_mismatch", "host-ownership extension is bound to another registry than the address book names");
      return { registry, ownership: hostOwnership, enclave, kind: "book" };
    }
    const [registry, ownership] = await Promise.all([rd(vault, VAULT_V2_ABI, "hostRegistry"), rd(vault, VAULT_V2_ABI, "hostOwnership")]);
    if (hostOwnership && lc(ownership) !== lc(hostOwnership)) throw err("host_authority_mismatch", "vault host authority differs from the measured pin");
    if (registry === ZERO || ownership === ZERO) throw err("host_authority_missing", "wallet host authority required");
    return { registry, ownership, kind: "pinned" };
  }
  // owner: the accepted host wallet, always from the ownership extension. Book-bound entries also carry vaultEnclave, the
  // flag that vault computes in _admit at this block (the registry payout declaration, which only the Enclave wallet itself
  // can make), and ownerConflict: the vault would seat the host as Enclave while another wallet accepted ownership of it.
  // Pinned entries carry neither; there the vault's flag is the accepted owner itself (member.mjs vaultEnclaveOf).
  async function entryAt(rd, { registry, ownership, enclave, kind }, registryId) {
    const [e, authority] = await Promise.all([rd(registry, REGISTRY_V4_ABI, "get", [registryId]), rd(ownership, HOST_OWNERSHIP_ABI, "authority", [registryId])]);
    const out = { endpoint: e.endpoint, active: e.active, operator: lc(e.operator), payoutWallet: lc(e.payoutWallet), owner: lc(authority[0]) };
    if (kind !== "book") return out;
    const vaultEnclave = out.payoutWallet === enclave;
    return { ...out, vaultEnclave, ownerConflict: vaultEnclave && out.owner !== ZERO && out.owner !== enclave };
  }
  return {
    vault, clients,
    vaultKind,
    readRelease: ({ id, endpoint }) => agreed((c, n) => readReleaseAt(c, vault, { id, endpoint }, n, auth)),
    readOwnerRead: ({ id, digest, sig }) => agreed((c, n) => readOwnerReadAt(c, vault, { id, digest, sig }, n, auth)),
    // one agreed snapshot for network/platform-host-policy.mjs createPlatformHostGate: call/code bound to that block
    snapshot: (fn) => agreed((c, n) => fn({ block: n.blockNumber, call: rdOf(c, n),
      code: (a) => c.request({ method: "eth_getCode", params: [a, { blockHash: n.blockHash, requireCanonical: true }] }) })),
    // the vault's code identity at one agreed block (network/custody-vaults.mjs checkCustodyVaultIdentity judges it)
    readVaultIdentity: () => agreed(async (c, n) => {
      const code = await c.request({ method: "eth_getCode", params: [vault, { blockHash: n.blockHash, requireCanonical: true }] });
      const rd = rdOf(c, n);
      const [book, enclaveOwner] = await Promise.all([rd(vault, VAULT_V2_ABI, "book"), rd(vault, VAULT_V2_ABI, "enclaveOwner")]);
      const out = { codeHash: keccak256(code), runtimeBytes: (String(code).length - 2) / 2, book: lc(book), enclaveOwner: lc(enclaveOwner) };
      if (auth.kind === "pinned") out.hostOwnership = lc(await rd(vault, VAULT_V2_ABI, "hostOwnership"));
      return out;
    }),
    // the committee's current epoch, its machines (with on-chain Enclave flags) and commitments; plus any pending handover
    readCommittee: ({ committeeId }) => agreed(async (c, n) => {
      const rd = rdOf(c, n);
      const cur = await readCommitteeAt(rd, vault, committeeId);
      if (!cur) return { committee: null, pending: null };
      const p = await rd(vault, VAULT_V2_ABI, "pendingOf", [committeeId]);
      const pending = Number(p[0]) ? { toEpoch: Number(p[0]), next: p[1].map((m, i) => ({ ...machineOut(m), enclave: p[2][i] })), t: Number(p[3]), W: Number(p[4]),
                                       dealers: p[5].map(Number), expires: Number(p[6]), acks: Number(await rd(vault, VAULT_V2_ABI, "ackCount", [committeeId, p[0]])) } : null;
      return { committee: cur, pending };
    }),
    readDeal: ({ committeeId, toEpoch, dealerIndex }) => agreed(async (c, n) => {
      const [dc, sealed] = await rdOf(c, n)(vault, VAULT_V2_ABI, "dealOf", [committeeId, toEpoch, dealerIndex]);
      return { dealCommitments: b(dc), sealed: sealed.map(b) };
    }),
    readCodeActiveAt: ({ committeeId, measurement }) => agreed(async (c, n) => ({ activeAt: Number(await rdOf(c, n)(vault, VAULT_V2_ABI, "codeActiveAt", [committeeId, measurement])) })),
    // A contract-wallet owner's ERC-1271 answer at the agreed block. A revert fails that RPC's read; it never votes "valid".
    readIsValidSignature: ({ account, hash, signature }) => agreed(async (c, n) => {
      const code = await c.request({ method: "eth_getCode", params: [account, { blockHash: n.blockHash, requireCanonical: true }] });
      if (!code || code === "0x") return { valid: false };
      return { valid: lc(await rdOf(c, n)(account, ERC1271_ABI, "isValidSignature", [hash, signature])) === ERC1271_MAGIC };
    }),
    // Membership: the accepted host wallet is always read from an ownership extension (never inferred from payout); the
    // Enclave flag is reported as the vault computes it. There is no fallback between kinds: a pinned reader never
    // consults the book, and a book reader never treats payout as ownership.
    readRegistryEntry: ({ registryId }) => agreed(async (c, n) => {
      const rd = rdOf(c, n), hosts = await hostAuthorities(rd);
      return { entry: await entryAt(rd, hosts, registryId) };
    }),
    // ONE agreed block for an authorization decision (governance.mjs): the committee, the registry entry (operator and
    // accepted owner) of every seat and of every extra host, code activation and ERC-1271 answers. Owner consent,
    // operator binding and owner distinctness are then judged together; separate reads could mix an owner authorized
    // at one block with a different owner or operator at another. A check names an account, or a host whose owner AT
    // THIS BLOCK is asked. A wallet that reverts or has no code answers false here; the RPC majority still decides.
    readAuthorization: ({ committeeId = null, registryIds = [], measurements = [], checks = [] }) => {
      if (registryIds.length > MAX_AUTH_HOSTS || measurements.length > 64 || checks.length > MAX_AUTH_CHECKS) return Promise.reject(err("bad_request", "authorization read too large", 400));
      return agreed(async (c, n) => {
        const rd = rdOf(c, n), hosts = await hostAuthorities(rd);
        const committee = committeeId ? await readCommitteeAt(rd, vault, committeeId) : null;
        const ids = [...new Set([...(committee ? committee.machines.map((m) => m.registryId) : []), ...registryIds.map(lc)])];
        const entries = {};
        for (const id of ids) entries[id] = await entryAt(rd, hosts, id);
        const codeActiveAt = {};
        if (committee) for (const m of new Set(measurements.map(lc))) codeActiveAt[m] = Number(await rd(vault, VAULT_V2_ABI, "codeActiveAt", [committeeId, m]));
        const valid = [];
        for (const ch of checks) {
          const account = ch.account ? lc(ch.account) : entries[lc(ch.registryId)]?.owner;
          let ok = false;
          if (account && account !== ZERO) {
            const code = await c.request({ method: "eth_getCode", params: [account, { blockHash: n.blockHash, requireCanonical: true }] });
            if (code && code !== "0x") { try { ok = lc(await rd(account, ERC1271_ABI, "isValidSignature", [ch.hash, ch.signature])) === ERC1271_MAGIC; } catch { ok = false; } }
          }
          valid.push(ok);
        }
        return { committee, entries, codeActiveAt, valid, enclaveOwner: lc(await rd(vault, VAULT_V2_ABI, "enclaveOwner")),
                 ...(auth.policy ? { platform: await platformFactsAt(rd, codeAt(c, n), auth.policy, ids) } : {}) };
      });
    },
  };
}
