/* ============================================================
   Wallet release: the chain side. Pinned deployment identity, the
   exact deployed ABI layouts, one coherent fresh read of everything a
   SessionVault.release(id, ownerWallet, ...) depends on, the eligibility
   rules for this first (narrow) release path, the guard on the SDK's
   generated Release typed data, and read-only outcome verification.

   Sources (exact, read-only): ledger rev16d EnclaveDeployments.sol
   (transferDeployment 958-965, DeploymentTransferred 531), legacy
   SessionVault v2 (release 833-844, Held 480-484, Released 511,
   ownerNonceUsed 494, factory isVault/vaultFor 1175-1186), lease gas
   reserve (Reserve 88-106, reserveOf 299, ledger 35).

   Nothing here signs, sends or writes. A preflight is not atomic: the
   deployed release() takes no expected-state argument, so a change made
   between these reads and inclusion is caught only by recovery.
   ============================================================ */
import { keccak256Hex, keccak256Utf8 } from "./keccak.js";

/* Base mainnet, the one supported legacy deployment. Historical inventory (2026-10-29, block 53263892) is where
   these values came from; it is NOT evidence about the present - every value is re-read and compared per check. */
export const PINS = Object.freeze({
  chainId: 8453,
  ledger: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b",
  ledgerCodeHash: "0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682",
  ledgerSchema: 16n,
  reserve: "0x12a3f873041dec436daa0085b766a399a6fa3639",
  reserveCodeHash: "0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979",
  factory: "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c",
  factoryCodeHash: "0xc9b6214babb0126b26e818de8555c98b7e2a284b08a7cfd42f51b121e93d4f6c",
  book: "0xab214342d5a490150a4a977063a2f88e21f80907",
  vaultCodeHash: "0x3028a275d579db5365554abb3dc85acee22d8a6bb7ace5e230a9adb89bc92a30",
  delegateSlot: 23n,          // rev16d `isDelegate` keeps 15d's slot 23 (source comment at 520); valid only with ledgerCodeHash
});

/* Session/delegate authority is qualified per check by wallet-release-census.js from bounded chain reads; there is no
   per-deployment, per-wallet or operator approval list. */
export const MAX_BLOCK_AGE_SEC = 120;
export const MAX_SIGN_WINDOW_SEC = 3600;
export const SCAN_SPAN = 2000n;     // blocks after the persisted start block searched for a lost tx hash
export const SCAN_CHUNK = 500n;

const ZERO32 = "0x" + "0".repeat(64);
const ZERO20 = "0x" + "0".repeat(40);
const lower = (a) => String(a || "").toLowerCase();
const isHex32 = (h) => /^0x[0-9a-f]{64}$/.test(lower(h));
const pad32 = (hex) => lower(hex).replace(/^0x/, "").padStart(64, "0");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
export const bookKey = (s) => "0x" + Array.from(new TextEncoder().encode(s), (x) => x.toString(16).padStart(2, "0")).join("").padEnd(64, "0");

// ---- exact deployed ABI layouts --------------------------------------------------------------------------------
const fn = (name, inputs, outputs) => ({ type: "function", name, stateMutability: "view",
  inputs: inputs.map((type) => ({ type })), outputs });
const out = (...types) => types.map((t) => typeof t === "string" ? { type: t } : t);
const tuple = (pairs) => ({ type: "tuple", components: pairs.map(([name, type]) => ({ name, type })) });
export const DEPLOYMENT = [["id", "bytes32"], ["owner", "address"], ["appRef", "string"], ["ports", "string"], ["configCid", "string"],
  ["gpuMilli", "uint16"], ["cpuMilli", "uint16"], ["appPort", "uint32"], ["isPublic", "bool"], ["active", "bool"], ["createdAt", "uint64"],
  ["rate", "uint256"], ["balance6", "uint256"], ["spent6", "uint256"], ["runner", "bytes32"], ["runnerOperator", "address"], ["leaseUntil", "uint64"]];
