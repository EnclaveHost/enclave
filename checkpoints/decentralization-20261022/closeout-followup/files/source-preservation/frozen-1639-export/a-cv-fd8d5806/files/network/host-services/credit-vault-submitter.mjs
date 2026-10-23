// The credit-vault submission relay as an Enclave HOST-SERVICE ROLE, registered in network/host-services/roles.mjs and run by
// network/host-services/runner.mjs from its pinned package (scripts/build-host-service-packages.mjs; bundle entry
// network/host-services/entries/credit-vault-submitter.mjs behind the argv guard). Service-index kind 8
// "credit-vault-submitter" (network/service-index.mjs; outside the default listing, like policy). Not an ordinary server: the
// process refuses DigitalOcean machines (transport-only by placement rule), and the host operator advertises it in the
// ownerless EnclaveServiceIndex as an untrusted candidate (runner.mjs advertise).
//
// Why a host role and not an Enclave app: an Enclave app is a WebAssembly component (isolation/contract/RUNTIME.md); this is
// a Node program (node:http, viem). What fits it to an Enclave host is that it holds NO authority: it submits a signed
// request's exact bytes or refuses it, the vault (or the reserve) is the verifier, and the client reads the outcome from
// the chain, never from this service. Gas is paid by the operator's OWN external signer (a loopback JSON-RPC wallet such as
// Clef: cli/independent-signer.mjs sign mode), so the role's configuration and process hold no key. The runner's heapMiB is
// the role's V8 heap cap; the role adds no memory field of its own.
import path from 'node:path';
import { rpcEndpoint } from '../rpc-identity.mjs';
import { chainVerifierOf } from '../verified-chain.mjs';
import { parseReceiptSourceConfig, createReceiptSource } from '../receipt-source.mjs';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const fail = (m) => { throw new Error(`credit-vault-submitter: ${m}`); };
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
// the same credential-name refusal the host-service roles apply (a field that looks like a secret is refused outright)
const SECRETISH = /(secret|token|password|passwd|private|mnemonic|seed|apikey|api_key|auth|hmac|credential|key$|keyfile)/i;
const FIELDS = ['port', 'bind', 'stateDir', 'rpc', 'quorum', 'confirmations', 'signer', 'from', 'chainId', 'pins', 'maxFeeGwei', 'perMinute', 'reserveRecord', 'reserveRecordSha256',
  'chainVerifier', 'receiptSource', 'outcomeTimeoutSec'];

/**
 * -> the normalized configuration; throws on anything else. No field may hold a secret. Two state authorities:
 *   * provider quorum (legacy, compatible): rpc = 2 to 8 Base RPC providers that must AGREE at a block (agreement, not
 *     proof); state, sends and receipts all come from them;
 *   * chainVerifier: the operator's LOCAL proof-backed verifier (loopback) answers every state read and simulation; rpc is
 *     then only the explicit transaction transport (1 to 8 endpoints, e.g. the operator's own node), never state, and no
 *     public provider list is required. Optional receiptSource (with chainVerifier only): the inline
 *     enclave-receipt-source/v1 config of the local L1 pair + Base node (network/receipt-source.mjs, worker E's adapters);
 *     its test-fixture identities are refused unless a test harness set ENCLAVE_TEST_RECEIPT_FIXTURE=1 (the host-service
 *     runner passes no environment, so never through it).
 */
