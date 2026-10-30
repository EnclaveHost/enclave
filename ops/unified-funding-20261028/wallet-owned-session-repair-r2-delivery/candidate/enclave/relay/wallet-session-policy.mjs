// relay/wallet-session-policy.mjs -- the ONE resolver of a wallet-held deployment's session policy (WalletSessionVault,
// contracts/WalletSessionVault.sol + WalletSessionPolicy.sol). wallet-owned-session-create-r1, rewritten in
// wallet-owned-session-repair-r2 (authenticated discovery). Not run, not tested.
//
// Imported by every consumer that must agree on it:
//   relay/sessions.mjs          createCustodyGate().custodyRefusal / custodyDecision (relay/secrets.js fetch,
//                               relay/secrets-release.mjs attested release, relay/shield-secrets.mjs Shield release)
//                               sessionRowRefusal (relay API sessions acting on one row)
//                               createSessionsService isVault (relay SUBMISSION of a wallet vault's SessionCall)
//   windows/node/session-api-auth.mjs  verify / refusal / visible (host api.* session authorization; supervisor.js and
//                               windows/node/agent.mjs construct it with createHostWalletPolicy below)
//
// DISCOVERY: WHAT CREATED THE ROW. Never a configured factory list, an operator allowlist, a request-supplied owner()
// or the absence of a record from some registry. Per decision, at ONE block (chain id + head hash re-checked at the end):
//   1. the ledger's own Created(id) log over the FULL range [fromBlock, head] (exactly one: the ledger never re-emits an
//      id), its canonical block hash and its transaction receipt (success, same block, same log at the same index);
//   2. create vs import, from the ledger's own log order: create() emits Created then RunnerRateSet(id) from
//      _snapRunnerRate; importDeployments emits Created then Funded/the next item - never RunnerRateSet. Created.owner is
//      msg.sender for create but the IMPORTED d.owner for import, so owner==wallet alone proves nothing;
//   3. create by an address with no code at that block that also SENT the transaction (or an EIP-7702 EOA): a plain
//      wallet's own create - positively legacy. Create by a contract: it must verify as a wallet-session vault
//      (verifyVault: EIP-1167 clone -> implementation bytes == reviewed artifact -> its immutable factory bytes ==
//      reviewed artifact naming that implementation, CREATE(factory,1)==profile, CREATE(factory,2)==implementation,
//      profile and linked library bytes == reviewed artifacts, CREATE2(factory, owner, clone) == the vault), with its
//      vault Bound(id), the factory Bound(id, vault, owner) and the transfer vault->owner in the SAME receipt and the
//      factory's creatorOf(id) agreeing; or be a vault of a LEGACY SessionVault factory (existing reviewed legacy
//      config). Anything else (unknown contract, mismatch) is invalid: refused, never legacy;
//   4. import: legacy only when no reviewed wallet-session vault ever emitted Bound(id) on this chain (address-less,
//      full-range log search); any verified ancestry is refused (imported wallet-session policy is unsupported).
// Owner continuity: the legacy ledger has no ownership generation. A binding whose row left the owner's wallet after
// birth and came back is "stale" (refused) until the owner makes a new policy decision on the vault AFTER the last
// transfer back (PolicyChanged). This gates consumers from authenticated history only; on chain, _bound still lets a
// session act after transfer-back (see REPORT-R2.md).
// Any read failure, reorg or chain switch THROWS (callers fail closed: 503). Code identity comes from the root-generated
// manifest (relay/wallet-session-protocol.mjs via wallet-session-manifest.mjs); without it no vault verifies.
//
// Decision kinds (resolve(row)): legacy-unbound | bound | detached | void | stale | invalid

import { useViemForManifest, cloneImplementation, isDelegatedEoa, isEmptyCode, matchArtifact, validateManifest }
  from "./wallet-session-manifest.mjs";