export const RESERVE = [["balanceWei", "uint128"], ["maxPerOpWei", "uint64"], ["epochCapWei", "uint64"], ["enabled", "bool"], ["claimPolicy", "uint8"],
  ["sponsorRelease", "bool"], ["renewWindow", "uint32"], ["minExtension", "uint32"], ["claimCooldown", "uint32"], ["epochSec", "uint32"],
  ["maxGasPrice", "uint64"], ["maxClaimsPerEpoch", "uint8"], ["epochIndex", "uint32"], ["epochSpentWei", "uint96"], ["epochClaims", "uint8"],
  ["lastClaimAt", "uint64"], ["lastClaimOperator", "address"]];
export const ABI = Object.freeze({
  vault: [fn("factory", [], out("address")), fn("owner", [], out("address")), fn("book", [], out("address")),
    fn("held", ["bytes32"], out("uint8", "bytes32", "bytes32")), fn("ownerNonceUsed", ["bytes32"], out("bool"))],
  factory: [fn("isVault", ["address"], out("bool")), fn("vaultFor", ["address"], out("address"))],
  book: [fn("addr", ["bytes32"], out("address"))],
  ledger: [fn("deploymentsSchema", [], out("uint256")), fn("get", ["bytes32"], [tuple(DEPLOYMENT)]),
    fn("ownerEscrow6", ["bytes32"], out("uint256")), fn("earnOf", ["bytes32"], out("uint256", "uint256", "uint64")),
    fn("capOf", ["bytes32"], out("uint256")), fn("feeOf", ["bytes32"], out("address", "uint256"))],
  reserve: [fn("ledger", [], out("address")), fn("reserveOf", ["bytes32", "address"], [tuple(RESERVE)])],
});

export const RELEASE_SIG = "release(bytes32,address,bytes32,uint64,bytes)";
export const RELEASE_SELECTOR = keccak256Utf8(RELEASE_SIG).slice(0, 10);
export const TOPIC_VAULT_RELEASED = keccak256Utf8("Released(bytes32,address)");   // SessionVault, NOT the ledger's lease Released
export const TOPIC_TRANSFERRED = keccak256Utf8("DeploymentTransferred(bytes32,address,address)");
export const RELEASE_TYPE = Object.freeze([{ name: "deployment", type: "bytes32" }, { name: "to", type: "address" },
  { name: "opNonce", type: "bytes32" }, { name: "signBefore", type: "uint64" }]);

export class ReleaseBlocked extends Error {
  constructor(code, message){ super(message); this.code = code; }
}

/* ---- the reader: a narrow seam over a viem PublicClient (production) or an inert fake (tests) ---- */
export function viemReader(pc){
  const nf = (e) => /not.?found|could not be found/i.test(String(e && (e.name + " " + e.message)));
  const blk = (b) => b && { number: BigInt(b.number), hash: lower(b.hash), timestamp: BigInt(b.timestamp) };
  return {
    chainId: async () => Number(await pc.getChainId()),
    latestBlock: async () => blk(await pc.getBlock({ blockTag: "latest" })),
    blockByNumber: async (n) => blk(await (n === "finalized" ? pc.getBlock({ blockTag: "finalized" }) : pc.getBlock({ blockNumber: BigInt(n) })).catch((e) => { if (nf(e)) return null; throw e; })),
    blockTxHashes: async (n) => { const b = await pc.getBlock({ blockNumber: BigInt(n), includeTransactions: false }).catch((e) => { if (nf(e)) return null; throw e; });
      return b && { ...blk(b), transactions: (b.transactions || []).map((t) => lower(typeof t === "string" ? t : t.hash)) }; },
    codeHash: async (address, blockNumber) => keccak256Hex((await pc.getBytecode({ address, blockNumber })) || "0x"),
    read: (address, abi, functionName, args, blockNumber) => pc.readContract({ address, abi, functionName, args, blockNumber }),
    storageAt: async (address, slot, blockNumber) => (await pc.getStorageAt({ address, slot, blockNumber })) || ZERO32,
    simulate: (to, data, blockNumber) => pc.call({ to, data, blockNumber }),
    receipt: (hash) => pc.getTransactionReceipt({ hash }).catch((e) => { if (nf(e)) return null; throw e; }),
    tx: (hash) => pc.getTransaction({ hash }).catch((e) => { if (nf(e)) return null; throw e; }),
    logs: (q) => pc.request({ method: "eth_getLogs", params: [{ address: q.address, topics: q.topics,
      fromBlock: "0x" + BigInt(q.fromBlock).toString(16), toBlock: "0x" + BigInt(q.toBlock).toString(16) }] }),
  };
}