export function validateSubmitterConfig(c, { env = process.env } = {}) {
  if (!plain(c)) fail('config must be an object');
  for (const k of Object.keys(c)) if (!FIELDS.includes(k)) fail(`unknown config field ${JSON.stringify(k)}${SECRETISH.test(k) ? ' (the role holds no secret)' : ''}`);
  for (const k of ['port', 'bind', 'stateDir', 'rpc', 'signer', 'from', 'chainId']) if (c[k] === undefined || c[k] === null || c[k] === '') fail(`${k} is required`);
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) fail('port must be a port');
  if (typeof c.bind !== 'string' || !/^(127\.0\.0\.1|0\.0\.0\.0|::|::1|(\d{1,3}\.){3}\d{1,3})$/.test(c.bind)) fail('bind must be an IP literal');
  if (typeof c.stateDir !== 'string' || !path.isAbsolute(c.stateDir)) fail('stateDir must be an absolute path');
  let chainVerifier = null;
  if (c.chainVerifier !== undefined) {
    try { chainVerifier = chainVerifierOf({ chainAuthority: 'verifier', chainVerifier: c.chainVerifier }, 'chainVerifier'); } catch (x) { fail(x.message); }
    if (!Array.isArray(c.rpc) || c.rpc.length < 1 || c.rpc.length > 8) fail('rpc: under chainVerifier, 1 to 8 transaction-transport endpoints (sends and receipt/transaction lookups only, never state)');
    if (c.quorum !== undefined) fail('quorum applies to the provider-quorum mode; under chainVerifier the rpc list is only the transaction transport');
  } else {
    if (!Array.isArray(c.rpc) || c.rpc.length < 2 || c.rpc.length > 8) fail('rpc: 2 to 8 Base RPC URLs of distinct providers (the operator\'s quorum), or set chainVerifier');
    if (c.receiptSource !== undefined) fail('receiptSource needs chainVerifier: the receipt source is wired for the local verifier\'s sends');
  }
  const seen = new Set();
  for (const [i, r] of c.rpc.entries()) { let e; try { e = rpcEndpoint(r); } catch (x) { fail(`rpc[${i}]: ${x.message}`); } if (seen.has(e.identity)) fail(`rpc[${i}] repeats a provider`); seen.add(e.identity); }
  const quorum = chainVerifier ? null : c.quorum ?? 2;
  if (!chainVerifier && (!Number.isInteger(quorum) || quorum < 2 || quorum > c.rpc.length)) fail('quorum: 2 to the number of RPCs');
  // parsed AND built (no I/O: E's adapters check their endpoints are loopback when constructed), so a remote endpoint or a
  // fixture identity is refused here, at the runner's intake, not at the first request
  if (c.receiptSource !== undefined) { try { createReceiptSource(parseReceiptSourceConfig(c.receiptSource, { env })); } catch (x) { fail(`receiptSource: ${x.message}`); } }
  if (c.outcomeTimeoutSec !== undefined && (!Number.isInteger(c.outcomeTimeoutSec) || c.outcomeTimeoutSec < 10 || c.outcomeTimeoutSec > 600)) fail('outcomeTimeoutSec: 10 to 600');
  const confirmations = c.confirmations ?? 2;
  if (!Number.isInteger(confirmations) || confirmations < 0 || confirmations > 64) fail('confirmations: 0 to 64');
  // the operator's own wallet, on this machine only: the role never holds or reaches a remote key
  let u; try { u = new URL(c.signer); } catch { fail('signer must be a URL'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) || u.username || u.password || u.search || u.hash)
    fail('signer must be the operator\'s loopback JSON-RPC wallet (http://127.0.0.1:PORT, no credentials): the role holds no key');
  if (!ADDR.test(c.from) || /^0x0{40}$/i.test(c.from)) fail('from must be the paying account the signer holds');
  if (!Number.isSafeInteger(c.chainId) || c.chainId <= 0) fail('chainId is required');
  if (c.pins !== undefined && (!plain(c.pins) || c.pins.chainId !== c.chainId)) fail('pins must be the credit-vault pins object for chainId');
  if (c.maxFeeGwei !== undefined && !(typeof c.maxFeeGwei === 'number' && c.maxFeeGwei > 0 && c.maxFeeGwei <= 100)) fail('maxFeeGwei: (0, 100]');
  if (c.perMinute !== undefined && (!Number.isInteger(c.perMinute) || c.perMinute < 1 || c.perMinute > 600)) fail('perMinute: 1 to 600');
  if ((c.reserveRecord === undefined) !== (c.reserveRecordSha256 === undefined)) fail('reserveRecord and reserveRecordSha256 come together (the operator\'s reviewed pin)');
  if (c.reserveRecord !== undefined && (!plain(c.reserveRecord) || !/^sha256:[0-9a-f]{64}$/.test(String(c.reserveRecordSha256)))) fail('reserveRecord: the reviewed lease-gas record object, reserveRecordSha256: sha256:<hex> of its canonical JSON');
  return { port: c.port, bind: c.bind, stateDir: c.stateDir, rpc: [...c.rpc], ...(chainVerifier ? { chainVerifier } : { quorum }), confirmations, signer: u.origin + (u.pathname === '/' ? '' : u.pathname),
    from: c.from, chainId: c.chainId, ...(c.pins ? { pins: c.pins } : {}), maxFeeGwei: c.maxFeeGwei ?? 5, perMinute: c.perMinute ?? 30,
    ...(c.reserveRecord ? { reserveRecord: c.reserveRecord, reserveRecordSha256: c.reserveRecordSha256 } : {}),
    ...(c.receiptSource !== undefined ? { receiptSource: c.receiptSource } : {}), outcomeTimeoutSec: c.outcomeTimeoutSec ?? 180 };
}

