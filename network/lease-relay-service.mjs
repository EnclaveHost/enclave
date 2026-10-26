// network/lease-relay-service.mjs - a permissionless lease relay as a service (design B). Anyone may run one; it pays
// the gas of lease operations for the ONE reviewed reserve/executor deployment and is reimbursed by the app's reserve in
// the same transaction (client/lease-executor-client.mjs startLeaseRelay: pinned record + RPC quorum before every spend,
// canonical lease calls only, bounded bodies/time/concurrency, one send at a time per key).
//
// SMALL FLOAT by construction: the relay key holds only what a few in-flight operations need. It refuses to START with
// more than LEASE_RELAY_MAX_FLOAT_ETH and warns above it later; below LEASE_RELAY_MIN_FLOAT_ETH it warns that it needs a
// refill (its own sends then fail before broadcast and hosts fail over to another relay). A compromise of the box can
// lose the funded float. Successful operations reimburse it atomically; reverted or raced transactions still cost
// the relay gas even after preflight simulation, so monitor losses and do not refill automatically.
// The key is read from a 0600 file, never from the environment.
//
//   LEASE_RELAY_RECORD=FILE LEASE_RELAY_DIGEST=sha256:… LEASE_RELAY_RPCS=https://a,https://b[,…]
//   LEASE_RELAY_KEY_FILE=/path/0600 LEASE_RELAY_LISTEN=127.0.0.1:8545x LEASE_RELAY_MAX_FLOAT_ETH=0.02
//   LEASE_RELAY_STATE=/var/lib/…/relay-send.json [LEASE_RELAY_MIN_FLOAT_ETH=0.001] [LEASE_RELAY_QUORUM=n]
//   [LEASE_RELAY_DESCRIPTOR=<its service-index descriptor file>]   node network/lease-relay-service.mjs
// RPCs: name three independent providers with a quorum of two - any one may be down or wrong. Nothing depends on the
// first one: reads, simulation, broadcast and receipts all go through the quorum; a send whose reply is lost is
// re-broadcast as the SAME signed bytes, never re-signed. LEASE_RELAY_STATE (required by the CLI: a writable file on
// durable storage, the unit's StateDirectory) keeps those bytes across a restart; it holds only this key's own send.
// Put it behind TLS (hosts accept only https relays, except loopback fixtures).
//
// LOCAL VERIFIER AUTHORITY (instead of LEASE_RELAY_RPCS / LEASE_RELAY_QUORUM; one or the other, never both, never a fallback):
//   ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:<port>/ ENCLAVE_CHAIN_TX_BACKEND=http://<loopback
//   or private IPv4 literal>:<port>/   (network/chain-authority.mjs)
// The relay's ONE chain client is then the operator's local verifier: the pinned deployment, the float balance, the request
// checks, the simulation and the account nonce are state proven against its sequencer-signed head chain (the unsafe tier, no
// L1 finality), and a lease counts as landed only by a receipt the verifier checked. The signed bytes are submitted ONCE,
// to the operator's own backend only, after it is bound to the verifier's head (actionGate: head at most 60 s old, the
// backend holds the verifier's head block); an unbound, behind or missing backend refuses BEFORE anything is signed. What
// the backend answers is never evidence: an acknowledged submission is "accepted", a lost or failed one (e.g. the backend's
// sequencer forwarding failed) is "unknown" and keeps its bytes for re-broadcast; only a verified receipt is success.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, http, parseEther, formatEther, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseDeploymentRecord } from "./lease-gas-owner.mjs";
import { startLeaseRelay } from "./lease-executor-client.mjs";
import { leaseRpcSet, verifiedLeaseAuthority } from "./lease-executor-authority.mjs";
import { chainAuthorityFromEnv, AUTHORITY_ENV, VERIFIER_ENV, TX_BACKEND_ENV } from "./chain-authority.mjs";