/* ---- helpers ---------------------------------------------------------------------------------------------------- */
const utf8Hex = (s) => Array.from(new TextEncoder().encode(String(s)), (x) => x.toString(16).padStart(2, "0")).join("");
/** keccak256(abi.encode(appRef, configCid)): the Held.promoted commitment the vault records on Promote. */
export function promotedHash(appRef, configCid){
  const a = utf8Hex(appRef), b = utf8Hex(configCid);
  const tail = (h) => word(h.length / 2) + (h.length ? h.padEnd(Math.ceil(h.length / 64) * 64, "0") : "");
  const ta = tail(a);
  return keccak256Hex("0x" + word(64) + word(64 + ta.length / 2) + ta + tail(b));
}
export function delegateSlotOf(owner, delegate){
  const inner = keccak256Hex("0x" + pad32(owner) + word(PINS.delegateSlot));
  return keccak256Hex("0x" + pad32(delegate) + inner.slice(2));
}
/** Exact calldata of vault.release(id, to, opNonce, signBefore, sig). */
export function releaseCalldata(id, to, opNonce, signBefore, sig){
  const s = lower(sig).replace(/^0x/, "");
  return RELEASE_SELECTOR + pad32(id) + pad32(to) + pad32(opNonce) + word(signBefore) + word(160) + word(s.length / 2) +
    (s.length ? s.padEnd(Math.ceil(s.length / 64) * 64, "0") : "");
}
export function decodeReleaseCalldata(input){
  const h = lower(input);
  if (!h.startsWith(RELEASE_SELECTOR) || h.length < 10 + 64 * 6) return null;
  const w = (i) => h.slice(10 + 64 * i, 10 + 64 * (i + 1));
  if (BigInt("0x" + w(4)) !== 160n || !/^0{24}/.test(w(1)) || !/^0{48}/.test(w(3))) return null;
  const len = Number(BigInt("0x" + w(5)));
  const sig = "0x" + h.slice(10 + 64 * 6, 10 + 64 * 6 + len * 2);
  if (sig.length !== 2 + len * 2) return null;
  if (h !== releaseCalldata("0x" + w(0), "0x" + w(1).slice(24), "0x" + w(2), BigInt("0x" + w(3)), sig)) return null;   // canonical only
  return { id: "0x" + w(0), to: "0x" + w(1).slice(24), opNonce: "0x" + w(2), signBefore: BigInt("0x" + w(3)), sig };
}
const asArr = (v, n) => Array.isArray(v) ? v : Array.from({ length: n }, (_, i) => v[i]);
const normRow = (r) => Object.fromEntries(DEPLOYMENT.map(([k, t]) => [k, t === "address" || t === "bytes32" ? lower(r[k]) : t === "bool" ? Boolean(r[k]) : t === "string" ? String(r[k]) : BigInt(r[k]).toString()]));
const normReserve = (r) => Object.fromEntries(RESERVE.map(([k, t]) => [k, t === "address" ? lower(r[k]) : t === "bool" ? Boolean(r[k]) : BigInt(r[k]).toString()]));
const reserveEmpty = (r) => Object.values(r).every((v) => v === false || v === "0" || v === ZERO20);
/** A stable JSON fingerprint (sorted keys) of the parts of the prestate that must survive the release. */
export function canon(v){
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(typeof v === "bigint" ? v.toString() : v);
}
export const prestateHash = (pre) => keccak256Utf8(canon(pre));

