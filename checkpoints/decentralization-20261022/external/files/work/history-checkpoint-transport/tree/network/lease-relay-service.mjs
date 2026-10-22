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
//   [LEASE_RELAY_MIN_FLOAT_ETH=0.001] [LEASE_RELAY_QUORUM=n]   node network/lease-relay-service.mjs
// Put it behind TLS (hosts accept only https relays, except loopback fixtures).
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseDeploymentRecord } from "./lease-gas-owner.mjs";
import { startLeaseRelay } from "./lease-executor-client.mjs";
import { leaseRpcSet } from "./lease-executor-authority.mjs";

function readKeyFile(file) {
  const st = fs.statSync(file);
  if (process.platform !== "win32" && (st.mode & 0o077)) throw new Error(`${file} must be readable by its owner only (chmod 600)`);
  const k = fs.readFileSync(file, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${file} does not hold one 32-byte hex key`);
  return k.startsWith("0x") ? k : `0x${k}`;
}

/** Start the relay service from explicit settings (the CLI entry below maps the environment onto these). */
export async function startRelayService({ recordFile, digest, rpcs, keyFile, listen = "127.0.0.1:0", maxFloatEth, minFloatEth = "0.001", quorum,
  allowLoopbackHttp = false, readFile = fs.readFileSync, log = (m) => console.log(m), checkEveryMs = 60_000, relayOptions = {} }) {
  if (!recordFile || !digest) throw new Error("the relay needs the reviewed deployment record and its digest (LEASE_RELAY_RECORD, LEASE_RELAY_DIGEST)");
  if (!maxFloatEth) throw new Error("the relay needs LEASE_RELAY_MAX_FLOAT_ETH: the most this hot key may hold (a small float)");
  const deployment = parseDeploymentRecord(readFile(recordFile), { expectedDigest: digest });
  const chain = defineChain({ id: deployment.chainId, name: `chain-${deployment.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcs[0]] } } });
  const clients = rpcs.map((url) => createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 10_000 }) }));
  leaseRpcSet(clients, { quorum, allowLoopbackHttp });                 // the identity/threshold rules, before anything else
  const account = privateKeyToAccount(readKeyFile(keyFile));
  const maxFloat = parseEther(String(maxFloatEth)), minFloat = parseEther(String(minFloatEth));
  if (minFloat >= maxFloat) throw new Error("the minimum float must be below the maximum");
  // the balance, as every configured RPC reports it: the highest answer counts against the cap
  const balance = async () => (await Promise.all(clients.map((c) => c.getBalance({ address: account.address })))).reduce((m, x) => (x > m ? x : m), 0n);
  const b0 = await balance();
  if (b0 > maxFloat) throw new Error(`relay key ${account.address} holds ${formatEther(b0)} ETH, above its ${maxFloatEth} ETH float cap: move the excess out first`);
  const [host, port] = String(listen).split(/:(?=\d+$)/);
  const wallet = createWalletClient({ chain, account, transport: http(rpcs[0], { retryCount: 0, timeout: 15_000 }) });
  const relay = await startLeaseRelay({ client: clients[0], clients, wallet, deployment, quorum, allowLoopbackHttp, host, port: Number(port || 0), log, ...relayOptions });
  let low = b0 < minFloat;
  const check = async () => { try { const b = await balance(); low = b < minFloat; if (b > maxFloat) log(`[relay] WARNING: ${formatEther(b)} ETH above the float cap`);
    if (low) log(`[relay] WARNING: ${formatEther(b)} ETH is below the ${minFloatEth} ETH minimum float: refill`); } catch {} };
  const timer = setInterval(check, checkEveryMs); timer.unref?.();
  log(`[relay] serving reserve ${deployment.reserve} (executor ${deployment.executor}) on ${relay.url}; payee ${account.address}; float ${formatEther(b0)} ETH (cap ${maxFloatEth}, min ${minFloatEth})${low ? " - BELOW MINIMUM: refill before it can relay" : ""}`);
  return { url: relay.url, payee: account.address, deployment, isLow: () => low, close: async () => { clearInterval(timer); await relay.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const e = process.env;
  startRelayService({ recordFile: e.LEASE_RELAY_RECORD, digest: e.LEASE_RELAY_DIGEST, rpcs: String(e.LEASE_RELAY_RPCS || "").split(",").map((s) => s.trim()).filter(Boolean),
    keyFile: e.LEASE_RELAY_KEY_FILE, listen: e.LEASE_RELAY_LISTEN || "127.0.0.1:0", maxFloatEth: e.LEASE_RELAY_MAX_FLOAT_ETH, minFloatEth: e.LEASE_RELAY_MIN_FLOAT_ETH || "0.001",
    quorum: e.LEASE_RELAY_QUORUM ? Number(e.LEASE_RELAY_QUORUM) : undefined })
    .catch((err) => { console.error(`[relay] not started: ${err.message}`); process.exit(1); });
}
