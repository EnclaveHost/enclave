// The public-rpc role's configuration rules and method lists (network/public-rpc.mjs is the server). Kept apart from the
// server module so that network/host-services/roles.mjs - bundled into the runner and the privacy agent - carries the
// validator only: no HTTP server and no "am I the main module?" check of its own (network/host-services/argv-guard.mjs).
import { rpcEndpoint } from './rpc-identity.mjs';

export const ROLE = 'public-rpc';
// the browser note's methods (NOTE-BROWSER-RPC-ENDPOINT-REQUIREMENTS.md) plus the explicit raw submission; the server's
// parameter checks must cover exactly these (network/public-rpc.mjs asserts it at load)
export const SERVED_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_estimateGas', 'eth_getCode', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_getStorageAt', 'eth_getLogs', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_sendRawTransaction']);
const HASH = /^0x[0-9a-fA-F]{64}$/;
// what the local verifier can answer from proofs at a pinned block (network/verified-chain.mjs pinnedClient)
export const VERIFIABLE_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance']);
// refused by NAME (never forwarded): node administration, debugging, wallets, signing, mempool and server-side filters
export const FORBIDDEN = /^(admin|debug|personal|miner|txpool|clique|engine|parity|trace|ots|anvil|hardhat|evm|wallet|rpc)_|^eth_(sign|signTransaction|signTypedData.*|sendTransaction|accounts|coinbase|mining|hashrate|submitWork|submitHashrate|getWork|newFilter|newBlockFilter|newPendingTransactionFilter|getFilterChanges|getFilterLogs|uninstallFilter|subscribe|unsubscribe|getProof|createAccessList|simulateV1|callMany)$/;
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const fail = (m) => { throw new Error(`public-rpc: ${m}`); };
const SECRETISH = /(secret|token|password|passwd|private|mnemonic|seed|apikey|api_key|auth|hmac|credential|key$|keyfile)/i;
const FIELDS = ['port', 'bind', 'hostId', 'chainId', 'node', 'chainVerifier', 'verifiedMethods', 'allowedOrigins', 'maxHeadAgeSec', 'rawTransactions', 'limits'];
const LIMITS = Object.freeze({ maxBodyBytes: [1024, 1 << 20, 128 << 10], maxResponseBytes: [64 << 10, 16 << 20, 4 << 20], backendTimeoutMs: [500, 30000, 6000],
  maxInFlight: [1, 256, 16], perSecond: [1, 10000, 50], burst: [1, 20000, 100], maxLogRange: [1, 10000, 2000] });

function loopbackUrl(v, what) {
  let e; try { e = rpcEndpoint(v); } catch (x) { fail(`${what}: ${x.message}`); }
  if (!e.loopback) fail(`${what} must be this machine's own endpoint (loopback): a remote server would make this role a proxy`);
  return String(v);
}

/** -> the normalized configuration; throws on anything else. No field may hold a secret. */
export function validatePublicRpcConfig(c) {
  if (!plain(c)) fail('config must be an object');
  for (const k of Object.keys(c)) if (!FIELDS.includes(k)) fail(`unknown config field ${JSON.stringify(k)}${SECRETISH.test(k) ? ' (the role holds no secret)' : ''}`);
  for (const k of ['port', 'bind', 'hostId', 'chainId', 'node', 'allowedOrigins']) if (c[k] === undefined || c[k] === null || c[k] === '') fail(`${k} is required`);
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) fail('port must be a port');
  // the ingress reaches roles on loopback only (host-service-ingress.mjs serviceTable)
  if (!['127.0.0.1', '::1'].includes(c.bind)) fail('bind must be loopback (127.0.0.1 or ::1): the public reaches it only through the host-service ingress');
  if (!HASH.test(String(c.hostId)) || /^0x0{64}$/.test(c.hostId)) fail('hostId must be this host\'s registry id');
  if (!Number.isSafeInteger(c.chainId) || c.chainId <= 0) fail('chainId is required');
  const node = loopbackUrl(c.node, 'node');
  let verifier = null, verifiedMethods = [];
  if (c.chainVerifier !== undefined || c.verifiedMethods !== undefined) {
    verifier = loopbackUrl(c.chainVerifier, 'chainVerifier');
    if (rpcEndpoint(verifier).url.href === rpcEndpoint(node).url.href) fail('chainVerifier is the node itself: an unverified node is not a verifier');
    if (!Array.isArray(c.verifiedMethods) || !c.verifiedMethods.length || c.verifiedMethods.some((m) => !VERIFIABLE_METHODS.includes(m)) || new Set(c.verifiedMethods).size !== c.verifiedMethods.length)
      fail(`verifiedMethods: the methods the verifier answers from proofs, a subset of ${VERIFIABLE_METHODS.join(', ')}`);
    verifiedMethods = [...c.verifiedMethods];
  }
  const origins = c.allowedOrigins;
  if (!Array.isArray(origins) || !origins.length || origins.length > 16) fail('allowedOrigins: 1 to 16 dashboard origins, or ["*"]');
  const allowed = origins[0] === '*' && origins.length === 1 ? '*' : origins.map((o, i) => {
    let u; try { u = new URL(o); } catch { fail(`allowedOrigins[${i}] is not a URL`); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local)) || u.username || u.password || u.search || u.hash || u.pathname !== '/')
      fail(`allowedOrigins[${i}] must be a bare https origin (http only on localhost)`);
    return u.origin;
  });
  const maxHeadAgeSec = c.maxHeadAgeSec ?? 120;
  if (!Number.isInteger(maxHeadAgeSec) || maxHeadAgeSec < 10 || maxHeadAgeSec > 3600) fail('maxHeadAgeSec: 10 to 3600');
  let rawTransactions = null;
  if (c.rawTransactions !== undefined) {
    if (!plain(c.rawTransactions) || Object.keys(c.rawTransactions).some((k) => k !== 'propagation') || typeof c.rawTransactions.propagation !== 'string'
      || c.rawTransactions.propagation.length < 8 || c.rawTransactions.propagation.length > 200 || /[\u0000-\u001f]/.test(c.rawTransactions.propagation))
      fail('rawTransactions: { propagation: "<how the operator\'s node propagates a raw transaction (8-200 characters)>" } - omit it to refuse submissions');
    rawTransactions = { propagation: c.rawTransactions.propagation };
  }
  const limits = {};
  if (c.limits !== undefined && !plain(c.limits)) fail('limits must be an object');
  // own properties only: an inherited name (constructor, toString, __proto__) is unknown, never a limit
  for (const k of Object.keys(c.limits || {})) if (!Object.hasOwn(LIMITS, k)) fail(`limits: unknown field ${JSON.stringify(k)}`);
  for (const [k, [lo, hi, def]] of Object.entries(LIMITS)) {
    const v = (c.limits || {})[k] ?? def;
    if (!Number.isInteger(v) || v < lo || v > hi) fail(`limits.${k}: ${lo} to ${hi}`);
    limits[k] = v;
  }
  if (limits.burst < limits.perSecond) fail('limits.burst must be at least limits.perSecond');
  return { port: c.port, bind: c.bind, hostId: c.hostId.toLowerCase(), chainId: c.chainId, node, ...(verifier ? { chainVerifier: verifier, verifiedMethods } : {}),
    allowedOrigins: allowed === '*' ? ['*'] : allowed, maxHeadAgeSec, ...(rawTransactions ? { rawTransactions } : {}), limits };
}