/* ---- one coherent fresh read ------------------------------------------------------------------------------------ */
/** Every input to eligibility, read at ONE recent block, whose hash is re-checked at the end (a reorg mid-read throws).
 *  Unreadable or mismatched identity throws ReleaseBlocked; there is no fallback to relay data or older reads. */
export async function readSnapshot(reader, { wallet, vault, id }, nowSec = Math.floor(Date.now() / 1000)){
  wallet = lower(wallet); vault = lower(vault); id = lower(id);
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !/^0x[0-9a-f]{40}$/.test(vault) || !isHex32(id)) throw new ReleaseBlocked("identity", "Malformed wallet, vault or deployment id.");
  const fail = (code, msg) => { throw new ReleaseBlocked(code, msg); };
  const chainId = await reader.chainId();
  if (chainId !== PINS.chainId) fail("chain", "The read endpoint is on chain " + chainId + ", not Base (" + PINS.chainId + ").");
  const b = await reader.latestBlock();
  if (!b || !isHex32(b.hash)) fail("block", "Could not read a recent block.");
  if (Math.abs(nowSec - Number(b.timestamp)) > MAX_BLOCK_AGE_SEC) fail("stale", "The newest block the endpoint returned is " + (nowSec - Number(b.timestamp)) + " s old.");
  const at = b.number;
  const rd = (address, abi, name, args = []) => reader.read(address, abi, name, args, at);
  const [fCode, vCode, lCode, rCode] = await Promise.all([PINS.factory, vault, PINS.ledger, PINS.reserve].map((a) => reader.codeHash(a, at)));
  if (fCode !== PINS.factoryCodeHash) fail("factory-code", "The session vault factory's code is not the reviewed code.");
  if (vCode !== PINS.vaultCodeHash) fail("vault-code", "This vault's code is not the reviewed legacy session vault.");
  if (lCode !== PINS.ledgerCodeHash) fail("ledger-code", "The deployments ledger's code is not the reviewed rev16d code.");
  if (rCode !== PINS.reserveCodeHash) fail("reserve-code", "The gas reserve's code is not the reviewed code.");
  const [vf, vo, vb, isV, vFor, bookLedger, schema, resLedger] = await Promise.all([
    rd(vault, ABI.vault, "factory"), rd(vault, ABI.vault, "owner"), rd(vault, ABI.vault, "book"),
    rd(PINS.factory, ABI.factory, "isVault", [vault]), rd(PINS.factory, ABI.factory, "vaultFor", [wallet]),
    rd(PINS.book, ABI.book, "addr", [bookKey("deployments")]), rd(PINS.ledger, ABI.ledger, "deploymentsSchema"),
    rd(PINS.reserve, ABI.reserve, "ledger")]);
  if (lower(vf) !== PINS.factory) fail("vault-factory", "The vault names a factory other than the reviewed one.");
  if (isV !== true || lower(vFor) !== vault) fail("vault-identity", "The reviewed factory does not recognize this vault as this wallet's.");
  if (lower(vo) !== wallet) fail("vault-owner", "The vault's owner is not the connected wallet.");
  if (lower(vb) !== PINS.book) fail("vault-book", "The vault's address book is not the reviewed one.");
  if (lower(bookLedger) !== PINS.ledger) fail("book-ledger", "The address book's deployments entry is not the reviewed ledger.");
  if (BigInt(schema) !== PINS.ledgerSchema) fail("ledger-schema", "The ledger reports schema " + schema + ", not " + PINS.ledgerSchema + ".");
  if (lower(resLedger) !== PINS.ledger) fail("reserve-binding", "The gas reserve is bound to a different ledger.");
  const L = PINS.ledger;
  const [row, oe, earn, cap, fee, held, oldR, newR, dslot] = await Promise.all([
    rd(L, ABI.ledger, "get", [id]), rd(L, ABI.ledger, "ownerEscrow6", [id]), rd(L, ABI.ledger, "earnOf", [id]),
    rd(L, ABI.ledger, "capOf", [id]), rd(L, ABI.ledger, "feeOf", [id]), rd(vault, ABI.vault, "held", [id]),
    rd(PINS.reserve, ABI.reserve, "reserveOf", [id, vault]), rd(PINS.reserve, ABI.reserve, "reserveOf", [id, wallet]),
    reader.storageAt(PINS.ledger, delegateSlotOf(wallet, vault), at)]);
  const again = await reader.blockByNumber(at);
  if (!again || again.hash !== b.hash) fail("reorg", "The chain reorganized while reading; check again.");
  const e = asArr(earn, 3), f = asArr(fee, 2), h = asArr(held, 3);
  return {
    block: { number: at.toString(), hash: b.hash, timestamp: b.timestamp.toString() },
    identity: { chainId, ledger: L, vault, wallet, deployment: id, owner: wallet },
    pre: {
      row: normRow(row), ownerEscrow6: BigInt(oe).toString(),
      earn: { rate6: BigInt(e[0]).toString(), escrow6: BigInt(e[1]).toString(), creditedUntil: BigInt(e[2]).toString() },
      cap: BigInt(cap).toString(), fee: { recipient: lower(f[0]), rate6: BigInt(f[1]).toString() },
      oldReserve: normReserve(oldR), newReserve: normReserve(newR),
    },
    held: { env: Number(h[0]), promoted: lower(h[1]), createdBy: lower(h[2]) },
    delegationGranted: BigInt(dslot || 0) !== 0n,
  };
}