// NO bare package import (windows/node/deploy-files.mjs refuses one outside windows/node, and the Windows bundle ships
// relay/ without node_modules): every importer that resolves viem itself injects it once - relay/sessions.mjs,
// relay/api-relay.js, windows/node/session-api-auth.mjs. Until then every viem-backed call throws (fail closed).
const V = {};
const VIEM = ["getAddress", "keccak256", "encodeAbiParameters", "isAddress", "getContractAddress", "pad", "concat", "hexToBytes", "bytesToHex"];
const via = (k) => (...a) => { if (!V[k]) throw new Error("wallet-session policy: viem was not injected (useViem)"); return V[k](...a); };
const getAddress = via("getAddress"), keccak256 = via("keccak256"), encodeAbiParameters = via("encodeAbiParameters"),
  isAddress = via("isAddress"), getContractAddress = via("getContractAddress"), pad = via("pad"), concat = via("concat");
export let WALLET_SESSION_PROTOCOL = null;
export let TOPICS = null;
/** inject viem (idempotent); sets WALLET_SESSION_PROTOCOL and TOPICS */
export function useViem(viem) {
  for (const k of VIEM) { if (typeof viem?.[k] !== "function") throw new Error(`wallet-session policy: viem.${k} missing`); V[k] = viem[k]; }
  useViemForManifest(viem);
  WALLET_SESSION_PROTOCOL = keccak256(new TextEncoder().encode("enclave.wallet-session.v1"));
  TOPICS = Object.fromEntries(Object.entries(EVENTS).map(([k, ev]) => [k, eventTopic(ev)]));
}
export const WALLET_SESSION_VERSION = "wallet-v1";
export const ENV_STAGING = 1;
export const ENV_PROD = 2;
export const BOUND = 1;
export const DETACHED = 2;
const ZERO = "0x0000000000000000000000000000000000000000";

export const walletSessionFactoryAbi = [
  { type: "function", name: "creatorOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isVault", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "ledger", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "PROTOCOL", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
];
export const walletSessionVaultPolicyAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyOf", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "env", type: "uint8" }, { name: "state", type: "uint8" }, { name: "revision", type: "uint64" },
      { name: "approved", type: "bytes32" }, { name: "createdBy", type: "bytes32" }] }] },
];

// the exact events discovery reads (EnclaveDeployments.sol 522/528/534, WalletSessionVault.sol)
const ev = (name, inputs) => ({ type: "event", name,
  inputs: inputs.map(([type, n, indexed]) => ({ type, name: n, indexed: Boolean(indexed) })) });