function readKeyFile(file) {
  const st = fs.statSync(file);
  if (process.platform !== "win32" && (st.mode & 0o077)) throw new Error(`${file} must be readable by its owner only (chmod 600)`);
  const k = fs.readFileSync(file, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${file} does not hold one 32-byte hex key`);
  return k.startsWith("0x") ? k : `0x${k}`;
}

const CHAIN_NAMES = [AUTHORITY_ENV, VERIFIER_ENV, TX_BACKEND_ENV];
/** The relay's chain access as the operator selected it: EXACTLY one of the provider quorum (rpcs [+ quorum]) or, with
 *  chainEnv[ENCLAVE_CHAIN_AUTHORITY] = verifier, the local verifier and the own transaction backend. -> "verifier" | "quorum".
 *  Mixed, incomplete or unknown selections throw; nothing falls back to the other. */
export function relayChainMode({ chainEnv = null, rpcs = [], quorum } = {}) {
  const v = (k) => String(chainEnv?.[k] ?? "").trim();
  const a = v(AUTHORITY_ENV);
  if (a && a !== "quorum" && a !== "verifier") throw new Error(`${AUTHORITY_ENV} must be quorum or verifier`);
  if (a !== "verifier") {
    for (const k of [VERIFIER_ENV, TX_BACKEND_ENV]) if (v(k)) throw new Error(`${k} is set but ${AUTHORITY_ENV} is not verifier: refused (no mixed or implicit selection)`);
    if (!rpcs?.length) throw new Error(`the relay needs its chain access: LEASE_RELAY_RPCS (+ LEASE_RELAY_QUORUM), or ${AUTHORITY_ENV}=verifier with ${VERIFIER_ENV} and ${TX_BACKEND_ENV}`);
    return "quorum";
  }
  if (rpcs?.length || (quorum !== undefined && quorum !== null))
    throw new Error(`${AUTHORITY_ENV}=verifier: LEASE_RELAY_RPCS / LEASE_RELAY_QUORUM must not be set with it (the relay reads, simulates, submits and confirms through ONE authority, the local verifier and its own backend; never mixed with providers, never a fallback)`);
  if (!v(VERIFIER_ENV)) throw new Error(`${AUTHORITY_ENV}=verifier needs ${VERIFIER_ENV} (the local verifier URL)`);
  if (!v(TX_BACKEND_ENV)) throw new Error(`${AUTHORITY_ENV}=verifier needs ${TX_BACKEND_ENV}: a relay submits, and only through the operator's own backend`);
  return "verifier";
}

/** Start the relay service from explicit settings (the CLI entry below maps the environment onto these).
 *  chainEnv: the ENCLAVE_CHAIN_* selection (relayChainMode); authorityOptions: createChainAuthority's tunables (tests). */
export async function startRelayService({ recordFile, digest, rpcs = [], keyFile, listen = "127.0.0.1:0", maxFloatEth, minFloatEth = "0.001", quorum,
  allowLoopbackHttp = false, readFile = fs.readFileSync, log = (m) => console.log(m), checkEveryMs = 60_000, stateFile = null, descriptorFile = null, relayOptions = {},
  chainEnv = null, authorityOptions = {} }) {
  const mode = relayChainMode({ chainEnv, rpcs, quorum });               // before the record, the key or any network
  if (!recordFile || !digest) throw new Error("the relay needs the reviewed deployment record and its digest (LEASE_RELAY_RECORD, LEASE_RELAY_DIGEST)");
  if (!maxFloatEth) throw new Error("the relay needs LEASE_RELAY_MAX_FLOAT_ETH: the most this hot key may hold (a small float)");
  const deployment = parseDeploymentRecord(readFile(recordFile), { expectedDigest: digest });
  const chain = defineChain({ id: deployment.chainId, name: `chain-${deployment.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: rpcs.slice(0, 1) } } });
  // verifier: ONE client (marked LOCAL_VERIFIER, so leaseRpcSet uses it alone, required 1); every method routed by
  // network/chain-authority.mjs (proven state and receipts from the verifier; eth_sendRawTransaction to the bound backend only)
  const authority = mode === "verifier" ? chainAuthorityFromEnv(Object.fromEntries(CHAIN_NAMES.map((k) => [k, chainEnv[k]])), { chain, ...authorityOptions }) : null;
  const clients = authority ? [authority.client]
    : rpcs.map((url) => createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 10_000 }) }));
  const rpc = leaseRpcSet(clients, { quorum, allowLoopbackHttp });     // the identity/threshold rules, before anything else
  if (authority && rpc.authority !== "local-verifier") throw new Error("the relay's verifier client was not taken as the local verifier authority");
  const account = privateKeyToAccount(readKeyFile(keyFile));
  const maxFloat = parseEther(String(maxFloatEth)), minFloat = parseEther(String(minFloatEth));
  if (minFloat >= maxFloat) throw new Error("the minimum float must be below the maximum");
  // the balance as the QUORUM agrees on it at one verified anchor block (a provider that is down, or answers another
  // chain, block or value, is outvoted, not obeyed): one failed provider of three neither blocks startup nor decides it.
  // Under the verifier: its account proof at the verified block (one authority, required 1)
  const balance = async () => {
    const v = await verifiedLeaseAuthority({ clients, deployment, quorum, allowLoopbackHttp, confirmations: relayOptions.confirmations ?? 0, now: relayOptions.now });
    const r = await rpc.agree(rpc.peers, async (p) => BigInt(await rpc.request(p.client, "eth_getBalance", [account.address, { blockHash: v.block.hash, requireCanonical: true }])),
      "the relay key's balance");
    return r.value;
  };
  const b0 = await balance();
  if (b0 > maxFloat) throw new Error(`relay key ${account.address} holds ${formatEther(b0)} ETH, above its ${maxFloatEth} ETH float cap: move the excess out first`);
  const [host, port] = String(listen).split(/:(?=\d+$)/);
  // the key and the chain only, with no transport: every read, the simulation, the broadcast (the same signed bytes to
  // EVERY provider) and the receipt go through the quorum (client/lease-executor-client.mjs relayLease); under the verifier
  // through its one client, and the submission is gated first (submitGate: nothing is signed while the gate refuses)
  const wallet = { account, chain };
  const submitGate = authority ? () => authority.actionGate({ what: "lease relay submission", submit: true }) : null;
  if (authority) {
    // not fatal at start (a backend still syncing must not exhaust the unit's restart budget): every request is gated
    await authority.actionGate({ what: "relay start", submit: true })
      .then(() => log(`[relay] chain authority: local verifier ${authority.describe().verifier}, own backend ${authority.describe().backend.label} bound at the verifier's head`))
      .catch((e) => log(`[relay] WARNING: ${e.message} (leases are refused before signing until the gate passes)`));
  }
  // a designated relay's service-index descriptor (served at /v1/descriptor; the advertisement commits to its sha256)
  const descriptor = descriptorFile ? readFile(descriptorFile) : null;
  if (descriptor && (descriptor.length > 4096 || JSON.parse(descriptor.toString("utf8")).payee?.toLowerCase() !== account.address.toLowerCase()))
    throw new Error("LEASE_RELAY_DESCRIPTOR must be this relay's own descriptor (at most 4096 bytes, naming this key's address as payee)");
  const relay = await startLeaseRelay({ client: clients[0], clients, wallet, deployment, quorum, allowLoopbackHttp, host, port: Number(port || 0), log, stateFile, descriptor, ...relayOptions, submitGate });
  let low = b0 < minFloat;
  const check = async () => { try { const b = await balance(); low = b < minFloat; if (b > maxFloat) log(`[relay] WARNING: ${formatEther(b)} ETH above the float cap`);
    if (low) log(`[relay] WARNING: ${formatEther(b)} ETH is below the ${minFloatEth} ETH minimum float: refill`); } catch {} };
  const timer = setInterval(check, checkEveryMs); timer.unref?.();
  log(`[relay] serving reserve ${deployment.reserve} (executor ${deployment.executor}) on ${relay.url}; payee ${account.address}; float ${formatEther(b0)} ETH (cap ${maxFloatEth}, min ${minFloatEth})${low ? " - BELOW MINIMUM: refill before it can relay" : ""}`);
  return { url: relay.url, payee: account.address, deployment, isLow: () => low, mode,
    chainAuthority: authority ? authority.describe() : { authority: "rpc-quorum", peers: rpc.peers.length, quorum: rpc.required },
    authorityStatus: () => authority?.status() ?? null, close: async () => { clearInterval(timer); await relay.close(); } };
}

// the CLI entry: this module's URL is exactly the path it was started by (a Windows drive path too, once encoded as a
// file URL; on Linux a release run through a symlink still needs --preserve-symlinks-main, as the unit does)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = process.env;
  if (!e.LEASE_RELAY_STATE) { console.error("[relay] not started: LEASE_RELAY_STATE is not set (the durable record of this key's unresolved send; there is no default)"); process.exit(1); }
  startRelayService({ recordFile: e.LEASE_RELAY_RECORD, digest: e.LEASE_RELAY_DIGEST, rpcs: String(e.LEASE_RELAY_RPCS || "").split(",").map((s) => s.trim()).filter(Boolean),
    keyFile: e.LEASE_RELAY_KEY_FILE, listen: e.LEASE_RELAY_LISTEN || "127.0.0.1:0", maxFloatEth: e.LEASE_RELAY_MAX_FLOAT_ETH, minFloatEth: e.LEASE_RELAY_MIN_FLOAT_ETH || "0.001",
    quorum: String(e.LEASE_RELAY_QUORUM ?? "").trim() ? Number(e.LEASE_RELAY_QUORUM) : undefined, stateFile: e.LEASE_RELAY_STATE, descriptorFile: e.LEASE_RELAY_DESCRIPTOR || null,
    chainEnv: Object.fromEntries(CHAIN_NAMES.map((k) => [k, e[k]])) })
    .catch((err) => { console.error(`[relay] not started: ${err.message}`); process.exit(1); });
}