/* ---- the gate --------------------------------------------------------------------------------------------------- */
const AUTH_OLD = { 1: "Vault-held STAGING: sessions granted staging may change its version/config; production secrets are never released to it.",
  2: "Vault-held PRODUCTION: runs only the version/config the owner promoted; sessions granted prod may run, resize, fund, cap and cancel it, never change what it runs." };

/** Eligibility for this first release path from ONE snapshot. Every blocker is listed, not just the first.
 *  `authority` comes only from wallet-release-census.js evaluateRelease (issued, bound to this snapshot); without it
 *  nothing is eligible. */
export function evaluate(snap, { authority = null, nowSec = Math.floor(Date.now() / 1000) } = {}){
  const { row, ownerEscrow6, earn, oldReserve, newReserve } = snap.pre;
  const { vault, wallet, deployment } = snap.identity;
  const B = [];
  const add = (code, text) => B.push({ code, text });
  if (row.id !== deployment) add("unknown", "The ledger has no record with this id.");
  else if (row.owner === wallet) add("already-wallet", "Your wallet already owns this deployment on the ledger.");
  else if (row.owner !== vault) add("not-vault-owned", "The ledger record is not owned by your vault.");
  if (row.active) add("active", "The app is active. This path never stops it; it can move only while inactive.");
  const attached = row.runner !== ZERO32 || row.runnerOperator !== ZERO20 || row.leaseUntil !== "0";
  if (attached) add("lease", BigInt(row.leaseUntil) > 0n && BigInt(row.leaseUntil) < BigInt(nowSec)
    ? "A host lease is still attached (expired but not released). Wait for the host to release it."
    : "A host runner or lease is attached.");
  if (snap.held.env !== 1 && snap.held.env !== 2) add("held", "Your vault has no valid custody record for it (not adopted).");
  if (ownerEscrow6 !== "0" && earn.escrow6 !== "0") add("escrow", "The ledger refuses the transfer while both owner escrow and runtime escrow are nonzero (\"refund first\"). This path never refunds.");
  if (!reserveEmpty(oldReserve)) add("old-reserve", "Your vault's gas reserve for this app is configured or funded; it does not follow a transfer and needs a coordinated handoff.");
  if (!reserveEmpty(newReserve)) add("new-reserve", "Your wallet already has gas reserve state for this app; merging buckets needs a coordinated handoff.");
  // environment / content (a wallet-held row is PROD to sessions and hosts). STAGING had no promoted-content check at
  // the relay's custody predicate, so none is removed; its session consequences come from the census below.
  const promoted = snap.held.promoted;
  if (snap.held.env === 2 && promoted === ZERO32) add("unpromoted", "It is PRODUCTION but you never promoted its current version; wallet ownership would remove the relay's promotion check without an equivalent approval.");
  else if (snap.held.env === 2 && promoted !== promotedHash(row.appRef, row.configCid)) add("content-drift", "Its current version/config is not the one you promoted.");
  else if (snap.held.env === 2) add("prod-custody", "It is promoted PRODUCTION. Wallet ownership drops the vault's stored promotion comparison, so future content changes are no longer checked against it; this path moves STAGING apps only.");
  // session and delegate authority: the census, never a caller-supplied list
  if (!authority) add("census", "No authority census of your sessions and delegations is attached; nothing can move.");
  else for (const b of authority.blockers || []) add(b.code, b.text);
  const census = authority && authority.census || null;
  const review = {
    deployment, vault, destination: wallet, ledger: snap.identity.ledger, block: snap.block,
    appRef: row.appRef, configCid: row.configCid, isPublic: row.isPublic, ports: row.ports,
    resources: { cpuMilli: row.cpuMilli, gpuMilli: row.gpuMilli, appPort: row.appPort },
    balance6: row.balance6, spent6: row.spent6, rate: row.rate, cap: snap.pre.cap, fee: snap.pre.fee,
    env: snap.held.env, promoted, delegationGranted: snap.delegationGranted,
    authorityBefore: AUTH_OLD[snap.held.env] || "Unadopted: inert to sessions.",
    authorityAfter: "Wallet-held: always PRODUCTION to sessions, reachable through your wallet's ledger delegation (" +
      (snap.delegationGranted ? "currently granted" : "currently not granted") + "); sessions lose setAppRef/setConfig (they can never change its version/config).",
    signature: "One EIP-712 \"Release\" signature (deployment, to = your wallet, one-time nonce, deadline) on your vault's domain; relayed gas-free.",
    sessionAccess: "This grants, revokes and changes no session or delegation. Observed effect on existing ones is listed below.",
    census,
  };
  return { eligible: B.length === 0, blockers: B, review, prestateHash: prestateHash(snap.pre) };
}