export const EVENTS = {
  created: ev("Created", [["bytes32", "id", 1], ["address", "owner", 1], ["string", "appRef"], ["uint16", "gpuMilli"], ["uint16", "cpuMilli"], ["uint256", "rate"]]),
  runnerRateSet: ev("RunnerRateSet", [["bytes32", "id", 1], ["uint256", "runnerRate6"]]),
  transferred: ev("DeploymentTransferred", [["bytes32", "id", 1], ["address", "from", 1], ["address", "to", 1]]),
  vaultBound: ev("Bound", [["bytes32", "id", 1], ["uint8", "env"], ["bytes32", "createdBy", 1], ["address", "wallet", 1]]),
  factoryBound: ev("Bound", [["bytes32", "id", 1], ["address", "vault", 1], ["address", "owner", 1]]),
  policyChanged: ev("PolicyChanged", [["bytes32", "id", 1], ["uint8", "state"], ["uint8", "env"], ["bytes32", "approved"], ["uint64", "revision"]]),
};
/** topic0 of an event ABI item */
export const eventTopic = (e) => keccak256(new TextEncoder().encode(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`)).toLowerCase();

/** keccak256(abi.encode(appRef, configCid)) - WalletSessionPolicy.contentHash */
export function contentHash(appRef, configCid) {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [String(appRef ?? ""), String(configCid ?? "")]));
}

/** "catalog://0x<64 lower hex>/<n>" -> appId (lower-case), else null (SessionVaultLib.parseRef's spelling) */
export function appIdOfRef(ref) {
  const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(0|[1-9][0-9]{0,9})$/.exec(String(ref ?? ""));
  return m ? m[1] : null;
}

/** WALLET_SESSIONS_PINS="0xFactory:0xCodeHash[,...]" -> [{ factory, codeHash }]. Malformed THROWS (no silent drop).
 *  Pins are optional DENY-ONLY assertions (a pinned factory must still have that code, protocol and ledger); they are
 *  never discovery, never required, and an empty list changes nothing. */
export function walletPinsFromEnv(env = process.env) {
  const raw = String(env.WALLET_SESSIONS_PINS ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((e) => e.trim()).filter(Boolean).map((e) => {
    const [f, h, extra] = e.split(":");
    if (extra !== undefined || !isAddress(f || "") || !/^0x[0-9a-fA-F]{64}$/.test(h || ""))
      throw new Error(`WALLET_SESSIONS_PINS: "${e}" is not 0x<factory>:0x<runtime code hash>`);
    return { factory: getAddress(f), codeHash: h.toLowerCase() };
  });
}

const lc = (x) => String(x ?? "").toLowerCase();
const topicAddr = (t) => getAddress("0x" + lc(t).slice(26));
const pos = (l) => [BigInt(l.blockNumber), Number(l.logIndex)];
const after = (a, b) => { const [ab, ai] = pos(a), [bb, bi] = pos(b); return ab > bb || (ab === bb && ai > bi); };
const cloneInitCode = (impl) => concat(["0x3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, "0x5af43d82803e903d91602b57fd5bf3"]);

/** a reader of the EXISTING legacy SessionVault factories (SESSIONS_FACTORIES / DEFAULT_FACTORIES): is `a` one of
 *  their vaults? Legacy configuration only - never consulted for wallet-session admission. */
export function legacyVaultReader({ pc, factories }) {
  const list = (factories || []).filter((f) => isAddress(String(f || ""))).map((f) => getAddress(f));
  return async (a) => {
    for (const f of list) {
      const code = await pc.getCode({ address: f });
      if (isEmptyCode(code)) continue;
      if (await pc.readContract({ address: f, abi: walletSessionFactoryAbi, functionName: "isVault", args: [getAddress(a)] })) return true;
    }
    return false;
  };
}

/**
 * pc            viem public client (getChainId, getBlock, getCode, getLogs, getTransactionReceipt, readContract)
 * chainId       the chain this consumer serves; re-read and compared at the start AND end of every decision
 * ledger        () => the deployments ledger this consumer reads rows from
 * pins          [{ factory, codeHash }] - REQUIRED explicitly (deny-only; [] is fine and never "not activated")
 * manifest      the reviewed protocol manifest (wallet-session-manifest.mjs), REQUIRED explicitly; null = none generated
 *               yet: no vault verifies, so contract-created rows are invalid (refused)
 * isLegacyVault async (address) => bool, the existing legacy factories (legacyVaultReader); null = none recognised
 * fromBlock     lower bound of the full-range log searches (0n, or the ledger's verified birth block)
 */
export function createWalletPolicyResolver({ pc, chainId, ledger, pins, manifest, isLegacyVault = null, fromBlock = 0n }) {
  if (!pc) throw new Error("createWalletPolicyResolver: a public client is required");
  if (!Array.isArray(pins)) throw new Error("createWalletPolicyResolver: pins must be given explicitly (an array)");
  if (manifest === undefined) throw new Error("createWalletPolicyResolver: manifest must be given explicitly (null = none generated)");
  if (!Number.isSafeInteger(Number(chainId))) throw new Error("createWalletPolicyResolver: chainId is required");
  if (typeof ledger !== "function") throw new Error("createWalletPolicyResolver: ledger() is required");
  const A = manifest ? validateManifest(manifest).artifacts : null;
  const list = pins.map((p) => ({ factory: getAddress(p.factory), codeHash: String(p.codeHash).toLowerCase() }));
  const births = new Map();   // chain:ledger:id -> verified birth (re-validated: block hash + code hashes, every decision)
  const vaults = new Map();   // chain:vault -> verified vault identity (re-validated: code hashes, every decision)

  /** one decision's chain view: the configured chain, the ledger, the head block. Throws on a wrong chain. */
  async function snapshot() {
    const cid = Number(await pc.getChainId());
    if (cid !== Number(chainId)) throw new Error(`wallet-session policy: wrong chain (${cid}, configured ${chainId})`);
    const l = getAddress(await ledger());
    const head = await pc.getBlock({ blockTag: "latest" });
    if (head?.number == null || !head.hash) throw new Error("wallet-session policy: head block unreadable");
    return { chainId: cid, ledger: l, head: { number: BigInt(head.number), hash: lc(head.hash) } };
  }
  /** the decision stands only if the chain and the head it was made at are still the canonical ones */
  async function confirm(snap) {
    const cid = Number(await pc.getChainId());
    if (cid !== snap.chainId) throw new Error(`wallet-session policy: chain changed during the decision (${cid})`);
    const b = await pc.getBlock({ blockNumber: snap.head.number });
    if (lc(b?.hash) !== snap.head.hash) throw new Error("wallet-session policy: reorg during the decision");
  }
  const at = (snap) => ({ blockNumber: snap.head.number });
  const read = (snap, q) => pc.readContract({ ...q, ...at(snap) });
  const logs = async (snap, q, from = fromBlock) => {
    const out = await pc.getLogs({ ...q, fromBlock: BigInt(from), toBlock: snap.head.number });
    if (!Array.isArray(out)) throw new Error("wallet-session policy: log search unreadable");
    for (const l of out) if (l.removed) throw new Error("wallet-session policy: a removed (reorged) log was returned");
    return out;
  };

  async function checkPins(snap) {
    for (const p of list) {
      const code = await pc.getCode({ address: p.factory, ...at(snap) });
      if (!code || code === "0x" || keccak256(code).toLowerCase() !== p.codeHash)
        throw new Error(`wallet-session pin: ${p.factory} code is not the reviewed factory`);
      const [proto, fl] = await Promise.all([
        read(snap, { address: p.factory, abi: walletSessionFactoryAbi, functionName: "PROTOCOL" }),
        read(snap, { address: p.factory, abi: walletSessionFactoryAbi, functionName: "ledger" })]);
      if (lc(proto) !== lc(WALLET_SESSION_PROTOCOL)) throw new Error("wallet-session pin: wrong protocol");
      if (getAddress(fl) !== snap.ledger) throw new Error(`wallet-session pin: ${p.factory} is bound to ledger ${fl}, not ${snap.ledger}`);
    }
  }

  async function codesStill(snap, codes) {
    const now = await Promise.all(Object.keys(codes).map((a) => pc.getCode({ address: a, ...at(snap) })));
    return Object.values(codes).every((h, i) => !isEmptyCode(now[i]) && keccak256(now[i]).toLowerCase() === h);
  }

  /** `addr` as a wallet-session vault, verified from code alone -> identity, or null (definitively not one). Throws on
   *  an unreadable chain. */
  async function verifyVault(addr, snap) {
    if (!A) return null;
    const v = getAddress(addr), key = `${snap.chainId}:${v}`;
    const hit = vaults.get(key);
    if (hit) { if (await codesStill(snap, hit.codes)) return hit; vaults.delete(key); }
    const code = await pc.getCode({ address: v, ...at(snap) });
    const impl = cloneImplementation(code);
    if (!impl) return null;
    const vm = matchArtifact(await pc.getCode({ address: impl, ...at(snap) }), A.vault);
    if (!vm) return null;
    const factory = vm.immutables.factory, profile = vm.immutables.book, lib = vm.links.SessionVaultLib;
    if (getContractAddress({ from: factory, nonce: 1n }) !== profile || getContractAddress({ from: factory, nonce: 2n }) !== impl) return null;
    const [fc, pcode, lcode] = await Promise.all([factory, profile, lib].map((a) => pc.getCode({ address: a, ...at(snap) })));
    const fm = matchArtifact(fc, A.factory), pm = matchArtifact(pcode, A.profile), lm = matchArtifact(lcode, A.library);
    if (!fm || !pm || !lm || lm.self !== lib) return null;
    if (fm.immutables.implementation !== impl || fm.immutables.ledger !== vm.immutables.ledger || fm.immutables.profile !== profile
        || pm.immutables.deployments !== vm.immutables.ledger) return null;
    const owner = getAddress(await read(snap, { address: v, abi: walletSessionVaultPolicyAbi, functionName: "owner" }));
    // the vault IS the factory's CREATE2 clone for this owner (createVault initializes with the same owner it salts)
    if (getContractAddress({ opcode: "CREATE2", from: factory, salt: pad(owner, { size: 32 }), bytecode: cloneInitCode(impl) }) !== v) return null;
    const out = { vault: v, owner, factory, implementation: impl, profile, catalog: pm.immutables.appCatalog, library: lib,
      ledger: vm.immutables.ledger, router: vm.immutables.router, usdc: vm.immutables.usdc,
      keyAttestations: vm.immutables.keyAttestations, maxVault6: vm.immutables.maxVault6,
      codes: { [v]: keccak256(code).toLowerCase(), [impl]: vm.codeHash, [factory]: fm.codeHash, [profile]: pm.codeHash, [lib]: lm.codeHash } };
    vaults.set(key, out);
    return out;
  }

  /** verified wallet-session vaults that ever emitted Bound(id) on this chain (address-less full-range search) */
  async function verifiedBinders(id, snap) {
    const found = await logs(snap, { event: EVENTS.vaultBound, args: { id } });
    const emitters = [...new Set(found.filter((l) => lc(l.topics?.[0]) === TOPICS.vaultBound && lc(l.topics?.[1]) === id)
      .map((l) => getAddress(l.address)))];
    if (!A && emitters.length) return { unverifiable: emitters.length, verified: [] };
    const verified = [];
    for (const e of emitters) {
      const v = await verifyVault(e, snap);
      if (v) verified.push({ ...v, logs: found.filter((l) => getAddress(l.address) === e) });
    }
    return { unverifiable: 0, verified };
  }

  const invalid = (id, holder, reason, extra = {}) => ({ kind: "invalid", id, owner: holder, reason, ...extra });

  /** the row's verified birth -> { origin, ... } | { invalid: reason }. Cached only with its block hash and codes. */
  async function birthOf(id, snap) {
    const key = `${snap.chainId}:${snap.ledger}:${id}`, hit = births.get(key);
    if (hit && hit.blockNumber <= snap.head.number) {
      const b = await pc.getBlock({ blockNumber: hit.blockNumber });
      if (lc(b?.hash) === hit.blockHash && (!hit.codes || (await codesStill(snap, hit.codes)))) return hit;
      births.delete(key);
    }
    const created = (await logs(snap, { address: snap.ledger, event: EVENTS.created, args: { id } }))
      .filter((l) => getAddress(l.address) === snap.ledger && lc(l.topics?.[0]) === TOPICS.created && lc(l.topics?.[1]) === id);
    if (created.length !== 1)
      throw new Error(`wallet-session policy: ${created.length} Created(${id}) logs on ${snap.ledger} (birth evidence incomplete)`);
    const log = created[0];
    const [receipt, blk] = await Promise.all([pc.getTransactionReceipt({ hash: log.transactionHash }), pc.getBlock({ blockNumber: BigInt(log.blockNumber) })]);
    if (lc(blk?.hash) !== lc(log.blockHash) || lc(receipt?.blockHash) !== lc(log.blockHash) || receipt.status !== "success")
      throw new Error("wallet-session policy: the Created log is not in a canonical successful receipt");
    const rl = receipt.logs || [], i = rl.findIndex((l) => Number(l.logIndex) === Number(log.logIndex));
    if (i < 0 || getAddress(rl[i].address) !== snap.ledger || lc(rl[i].topics?.[0]) !== TOPICS.created || lc(rl[i].topics?.[1]) !== id)
      throw new Error("wallet-session policy: the receipt disagrees with the Created log");
    const next = rl[i + 1];
    const isCreate = Boolean(next && getAddress(next.address) === snap.ledger && lc(next.topics?.[0]) === TOPICS.runnerRateSet
      && lc(next.topics?.[1]) === id && Number(next.logIndex) === Number(log.logIndex) + 1);
    const named = topicAddr(log.topics[2]);
    const base = { blockNumber: BigInt(log.blockNumber), blockHash: lc(log.blockHash), tx: lc(log.transactionHash),
      logIndex: Number(log.logIndex), named };
    let out;
    if (!isCreate) {
      // importDeployments: Created.owner is the IMPORTED holder, not a creator
      const anc = await verifiedBinders(id, snap);
      if (anc.unverifiable) return { invalid: "imported row with Bound(id) logs and no reviewed manifest to judge them" };
      if (anc.verified.length) return { invalid: "imported row with wallet-session ancestry (unsupported)" };
      out = { ...base, origin: "imported" };
    } else {
      const code = await pc.getCode({ address: named, blockNumber: base.blockNumber });
      if (isEmptyCode(code) || isDelegatedEoa(code)) {
        if (isEmptyCode(code) && getAddress(receipt.from) !== named)
          return { invalid: "an address without code created the row but did not send the transaction" };
        out = { ...base, origin: "wallet-direct" };
      } else {
        const v = await verifyVault(named, snap);
        if (v) {
          if (v.ledger !== snap.ledger) return { invalid: "the creating vault is bound to another ledger" };
          const anc = await verifiedBinders(id, snap);
          const mine = anc.verified.length === 1 && anc.verified[0].vault === v.vault
            && anc.verified[0].logs.length === 1 && lc(anc.verified[0].logs[0].transactionHash) === base.tx
            && Number(anc.verified[0].logs[0].logIndex) > base.logIndex;
          const fb = rl.some((l) => getAddress(l.address) === v.factory && lc(l.topics?.[0]) === TOPICS.factoryBound
            && lc(l.topics?.[1]) === id && topicAddr(l.topics[2]) === v.vault && topicAddr(l.topics[3]) === v.owner);
          const tr = rl.find((l) => getAddress(l.address) === snap.ledger && lc(l.topics?.[0]) === TOPICS.transferred
            && lc(l.topics?.[1]) === id && topicAddr(l.topics[2]) === v.vault && topicAddr(l.topics[3]) === v.owner
            && Number(l.logIndex) > base.logIndex);
          if (!mine || !fb || !tr) return { invalid: "the creating vault's Bound/transfer evidence does not match its receipt" };
          out = { ...base, origin: "wallet-session", vault: v, birthTransfer: tr, codes: v.codes };
        } else if (isLegacyVault && (await isLegacyVault(named))) {
          out = { ...base, origin: "legacy-vault" };
        } else return { invalid: "created by a contract that matches no reviewed protocol artifact" };
      }
    }
    births.set(key, out);
    if (births.size > 50_000) births.clear();
    return out;
  }

  /** is the binding continuous since birth? "unbroken" | "redecided" | "stale" */
  async function continuity(id, snap, b) {
    const tr = (await logs(snap, { address: snap.ledger, event: EVENTS.transferred, args: { id } }, b.blockNumber))
      .filter((l) => getAddress(l.address) === snap.ledger && lc(l.topics?.[0]) === TOPICS.transferred && lc(l.topics?.[1]) === id)
      .filter((l) => after(l, b.birthTransfer));
    if (!tr.length) return "unbroken";
    tr.sort((x, y) => (after(x, y) ? 1 : -1));
    const last = tr[tr.length - 1];
    if (topicAddr(last.topics[3]) !== b.vault.owner) throw new Error("wallet-session policy: transfer history disagrees with the row holder");
    const re = (await logs(snap, { address: b.vault.vault, event: EVENTS.policyChanged, args: { id } }, BigInt(last.blockNumber)))
      .filter((l) => getAddress(l.address) === b.vault.vault && lc(l.topics?.[1]) === id && after(l, last));
    return re.length ? "redecided" : "stale";
  }

  async function decide(id, holder, snap) {
    const b = await birthOf(id, snap);
    if (b.invalid) return invalid(id, holder, b.invalid);
    const ev = { origin: b.origin, birthBlock: b.blockNumber, birthHash: b.blockHash, birthTx: b.tx };
    if (b.origin !== "wallet-session") return { kind: "legacy-unbound", id, owner: holder, evidence: ev };
    const v = b.vault;
    const base = { id, factory: v.factory, vault: v.vault, owner: holder, bindingOwner: v.owner, profile: v.profile, evidence: ev };
    if (v.owner !== holder) return { ...base, kind: "void" };
    const [creator, isV] = await Promise.all([
      read(snap, { address: v.factory, abi: walletSessionFactoryAbi, functionName: "creatorOf", args: [id] }),
      read(snap, { address: v.factory, abi: walletSessionFactoryAbi, functionName: "isVault", args: [v.vault] })]);
    if (!creator || getAddress(creator) !== v.vault || !isV) return { ...base, kind: "invalid", reason: "the factory registry disagrees with the verified birth" };
    const p = await read(snap, { address: v.vault, abi: walletSessionVaultPolicyAbi, functionName: "policyOf", args: [id] });
    const env = Number(p.env), state = Number(p.state);
    const out = { ...base, env, state, revision: BigInt(p.revision), approved: lc(p.approved), createdBy: lc(p.createdBy) };
    if (state === DETACHED) return { ...out, kind: "detached" };
    if (state !== BOUND || (env !== ENV_STAGING && env !== ENV_PROD)) return { ...out, kind: "invalid", reason: `binding state ${state} env ${env}` };
    const c = await continuity(id, snap, b);
    if (c === "stale") return { ...out, kind: "stale", continuity: c };
    return { ...out, kind: "bound", continuity: c };
  }

  /** the decision for ONE ledger row { id, owner, appRef, configCid }, made at one verified block */
  async function resolve(row) {
    const id = lc(row?.id);
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("wallet-session policy: row id is not a bytes32");
    if (!row?.owner || !isAddress(String(row.owner))) throw new Error("wallet-session policy: row owner unreadable");
    const holder = getAddress(row.owner);
    const snap = await snapshot();
    await checkPins(snap);
    const out = await decide(id, holder, snap);
    await confirm(snap);
    return { ...out, chainId: snap.chainId, ledger: snap.ledger, block: snap.head.number, blockHash: snap.head.hash };
  }

  /** is `vault` a verified wallet-session vault on THIS ledger? -> its factory, or null. Throws on an unreadable chain. */
  async function factoryOfVault(vault) {
    const snap = await snapshot();
    await checkPins(snap);
    const v = await verifyVault(vault, snap);
    await confirm(snap);
    return v && v.ledger === snap.ledger ? v.factory : null;
  }

  return { resolve, factoryOfVault, verifyVault: async (a) => { const s = await snapshot(); const v = await verifyVault(a, s); await confirm(s); return v; },
    pins: list.map((p) => ({ ...p })), manifestLoaded: Boolean(A) };
}

/** what a final secret check compares: the policy the release was authorized under must be EXACTLY the current one */
export function policyKey(p) {
  if (!p) return "none";
  return JSON.stringify([p.kind, lc(p.vault), lc(p.bindingOwner), p.env ?? null, p.state ?? null,
    p.revision == null ? null : String(p.revision), lc(p.approved), p.evidence?.origin ?? null, p.evidence?.birthHash ?? null,
    p.continuity ?? null]);
}

/** Secret release for a wallet-held row (one rule for secrets.js, secrets-release.mjs, shield-secrets.mjs).
 *  null = no objection, else why not. STAGING keeps the existing staging semantics (no promotion needed); PROD needs
 *  the owner's approval of EXACTLY the row's current (appRef, configCid). */
export function walletSecretRefusal(p, row) {
  if (!p) return "wallet-session policy unresolved";
  switch (p.kind) {
    case "legacy-unbound": case "detached": case "void": return null;
    case "stale": return "this deployment left its owner's wallet and came back; the owner has not re-decided its session policy";
    case "bound":
      if (p.env === ENV_STAGING) return null;
      if (p.env === ENV_PROD) {
        if (p.approved && p.approved === contentHash(row.appRef, row.configCid).toLowerCase()) return null;
        return "production deployment: its current version/config has not been approved by the owner";
      }
      return "wallet-session binding has no environment";
    default: return `wallet-session binding unreadable (${p.reason || p.kind})`;
  }
}

/** may a LEGACY (non wallet-v1) session act on a row the session owner's wallet holds, given its policy? Only on
 *  positively legacy rows, or ones the owner explicitly took out of session management / no longer bound to them. */
export const legacySessionMayAct = (p) => p.kind === "legacy-unbound" || p.kind === "detached" || p.kind === "void";

/** May verified session `s` ({ vault, owner, envs, anyApp, apps, version }) act on wallet-held row `row` whose policy is
 *  `p`? null = yes. A wallet-v1 session acts ONLY on rows its own vault bound; no session acts on another vault's binding. */
export function walletSessionRefusal(s, row, p) {
  const holder = String(row?.owner || "").toLowerCase();
  if (!holder || holder !== String(s.owner || "").toLowerCase()) return "This session does not belong to the deployment's owner.";
  if (p.kind !== "bound") {
    if (p.kind === "detached") return "The owner detached this deployment from session management.";
    if (p.kind === "invalid") return "This deployment's session binding is unreadable.";
    if (p.kind === "stale") return "This deployment left the owner's wallet and came back; the owner must re-decide its session policy.";
    return "This deployment was not created under this wallet-session vault.";
  }
  if (String(p.vault).toLowerCase() !== String(s.vault || "").toLowerCase())
    return "This deployment is bound to another session vault.";
  if ((Number(s.envs) & p.env) === 0)
    return `This deployment is ${p.env === ENV_PROD ? "production" : "staging"}, outside this session's environments.`;
  if (!s.anyApp) {
    const app = appIdOfRef(row.appRef);
    const apps = (s.apps || []).map((a) => String(a).toLowerCase());
    if (!app || !apps.includes(app)) return "This deployment's app is outside this session's apps.";
  }
  return null;
}

/** a resolver that can decide nothing: what a host runs when its real one could not be constructed. Every wallet-held
 *  decision fails closed (503 at the host), legacy vault-held paths are untouched. */
export function refusingWalletPolicy(reason) {
  const no = async () => { throw new Error(`wallet-session policy unavailable: ${reason}`); };
  return { resolve: no, factoryOfVault: no, verifyVault: no, pins: [], manifestLoaded: false };
}

/** the host-side construction supervisor.js and windows/node/agent.mjs share: the SAME resolver as the relay, on the
 *  host's own client and ledger, the shipped manifest and its legacy factory list. */
export async function createHostWalletPolicy({ pc, ledger, legacyFactories, env = process.env }) {
  const { loadShippedManifest } = await import("./wallet-session-manifest.mjs");
  // the chain the host's client is CONFIGURED for (viem chain), never whatever its RPC answers first
  const chainId = Number(env.WALLET_SESSIONS_CHAIN_ID || pc.chain?.id);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("createHostWalletPolicy: the client has no configured chain");
  return createWalletPolicyResolver({ pc, chainId, ledger, pins: walletPinsFromEnv(env), manifest: await loadShippedManifest(),
    isLegacyVault: legacyVaultReader({ pc, factories: legacyFactories }) });
}