/** The role, in the hosted-service role shape (network/host-services/roles.mjs in work/hosted-service-placement). */
export const CREDIT_VAULT_SUBMITTER_ROLE = Object.freeze({
  entry: 'network/credit-vault-submitter.mjs', bundleEntry: 'network/host-services/entries/credit-vault-submitter.mjs',
  kind: 'credit-vault-submitter', runtime: 'node>=22 (host role; not a wasm component)',
  serves: 'POST /v1/credit-vault/submit: a passkey-signed credit-vault (or proposed parallel-reserve) request is re-derived from its bytes, simulated at an agreed block and sent unchanged, gas paid by the operator; GET /health',
  state: { durable: true, what: 'the external signer\'s intent journal (cli/independent-signer.mjs): a broadcast whose outcome is unknown is never re-signed', rebuild: 'none needed: a lost journal only loses idempotency for requests still in flight (each request has one nonce, so it executes at most once)' },
  secrets: 'none in the role: the operator\'s own loopback external signer signs the gas transactions (the role holds no key)',
  cold: ['Base state: two or more RPC providers that must agree (legacy), OR the operator\'s local proof-backed verifier plus one transaction transport (chainVerifier)',
    'receipts (optional, with chainVerifier): the local Ethereum L1 pair and Base node (receiptSource)', 'the operator\'s loopback signer', 'the pinned credit-vault factories (built in, or pins)'],
  notCold: ['api.enclave.host or any Enclave API', 'discovery', 'directories', 'storage adapters', 'lease relays', 'any app'],
  validate: validateSubmitterConfig,
  launch(c) { return { configFile: c, env: {} }; },
});

/** The placement rule: never on a DigitalOcean machine (minimal WireGuard transport hosts). dmiDir/cloudCfg: tests only. */
export function digitalOceanRefusal({ readFile, dmiDir = '/sys/class/dmi/id', cloudCfg = '/etc/cloud/cloud.cfg.d/90_dpkg.cfg' }) {
  for (const f of ['sys_vendor', 'board_vendor', 'bios_vendor', 'chassis_vendor']) {
    let v = ''; try { v = String(readFile(path.join(dmiDir, f))).trim(); } catch { /* absent */ }
    if (/digitalocean/i.test(v)) return `this machine reports ${f}='${v}': DigitalOcean machines are transport-only (minimal WireGuard), never service hosts`;
  }
  try { if (/digitalocean/i.test(String(readFile(cloudCfg)))) return 'cloud-init reports a DigitalOcean datasource: DigitalOcean machines are transport-only'; } catch { /* absent */ }
  return null;
}