/* ---- the SDK's typed data, before the wallet sees it ---------------------------------------------------------------- */
const sameFields = (a, b) => Array.isArray(a) && a.length === b.length && a.every((f, i) => f && f.name === b[i].name && f.type === b[i].type);
/** Throws unless `td` is exactly a Release of `id` to `wallet` on this vault's domain; returns { nonce, deadline, message }. */
export function checkReleaseTypedData(td, { chainId, vault, id, wallet }, nowSec = Math.floor(Date.now() / 1000)){
  const bad = (m) => { throw new ReleaseBlocked("typed-data", "Refused to sign: " + m); };
  if (!td || td.primaryType !== "Release") bad("not a Release.");
  const d = td.domain || {};
  if (Object.keys(d).some((k) => !["name", "version", "chainId", "verifyingContract", "salt"].includes(k)) || d.salt !== undefined) bad("unexpected domain field.");
  if (d.name !== "Enclave Sessions" || d.version !== "1" || Number(d.chainId) !== chainId || lower(d.verifyingContract) !== lower(vault)) bad("wrong domain.");
  const types = td.types || {};
  if (Object.keys(types).some((k) => k !== "Release" && k !== "EIP712Domain") || !sameFields(types.Release, RELEASE_TYPE)) bad("wrong Release type.");
  const m = td.message || {};
  if (Object.keys(m).sort().join() !== "deployment,opNonce,signBefore,to") bad("unexpected message fields.");
  if (lower(m.deployment) !== lower(id)) bad("wrong deployment.");
  if (lower(m.to) !== lower(wallet)) bad("destination is not your wallet.");
  if (!isHex32(m.opNonce) || lower(m.opNonce) === ZERO32) bad("malformed nonce.");
  let dl; try { dl = BigInt(m.signBefore); } catch(e){ bad("malformed deadline."); }
  if (dl <= BigInt(nowSec) || dl > BigInt(nowSec + MAX_SIGN_WINDOW_SEC)) bad("deadline out of range.");
  return { nonce: lower(m.opNonce), deadline: dl.toString(),
    message: { deployment: lower(m.deployment), to: lower(m.to), opNonce: lower(m.opNonce), signBefore: dl.toString() } };
}

/* ---- read-only outcome verification ----------------------------------------------------------------------------- */
/** What the chain says about one journaled release. Never signs, never sends. Returns
 *  { status: "pending"|"included"|"finalized"|"conflict"|"unresolved", txHash?, block?, reasons[] }. */
export async function verifyOutcome(reader, rec){
  const I = rec.identity, R = [];
  if (await reader.chainId() !== I.chainId) return { status: "unresolved", reasons: ["read endpoint is on another chain"] };
  let txHash = rec.txHash && isHex32(rec.txHash) ? lower(rec.txHash) : null;
  if (!txHash){
    const latest = await reader.latestBlock();
    const from = BigInt(rec.startBlock), end = from + SCAN_SPAN < latest.number ? from + SCAN_SPAN : latest.number;
    const found = new Set();
    for (let lo = from; lo <= end; lo += SCAN_CHUNK){
      const hi = lo + SCAN_CHUNK - 1n < end ? lo + SCAN_CHUNK - 1n : end;
      const logs = await reader.logs({ address: I.vault, topics: [TOPIC_VAULT_RELEASED, lower(I.deployment)], fromBlock: lo, toBlock: hi });
      for (const l of logs || []) found.add(lower(l.transactionHash));
    }
    const mine = [];
    for (const h of found){ const t = await reader.tx(h); const c = t && decodeReleaseCalldata(t.input); if (c && c.opNonce === rec.nonce) mine.push(h); }
    if (mine.length > 1) return { status: "conflict", reasons: ["more than one transaction carries this nonce"] };
    if (!mine.length){
      const used = await reader.read(I.vault, ABI.vault, "ownerNonceUsed", [rec.nonce], latest.number).catch(() => null);
      if (used === true) return { status: "conflict", reasons: ["nonce is used on-chain but no matching Released transaction was found in the scanned range"] };
      return { status: "unresolved", reasons: ["no transaction with this nonce found in blocks " + from + "-" + end +
        (BigInt(latest.timestamp) > BigInt(rec.deadline) ? " (deadline passed; this is NOT permission to sign again)" : "")] };
    }
    txHash = mine[0];
  }
  const [tx, rc] = await Promise.all([reader.tx(txHash), reader.receipt(txHash)]);
  if (!tx || !rc) return { status: "pending", txHash, reasons: ["no receipt yet (or reorged out)"] };
  const c = decodeReleaseCalldata(tx.input);
  if (lower(tx.to) !== I.vault || !c) R.push("transaction is not a release call to your vault");
  else {
    if (c.id !== I.deployment || c.to !== I.wallet) R.push("calldata names another deployment or destination");
    if (c.opNonce !== rec.nonce || c.signBefore.toString() !== rec.deadline) R.push("calldata nonce/deadline differ from the signed release");
    if (rec.sigHash && keccak256Hex(c.sig) !== rec.sigHash) R.push("calldata signature differs from the one this browser obtained");
  }
  const ok = rc.status === "success" || rc.status === 1 || rc.status === "0x1";
  if (!ok) R.push("receipt status is failure");
  const canonB = await reader.blockByNumber(rc.blockNumber);
  if (!canonB) return { status: "pending", txHash, reasons: ["receipt block not readable yet"] };
  if (canonB.hash !== lower(rc.blockHash)) return { status: "pending", txHash, reasons: ["receipt block is no longer canonical (reorg)"] };
  const logs = (rc.logs || []).map((l) => ({ a: lower(l.address), t: (l.topics || []).map(lower), d: lower(l.data) }));
  const relLog = logs.filter((l) => l.a === I.vault && l.t[0] === TOPIC_VAULT_RELEASED && l.t[1] === I.deployment);
  if (relLog.length !== 1 || relLog[0].d !== "0x" + pad32(I.wallet)) R.push("no exact vault Released(id, wallet) event");
  const trLog = logs.filter((l) => l.a === I.ledger && l.t[0] === TOPIC_TRANSFERRED && l.t[1] === I.deployment);
  if (trLog.length !== 1 || trLog[0].t[2] !== "0x" + pad32(I.vault) || trLog[0].t[3] !== "0x" + pad32(I.wallet)) R.push("no exact ledger DeploymentTransferred(id, vault, wallet) event");
  if (R.length) return { status: "conflict", txHash, reasons: R };
  // poststate at the inclusion block: only owner and held bookkeeping may differ
  const at = BigInt(rc.blockNumber), L = I.ledger;
  const rd = (a, abi, n, args) => reader.read(a, abi, n, args, at);
  const [used, held, row, oe, earn, cap, fee, oldR, newR] = await Promise.all([
    rd(I.vault, ABI.vault, "ownerNonceUsed", [rec.nonce]), rd(I.vault, ABI.vault, "held", [I.deployment]),
    rd(L, ABI.ledger, "get", [I.deployment]), rd(L, ABI.ledger, "ownerEscrow6", [I.deployment]), rd(L, ABI.ledger, "earnOf", [I.deployment]),
    rd(L, ABI.ledger, "capOf", [I.deployment]), rd(L, ABI.ledger, "feeOf", [I.deployment]),
    rd(PINS.reserve, ABI.reserve, "reserveOf", [I.deployment, I.vault]), rd(PINS.reserve, ABI.reserve, "reserveOf", [I.deployment, I.wallet])]);
  const h = asArr(held, 3), e = asArr(earn, 3), f = asArr(fee, 2);
  if (used !== true) R.push("ownerNonceUsed(nonce) is not set");
  if (Number(h[0]) !== 0 || lower(h[1]) !== ZERO32 || lower(h[2]) !== ZERO32) R.push("the vault still has a custody record");
  const post = { row: normRow(row), ownerEscrow6: BigInt(oe).toString(),
    earn: { rate6: BigInt(e[0]).toString(), escrow6: BigInt(e[1]).toString(), creditedUntil: BigInt(e[2]).toString() },
    cap: BigInt(cap).toString(), fee: { recipient: lower(f[0]), rate6: BigInt(f[1]).toString() },
    oldReserve: normReserve(oldR), newReserve: normReserve(newR) };
  if (post.row.owner !== I.wallet) R.push("ledger owner is not your wallet");
  const expect = { ...rec.prestate, row: { ...rec.prestate.row, owner: I.wallet } };
  if (canon(post) !== canon(expect)) R.push("deployment, escrow, cap, fee or reserve state differs from before the release (an external change, or not this release)");
  if (R.length) return { status: "conflict", txHash, block: at.toString(), reasons: R };
  const fin = await reader.blockByNumber("finalized").catch(() => null);
  const final = fin && fin.number >= at;
  return { status: final ? "finalized" : "included", txHash, block: at.toString(), blockHash: lower(rc.blockHash),
    reasons: [final ? "included and at or below the finalized block" : "included; not finalized yet (a reorg could still remove it)"] };
}
