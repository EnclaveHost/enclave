// wallet-deploy-r1: local owner-wallet handoff for the four additive funding deployment transactions.
// This module never signs, never holds key material and never sends. The browser wallet signs on an explicit click.
// RPC is read-only against an exact two-provider allowlist, and every wallet-returned hash is re-verified on both.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  keccak256, getAddress, isAddress, getContractAddress, encodeAbiParameters,
  serializeTransaction, recoverTransactionAddress, toFunctionSelector,
} from '../../source/node_modules/viem/_esm/index.js';

export const CHAIN_ID = 8453;
export const CHAIN_HEX = '0x2105';
export const EXPECTED_OWNER = '0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
export const FIRST_NONCE = 1175;
export const PROVIDERS = Object.freeze(['https://base-rpc.publicnode.com', 'https://base-mainnet.public.blastapi.io']);
export const NAMES = Object.freeze(['FundingSessionVaultLib', 'FundingGasLib', 'LeaseGasDexAdapter', 'FundingSessionVaultFactory']);
export const IMPLEMENTATION_NAME = 'FundingSessionVault';
// Hard ceilings independent of any authorization artifact; reviewed values must also equal COST-OBSERVATION-r3.
export const MAX_GAS_PER_TX = 8_000_000n;
export const MAX_FEE_PER_GAS = 20_000_000n;
export const MAX_PRIORITY_FEE_PER_GAS = 2_000_000n;
export const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_getTransactionCount', 'eth_getBalance', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call']);
export const LIMITS = Object.freeze({
  rpcTimeoutMs: 10_000, rpcSpacingMs: 300, rpcMaxBytes: 4_000_000,
  maxBlockAgeSec: 60, maxHeadSkew: 6, confirmations: 3,
  releaseQuietMs: 10 * 60_000, authMaxLifetimeMs: 24 * 3_600_000, clockSkewMs: 5 * 60_000,
  bodyMax: 4_096, maxReportedHashes: 8, maxEvents: 200,
  journalMaxBytes: 2_000_000, inputMaxBytes: 4_000_000, artifactMaxBytes: 64_000_000, toolFileMaxBytes: 1_000_000,
});
export const AUTH_SCHEMA = 'enclave-funding-wallet-deploy-authorization-r1';
export const JOURNAL_SCHEMA = 'enclave-funding-wallet-deploy-journal-r1';
export const TOOL_FILES = Object.freeze(['lib.mjs', 'server.mjs', 'public/index.html', 'public/app.js', 'public/app.css']);
export const AUTH_KEYS = Object.freeze(['schema', 'chainId', 'expectedOwner', 'proposalSha256', 'forkReplaySha256',
  'costObservationSha256', 'contractArtifactSha256', 'toolSourceSha256', 'activationSourceSha256', 'transactions',
  'implementation', 'maxTotalObservedWei', 'reviewedBy', 'reviewedAt', 'notAfter'].sort());

const STATES = ['none', 'offered', 'pending', 'rejected', 'released', 'confirmed', 'halted'];
const NEXT = {
  none: ['offered'], offered: ['pending', 'rejected', 'confirmed', 'halted'],
  pending: ['rejected', 'released', 'confirmed', 'halted'], rejected: ['offered'], released: ['offered'],
  confirmed: [], halted: [],
};
const RETRYABLE = new Set(['none', 'rejected', 'released']);
const OPEN = new Set(['offered', 'pending']);
const SEL_IMPLEMENTATION = toFunctionSelector('implementation()');
const SEL_FACTORY = toFunctionSelector('factory()');

export class Refusal extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const refuse = (code, message, details) => { throw new Refusal(code, message, details); };
const lc = (s) => String(s).toLowerCase();
const sameAddr = (a, b) => typeof a === 'string' && typeof b === 'string' && isAddress(a, {strict: false})
  && isAddress(b, {strict: false}) && lc(a) === lc(b);
const hexQ = (n) => '0x' + BigInt(n).toString(16);
const isHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
const isHexData = (d) => typeof d === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(d);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const stable = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const plain = (x) => JSON.parse(stable(x));
const big = (x, what) => {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(x)) refuse('rpc_malformed', `${what} is not a hex quantity`);
  return BigInt(x);
};
const sameMap = (a, b) => !!a && !!b && typeof a === 'object' && !Array.isArray(a)
  && stable(Object.keys(a).sort()) === stable(Object.keys(b).sort()) && Object.keys(b).every((k) => a[k] === b[k]);

// ---------------------------------------------------------------------------------------------------------------
// Bounded file reads and reviewed inputs. Nothing here regenerates, recompiles or re-derives the bundle.

export function readBoundedFile(file, max) {
  let st;
  try { st = fs.lstatSync(file); } catch { refuse('input_missing', `missing file: ${file}`); }
  if (!st.isFile()) refuse('input_invalid', `not a regular file (symlinks refused): ${file}`);
  if (st.size > max) refuse('input_invalid', `file larger than ${max} bytes: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = fs.readFileSync(fd);
    if (buf.length > max) refuse('input_invalid', `file larger than ${max} bytes: ${file}`);
    return buf;
  } finally { fs.closeSync(fd); }
}

export function computeToolDigests(dir, limits = LIMITS) {
  return Object.fromEntries(TOOL_FILES.map((f) => [f, sha256(readBoundedFile(path.join(dir, f), limits.toolFileMaxBytes))]));
}

export function loadInputs({deployDir, unifiedDir, expectedOwner = EXPECTED_OWNER, firstNonce = FIRST_NONCE, limits = LIMITS}) {
  const proposalBytes = readBoundedFile(path.join(deployDir, 'UNSIGNED-PROPOSAL-r1.json'), limits.inputMaxBytes);
  const replayBytes = readBoundedFile(path.join(deployDir, 'FORK-REPLAY-r2.json'), limits.inputMaxBytes);
  const costBytes = readBoundedFile(path.join(deployDir, 'COST-OBSERVATION-r3.json'), limits.inputMaxBytes);
  let artifacts;
  try { artifacts = JSON.parse(proposalBytes.toString('utf8')).artifacts; } catch { refuse('input_invalid', 'proposal is not JSON'); }
  const artifactDigests = {};
  for (const name of NAMES) {
    const rel = artifacts?.[name]?.path;
    if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) refuse('input_invalid', `artifact path for ${name}`);
    artifactDigests[name] = sha256(readBoundedFile(path.join(unifiedDir, rel), limits.artifactMaxBytes));
  }
  return validateInputs({proposalBytes, replayBytes, costBytes, artifactDigests, expectedOwner, firstNonce});
}

export function validateInputs({proposalBytes, replayBytes, costBytes, artifactDigests, expectedOwner = EXPECTED_OWNER, firstNonce = FIRST_NONCE}) {
  const parse = (bytes, what) => {
    let v;
    try { v = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { v = null; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) refuse('input_invalid', `${what} is not a JSON object`);
    return v;
  };
  const p = parse(proposalBytes, 'proposal'), r = parse(replayBytes, 'fork replay'), c = parse(costBytes, 'cost observation');
  const need = (cond, code, msg) => { if (!cond) refuse(code, msg); };

  need(p.schema === 'enclave-funding-deployment-proposal/v1' && p.chainId === CHAIN_ID, 'input_invalid', 'proposal schema/chain');
  need(sameAddr(p.deployer, expectedOwner), 'input_owner', `proposal deployer is not the expected owner ${expectedOwner}`);
  need(p.observedNonce === String(firstNonce) && p.nonceReserved === false, 'input_invalid', 'proposal first nonce');
  need(stable(p.providers) === stable(PROVIDERS), 'input_invalid', 'proposal providers differ from the allowlist');
  need(Array.isArray(p.transactions) && p.transactions.length === 4, 'input_invalid', 'proposal must hold four transactions');
  need(p.bindings && typeof p.bindings === 'object', 'input_invalid', 'proposal bindings');
  const bindings = Object.entries(p.bindings).map(([address, b]) => {
    need(isAddress(address, {strict: false}) && isHash(b?.codehash) && Number.isInteger(b?.bytes) && b.bytes > 0, 'input_invalid', `binding ${address}`);
    return Object.freeze({address: getAddress(address), codehash: lc(b.codehash), bytes: b.bytes});
  });
  const bound = new Set(bindings.map((b) => lc(b.address)));
  const ob = p.oldBindings ?? {};
  for (const k of ['book', 'router', 'keyAttestations', 'oldImplementation', 'oldFactory', 'oldVault']) {
    need(typeof ob[k] === 'string' && bound.has(lc(ob[k])), 'input_invalid', `old binding ${k} is not pinned by code hash`);
  }
  need(/^\d+$/.test(ob.maxVault6 ?? ''), 'input_invalid', 'old maxVault6');

  need(r.forkOnly === true && r.verified === true && r.productionSigning === false, 'input_replay', 'fork replay is not a verified fork-only rehearsal');
  need(r.sourceBlock === p.block && lc(r.sourceHash) === lc(p.blockHash), 'input_replay', 'fork replay source block differs from the proposal');
  need(Array.isArray(r.transactions) && r.transactions.length === 4 && r.runtimes && typeof r.runtimes === 'object', 'input_replay', 'fork replay shape');

  need(c.agreed === true && c.error === undefined && c.readOnly === true && stable(c.providers) === stable(PROVIDERS)
    && Array.isArray(c.results) && c.results.length === 2 && stable(c.results[0]) === stable(c.results[1]), 'input_cost', 'cost observation is not a two-provider agreed read');
  const rows = c.results[0].rows;
  need(Array.isArray(rows) && rows.length === 4, 'input_cost', 'cost observation rows');

  const runtime = (name, address) => {
    const rt = r.runtimes[name];
    need(rt && sameAddr(rt.address, address) && isHexData(rt.code) && rt.code.length > 2, 'input_replay', `${name} runtime evidence is not at the proposal address`);
    const code = lc(rt.code);
    need(keccak256(code) === lc(rt.codehash) && (code.length - 2) / 2 === rt.bytes && rt.bytes <= 24_576, 'input_replay', `${name} runtime code hash/size`);
    return Object.freeze({address: getAddress(address), code, codehash: lc(rt.codehash), bytes: rt.bytes});
  };

  let total = 0n;
  const txs = [];
  for (let i = 0; i < 4; i++) {
    const t = p.transactions[i], q = r.transactions[i], row = rows[i], name = NAMES[i], nonce = firstNonce + i;
    need(t?.name === name && q?.name === name && row?.name === name, 'input_mismatch', `transaction ${i} must be ${name}`);
    need(t.chainId === CHAIN_ID && sameAddr(t.from, expectedOwner) && t.to === null && t.value === '0'
      && t.nonce === String(nonce) && q.nonce === String(nonce), 'input_mismatch', `${name} chain/from/to/value/nonce`);
    need(isHexData(t.data) && t.data.length > 2 && (t.data.length - 2) / 2 <= 49_152, 'input_mismatch', `${name} initcode`);
    const data = lc(t.data);
    need(keccak256(data) === lc(t.dataHash), 'input_mismatch', `${name} dataHash does not match its data`);
    const predicted = getContractAddress({from: expectedOwner, nonce: BigInt(nonce)});
    need(sameAddr(t.predictedAddress, predicted) && sameAddr(p.addresses?.[name], predicted) && sameAddr(q.address, predicted),
      'input_mismatch', `${name} predicted address is not CREATE(owner, ${nonce})`);
    need(!bound.has(lc(predicted)), 'input_mismatch', `${name} address collides with an original binding`);
    need(Array.isArray(t.constructorArgs), 'input_mismatch', `${name} constructor arguments`);
    if (t.constructorArgs.length) {
      const types = t.constructorArgs.map((a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? {type: 'address'}
        : /^\d+$/.test(a) ? {type: 'uint256'} : refuse('input_mismatch', `${name} constructor argument ${a}`)));
      const enc = encodeAbiParameters(types, t.constructorArgs.map((a, k) => (types[k].type === 'address' ? a : BigInt(a))));
      need(data.endsWith(lc(enc).slice(2)), 'input_mismatch', `${name} constructor arguments are not the initcode suffix`);
    }
    need(typeof artifactDigests?.[name] === 'string' && artifactDigests[name] === p.artifacts?.[name]?.sha256,
      'input_artifact', `${name} compiled artifact sha256 differs from the proposal`);
    need(/^\d+$/.test(q.gasLimit ?? '') && row.gas === q.gasLimit, 'input_cost', `${name} gas limit differs between replay and cost observation`);
    const gas = BigInt(q.gasLimit), maxFee = BigInt(row.maxFeePerGas), prio = BigInt(row.maxPriorityFeePerGas);
    need(gas > 0n && gas <= MAX_GAS_PER_TX, 'input_cost', `${name} gas limit outside the hard ceiling`);
    need(maxFee === MAX_FEE_PER_GAS && prio === MAX_PRIORITY_FEE_PER_GAS, 'input_cost', `${name} fee caps differ from the reviewed caps`);
    const l2 = BigInt(row.l2CapWei), l1 = BigInt(row.l1ObservedUpperWei), op = BigInt(row.operatorObservedWei), tot = BigInt(row.totalObservedBoundWei);
    need(l2 === gas * maxFee && tot === l2 + l1 + op, 'input_cost', `${name} cost row arithmetic`);
    total += tot;
    txs.push(Object.freeze({
      index: i, name, nonce, data, dataHash: lc(t.dataHash), dataBytes: (data.length - 2) / 2, predictedAddress: getAddress(predicted),
      constructorArgs: Object.freeze([...t.constructorArgs]), runtime: runtime(name, predicted),
      gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, l2CapWei: l2, l1ObservedWei: l1, operatorObservedWei: op, totalObservedWei: tot,
    }));
  }
  need(total === BigInt(c.results[0].totalObservedBoundWei), 'input_cost', 'cost observation total');

  // Additive only: the new adapter and factory must point at the unchanged original contracts.
  const aArgs = txs[2].constructorArgs, fArgs = txs[3].constructorArgs;
  need(aArgs.length === 7 && aArgs.slice(0, 6).every((a) => bound.has(lc(a))) && aArgs[6] === p.limits?.adapterMaxEthOut,
    'input_binding', 'adapter constructor must bind pinned originals and the reviewed ETH cap');
  need(fArgs.length === 7 && sameAddr(fArgs[0], aArgs[0]) && sameAddr(fArgs[1], ob.book) && sameAddr(fArgs[2], ob.router)
    && sameAddr(fArgs[3], ob.keyAttestations) && fArgs[4] === ob.maxVault6 && sameAddr(fArgs[5], txs[2].predictedAddress)
    && sameAddr(fArgs[6], ob.oldFactory), 'input_binding', 'factory constructor must bind the original book/router/attestations/factory and the new adapter');

  const implAddress = p.addresses?.implementation;
  need(isAddress(implAddress ?? '', {strict: false}) && !bound.has(lc(implAddress)) && !txs.some((t) => sameAddr(t.predictedAddress, implAddress)),
    'input_mismatch', 'implementation address');
  const implementation = runtime(IMPLEMENTATION_NAME, implAddress);

  return Object.freeze({
    owner: getAddress(expectedOwner), txs: Object.freeze(txs), implementation, bindings: Object.freeze(bindings),
    oldBindings: Object.freeze({...ob}),
    cost: Object.freeze({block: String(c.block), blockHash: c.blockHash, at: c.at, totalObservedBoundWei: total,
      usd6AtObservedFeed: String(c.results[0].usd6AtObservedFeed ?? '')}),
    digests: Object.freeze({
      proposalSha256: sha256(proposalBytes), forkReplaySha256: sha256(replayBytes), costObservationSha256: sha256(costBytes),
      contractArtifactSha256: Object.freeze(Object.fromEntries(NAMES.map((n) => [n, artifactDigests[n]]))),
    }),
  });
}

export function costCaveat(inputs) {
  return `Observed at block ${inputs.cost.block} (${inputs.cost.at}). The L2 part is a hard per-call bound (gas cap x maxFeePerGas). `
    + 'The L1 data fee and operator fee are upper bounds observed at that block only; they drift with L1 fees and operator '
    + 'parameters. This is not a fixed future cost. Unused gas is not charged; actual cost is read from each receipt.';
}

export function walletParams(inputs, index) {
  const t = inputs.txs[index];
  // Contract creation: no `to`, zero value. Nothing else can be expressed by this request shape.
  return {from: inputs.owner, data: t.data, value: '0x0', gas: hexQ(t.gas), maxFeePerGas: hexQ(t.maxFeePerGas),
    maxPriorityFeePerGas: hexQ(t.maxPriorityFeePerGas), nonce: hexQ(t.nonce), chainId: CHAIN_HEX, type: '0x2'};
}

// ---------------------------------------------------------------------------------------------------------------
// Authorization artifact. Absent or invalid means SIGNING_DISABLED. This module never writes one.

export function validateAuthorization(a, inputs, toolDigests, nowMs, limits = LIMITS) {
  const need = (cond, msg) => { if (!cond) refuse('authorization_invalid', msg); };
  need(a && typeof a === 'object' && !Array.isArray(a), 'authorization is not a JSON object');
  need(stable(Object.keys(a).sort()) === stable(AUTH_KEYS), `authorization keys must be exactly: ${AUTH_KEYS.join(', ')}`);
  need(a.schema === AUTH_SCHEMA && a.chainId === CHAIN_ID, 'authorization schema/chainId');
  need(sameAddr(a.expectedOwner, inputs.owner), 'expectedOwner differs from the proposal owner');
  need(a.proposalSha256 === inputs.digests.proposalSha256, 'proposalSha256 does not match UNSIGNED-PROPOSAL-r1.json');
  need(a.forkReplaySha256 === inputs.digests.forkReplaySha256, 'forkReplaySha256 does not match FORK-REPLAY-r2.json');
  need(a.costObservationSha256 === inputs.digests.costObservationSha256, 'costObservationSha256 does not match COST-OBSERVATION-r3.json');
  need(sameMap(a.contractArtifactSha256, inputs.digests.contractArtifactSha256), 'contractArtifactSha256 does not match the compiled artifacts');
  need(sameMap(a.toolSourceSha256, toolDigests), 'toolSourceSha256 does not match the files this server runs and serves');
  need(typeof a.activationSourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(a.activationSourceSha256), 'activationSourceSha256 must be a lowercase sha256 hex digest');
  need(Array.isArray(a.transactions) && a.transactions.length === 4, 'transactions must list the four reviewed creations');
  a.transactions.forEach((x, i) => {
    const t = inputs.txs[i];
    const want = {name: t.name, nonce: String(t.nonce), dataHash: t.dataHash, predictedAddress: lc(t.predictedAddress),
      runtimeCodehash: t.runtime.codehash, gas: String(t.gas), maxFeePerGas: String(t.maxFeePerGas), maxPriorityFeePerGas: String(t.maxPriorityFeePerGas)};
    need(x && typeof x === 'object' && stable(Object.keys(x).sort()) === stable(Object.keys(want).sort())
      && Object.keys(want).every((k) => (k === 'name' ? x[k] === want[k] : lc(String(x[k])) === want[k])),
    `transactions[${i}] does not match the reviewed ${t.name} (name/nonce/dataHash/predictedAddress/runtimeCodehash/gas/fee caps)`);
  });
  const im = a.implementation;
  need(im && stable(Object.keys(im).sort()) === stable(['address', 'runtimeCodehash'])
    && sameAddr(im.address, inputs.implementation.address) && lc(im.runtimeCodehash) === inputs.implementation.codehash, 'implementation binding');
  need(a.maxTotalObservedWei === String(inputs.cost.totalObservedBoundWei), 'maxTotalObservedWei differs from the cost observation');
  need(typeof a.reviewedBy === 'string' && a.reviewedBy.trim().length > 0 && a.reviewedBy.length <= 120, 'reviewedBy');
  const at = Date.parse(a.reviewedAt), until = Date.parse(a.notAfter);
  need(typeof a.reviewedAt === 'string' && Number.isFinite(at) && at <= nowMs + limits.clockSkewMs, 'reviewedAt is invalid or in the future');
  need(typeof a.notAfter === 'string' && Number.isFinite(until) && until > at && until - at <= limits.authMaxLifetimeMs, 'notAfter must follow reviewedAt within 24h');
  need(nowMs < until, 'authorization expired (notAfter has passed)');
  return {reviewedBy: a.reviewedBy, reviewedAt: a.reviewedAt, notAfter: a.notAfter, activationSourceSha256: a.activationSourceSha256};
}

// ---------------------------------------------------------------------------------------------------------------
// Read-only RPC.

export function assertReadMethod(method) {
  if (typeof method !== 'string' || /^(eth_send|eth_sign|personal_|wallet_)/.test(method) || !READ_METHODS.has(method)) {
    refuse('rpc_method_refused', `RPC method ${String(method).slice(0, 60)} is not on the read-only allowlist`);
  }
}

export function httpRpc(url, {fetchImpl = globalThis.fetch, limits = LIMITS} = {}) {
  if (!PROVIDERS.includes(url)) refuse('provider_not_allowlisted', `RPC URL is not one of the two allowlisted providers`);
  const host = new URL(url).host;
  let last = 0, queue = Promise.resolve(), id = 0;
  const once = async (method, params) => {
    const wait = last + limits.rpcSpacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const reqId = ++id;
    const failed = (e) => new Refusal(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'rpc_timeout' : 'rpc_unreachable',
      `${host} ${method}: ${e?.name ?? 'error'}`);
    let res, text;
    try {
      res = await fetchImpl(url, {method: 'POST', headers: {'content-type': 'application/json'}, redirect: 'error',
        body: JSON.stringify({jsonrpc: '2.0', id: reqId, method, params}), signal: AbortSignal.timeout(limits.rpcTimeoutMs)});
    } catch (e) { throw failed(e); }
    if (res.status === 429) refuse('rate_limited', `${host} returned HTTP 429 for ${method}`);
    if (!res.ok) refuse('rpc_http', `${host} returned HTTP ${res.status} for ${method}`);
    if (Number(res.headers.get('content-length') ?? 0) > limits.rpcMaxBytes) refuse('rpc_oversize', `${host} ${method} response too large`);
    try { text = await res.text(); } catch (e) { throw failed(e); }
    if (text.length > limits.rpcMaxBytes) refuse('rpc_oversize', `${host} ${method} response too large`);
    let j;
    try { j = JSON.parse(text); } catch { refuse('rpc_malformed', `${host} ${method} returned non-JSON`); }
    if (!j || j.jsonrpc !== '2.0' || j.id !== reqId) refuse('rpc_malformed', `${host} ${method} returned a malformed envelope`);
    if (j.error) {
      const msg = String(j.error.message ?? '').slice(0, 200);
      refuse(j.error.code === -32005 || /rate|limit|too many/i.test(msg) ? 'rate_limited' : 'rpc_error', `${host} ${method}: ${msg}`);
    }
    if (!('result' in j)) refuse('rpc_malformed', `${host} ${method} returned no result`);
    return j.result;
  };
  return (method, params = []) => {
    assertReadMethod(method);
    const run = queue.then(() => once(method, params));
    queue = run.catch(() => {});
    return run;
  };
}

const normTx = (x) => {
  if (!x || typeof x !== 'object') refuse('rpc_malformed', 'transaction object');
  if (!isHash(x.hash) || !isAddress(x.from ?? '', {strict: false}) || !isHexData(x.input)) refuse('rpc_malformed', 'transaction fields');
  if (x.to !== null && x.to !== undefined && !isAddress(x.to, {strict: false})) refuse('rpc_malformed', 'transaction to');
  if (x.accessList !== undefined && !Array.isArray(x.accessList)) refuse('rpc_malformed', 'transaction accessList');
  const v = big(x.yParity ?? x.v, 'yParity');
  return {
    hash: lc(x.hash), from: lc(x.from), to: x.to ? lc(x.to) : null, nonce: big(x.nonce, 'nonce'), value: big(x.value, 'value'),
    input: lc(x.input), gas: big(x.gas, 'gas'), maxFeePerGas: x.maxFeePerGas == null ? null : big(x.maxFeePerGas, 'maxFeePerGas'),
    maxPriorityFeePerGas: x.maxPriorityFeePerGas == null ? null : big(x.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
    chainId: x.chainId == null ? null : big(x.chainId, 'chainId'), type: big(x.type ?? '0x0', 'type'),
    accessList: (x.accessList ?? []).map((e) => ({address: lc(e.address), storageKeys: (e.storageKeys ?? []).map(lc)})),
    r: lc(x.r), s: lc(x.s), yParity: Number(v >= 27n ? v - 27n : v),
    blockNumber: x.blockNumber == null ? null : big(x.blockNumber, 'blockNumber'), blockHash: x.blockHash ? lc(x.blockHash) : null,
  };
};
const normReceipt = (x) => {
  if (!x || typeof x !== 'object' || !isHash(x.transactionHash) || !isHash(x.blockHash ?? '')) refuse('rpc_malformed', 'receipt');
  return {transactionHash: lc(x.transactionHash), blockNumber: big(x.blockNumber, 'receipt blockNumber'), blockHash: lc(x.blockHash),
    status: big(x.status, 'status'), contractAddress: x.contractAddress ? lc(x.contractAddress) : null, from: lc(x.from ?? '')};
};
const extra = (rc, k) => (rc[0]?.[k] != null && rc[0][k] === rc[1]?.[k] && /^0x[0-9a-fA-F]{1,64}$/.test(rc[0][k]) ? BigInt(rc[0][k]).toString() : null);

export function createChainReader({inputs, rpcs, now = Date.now, limits = LIMITS}) {
  if (!Array.isArray(rpcs) || rpcs.length !== 2) refuse('config', 'exactly two read-only providers are required');
  const guarded = rpcs.map((r) => async (m, p = []) => { assertReadMethod(m); return r(m, p); });
  const owner = inputs.owner;
  const both = async (fn) => {
    const res = await Promise.allSettled(guarded.map((r, k) => fn(r, k)));
    const bad = res.find((x) => x.status === 'rejected');
    if (bad) throw bad.reason instanceof Refusal ? bad.reason : new Refusal('rpc_error', String(bad.reason?.message ?? bad.reason).slice(0, 200));
    return res.map((x) => x.value);
  };
  const agree = (vals, what) => {
    if (stable(vals[0]) !== stable(vals[1])) refuse('provider_disagreement', `${what} differs between the two providers`, {what});
    return vals[0];
  };

  const snapshot = async () => {
    const heads = await both(async (r) => {
      if (lc(await r('eth_chainId')) !== CHAIN_HEX) refuse('wrong_chain', 'a provider is not on Base 8453');
      return big(await r('eth_blockNumber'), 'blockNumber');
    });
    const lo = heads[0] < heads[1] ? heads[0] : heads[1], hi = heads[0] < heads[1] ? heads[1] : heads[0];
    if (hi - lo > BigInt(limits.maxHeadSkew)) refuse('stale_rpc', `provider heads differ by ${hi - lo} blocks`, {heads: heads.map(String)});
    const n = lo - 2n;
    const hdrs = await both((r) => r('eth_getBlockByNumber', [hexQ(n), false]));
    for (const h of hdrs) if (!h || !isHash(h.hash) || big(h.number, 'block number') !== n) refuse('rpc_malformed', `block ${n} header`);
    if (lc(hdrs[0].hash) !== lc(hdrs[1].hash)) refuse('provider_disagreement', `block ${n} hash differs between providers`);
    const ts = big(hdrs[0].timestamp, 'timestamp'), nowS = BigInt(Math.floor(now() / 1000));
    if (ts > nowS + 30n || nowS - ts > BigInt(limits.maxBlockAgeSec)) refuse('stale_rpc', `agreed block ${n} is ${nowS - ts}s old`);
    return {number: n, hash: lc(hdrs[0].hash), timestamp: ts, baseFeePerGas: big(hdrs[0].baseFeePerGas, 'baseFeePerGas'), heads, minHead: lo,
      at: {blockHash: hdrs[0].hash, requireCanonical: true}};
  };
  const nonces = async (at) => agree(await both(async (r) => ({
    atBlock: big(await r('eth_getTransactionCount', [owner, at]), 'nonce'),
    pending: big(await r('eth_getTransactionCount', [owner, 'pending']), 'pending nonce'),
  })), 'owner nonce');
  const codeAt = async (address, at) => {
    const codes = await both((r) => r('eth_getCode', [address, at]));
    for (const c of codes) if (!isHexData(c)) refuse('rpc_malformed', `code at ${address}`);
    return agree(codes.map(lc), `code at ${address}`);
  };
  const callAddress = async (to, data, at) => {
    const res = agree((await both((r) => r('eth_call', [{to, data}, at]))).map(lc), `eth_call ${data} on ${to}`);
    if (!/^0x0{24}[0-9a-f]{40}$/.test(res)) refuse('implementation_binding', `${data} on ${to} did not return an address`);
    return '0x' + res.slice(-40);
  };
  const checkBindings = async (at) => {
    for (const b of inputs.bindings) {
      const code = await codeAt(b.address, at);
      if (keccak256(code) !== b.codehash || (code.length - 2) / 2 !== b.bytes) refuse('binding_changed', `original binding ${b.address} no longer has its pinned code`);
    }
  };
  const checkImplementation = async (at) => {
    const im = inputs.implementation, factory = inputs.txs[3].predictedAddress;
    if (await codeAt(im.address, at) !== im.code) refuse('runtime_mismatch', `implementation ${im.address} runtime differs from fork evidence`);
    if (!sameAddr(await callAddress(factory, SEL_IMPLEMENTATION, at), im.address)) refuse('implementation_binding', 'factory.implementation() is not the reviewed implementation');
    if (!sameAddr(await callAddress(im.address, SEL_FACTORY, at), factory)) refuse('implementation_binding', 'implementation.factory() is not the new factory');
  };
  const checkDeployed = async (upTo, at) => {
    for (let j = 0; j < upTo; j++) {
      const t = inputs.txs[j];
      if (await codeAt(t.predictedAddress, at) !== t.runtime.code) refuse('runtime_mismatch', `${t.name} runtime at ${t.predictedAddress} differs from fork evidence`);
    }
    if (upTo === 4) await checkImplementation(at);
  };

  const preflight = async (index) => {
    const t = inputs.txs[index];
    const snap = await snapshot();
    const n = await nonces(snap.at), exp = BigInt(t.nonce);
    if (n.atBlock !== exp || n.pending !== exp) {
      if (index === 0 && n.atBlock !== exp) {
        refuse('proposal_nonce_stale', `owner nonce is ${n.atBlock}; the reviewed bundle starts at ${exp}. Addresses and exact runtimes are bound to that nonce; `
          + 'this tool does not regenerate or recompile. A new reviewed proposal and fork replay are required.', {atBlock: String(n.atBlock), pending: String(n.pending)});
      }
      refuse('nonce_mismatch', `owner nonce at block ${snap.number} is ${n.atBlock} (pending ${n.pending}); ${t.name} needs exactly ${exp}. `
        + 'Another transaction may be pending or mined: reconcile, do not resend.', {atBlock: String(n.atBlock), pending: String(n.pending)});
    }
    if (snap.baseFeePerGas + t.maxPriorityFeePerGas > t.maxFeePerGas) {
      refuse('fee_cap_insufficient', `base fee ${snap.baseFeePerGas} + priority ${t.maxPriorityFeePerGas} exceeds the reviewed cap ${t.maxFeePerGas}; wait, do not raise caps here`);
    }
    await checkDeployed(index, snap.at);
    for (let j = index; j < 4; j++) {
      if (await codeAt(inputs.txs[j].predictedAddress, snap.at) !== '0x') refuse('predicted_address_occupied', `${inputs.txs[j].name} address already has code`);
    }
    await checkBindings(snap.at);
    const balance = agree((await both((r) => r('eth_getBalance', [owner, snap.at]))).map((x) => big(x, 'balance')), 'owner balance');
    const remaining = inputs.txs.slice(index).reduce((s, x) => s + x.totalObservedWei, 0n);
    if (balance < remaining) refuse('balance_below_observation', `owner balance ${balance} wei is below the remaining observed bound ${remaining} wei`);
    return {block: snap.number, blockHash: snap.hash, baseFeePerGas: snap.baseFeePerGas, nonce: exp, balance,
      remainingObservedWei: remaining, feeHeadroomWei: t.maxFeePerGas - snap.baseFeePerGas - t.maxPriorityFeePerGas};
  };

  // Classifies one candidate hash. A browser-returned hash is never trusted: fields, signer, receipt, block
  // membership, confirmations and runtime are all re-read on both providers.
  const verifyMined = async (index, hash) => {
    const t = inputs.txs[index];
    const got = await both((r) => r('eth_getTransactionByHash', [hash]));
    if (got[0] == null && got[1] == null) return {kind: 'not_found', code: 'tx_not_found', message: 'neither provider knows this hash'};
    if (got[0] == null || got[1] == null) return {kind: 'not_final', code: 'provider_disagreement', message: 'only one provider returns this transaction'};
    const tx = agree(got.map(normTx), 'transaction');
    if (tx.hash !== lc(hash)) refuse('rpc_malformed', 'provider returned a different transaction hash');
    if (tx.type !== 2n || tx.chainId === null || tx.maxFeePerGas === null || tx.maxPriorityFeePerGas === null) {
      return {kind: 'not_final', code: 'unverifiable_tx_type', message: `type ${tx.type} transaction; only EIP-1559 envelopes are verified here. Reconcile manually.`};
    }
    const serialized = serializeTransaction({type: 'eip1559', chainId: Number(tx.chainId), nonce: Number(tx.nonce), gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, to: tx.to ?? undefined, value: tx.value,
      data: tx.input, accessList: tx.accessList}, {r: tx.r, s: tx.s, yParity: tx.yParity});
    if (keccak256(serialized) !== lc(hash)) refuse('provider_inconsistent', 'transaction fields returned by the providers do not hash to this hash');
    const signer = lc(await recoverTransactionAddress({serializedTransaction: serialized}));
    if (signer !== tx.from) refuse('provider_inconsistent', 'provider sender differs from the recovered signer');
    if (signer !== lc(owner) || tx.nonce !== BigInt(t.nonce) || tx.chainId !== BigInt(CHAIN_ID)) {
      return {kind: 'unrelated', code: 'hash_unrelated', message: `signer ${signer} nonce ${tx.nonce} chain ${tx.chainId} is not owner nonce ${t.nonce} on 8453`};
    }
    const problems = [];
    if (tx.to !== null) problems.push('to_not_creation');
    if (tx.value !== 0n) problems.push('nonzero_value');
    if (tx.input !== t.data) problems.push('calldata');
    if (tx.accessList.length) problems.push('access_list');
    if (tx.gas > t.gas) problems.push('gas_above_reviewed');
    if (tx.maxFeePerGas > t.maxFeePerGas) problems.push('max_fee_above_cap');
    if (tx.maxPriorityFeePerGas > t.maxPriorityFeePerGas) problems.push('priority_fee_above_cap');
    if (tx.blockNumber === null || tx.blockHash === null) return {kind: 'not_final', code: 'not_mined', message: 'known but not mined', problems};
    const rc = await both((r) => r('eth_getTransactionReceipt', [hash]));
    if (rc[0] == null || rc[1] == null) return {kind: 'not_final', code: 'receipt_missing', message: 'a provider has no receipt yet'};
    const R = agree(rc.map(normReceipt), 'receipt');
    if (R.blockNumber === 0n || tx.blockNumber === 0n) return {kind: 'not_final', code: 'zero_block_receipt', message: 'a block-0 receipt is not a canonical inclusion'};
    if (R.transactionHash !== lc(hash) || R.blockNumber !== tx.blockNumber || R.blockHash !== tx.blockHash) {
      return {kind: 'not_final', code: 'receipt_inconsistent', message: 'receipt does not match the transaction block'};
    }
    const blocks = await both((r) => r('eth_getBlockByNumber', [hexQ(R.blockNumber), false]));
    for (const b of blocks) {
      if (!b || lc(b.hash) !== R.blockHash || !Array.isArray(b.transactions) || !b.transactions.map(lc).includes(lc(hash))) {
        return {kind: 'not_final', code: 'not_canonical', message: `block ${R.blockNumber} on a provider does not contain this transaction`};
      }
    }
    const snap = await snapshot();
    if (snap.minHead < R.blockNumber + BigInt(limits.confirmations)) {
      return {kind: 'not_final', code: 'awaiting_confirmations', message: `included in ${R.blockNumber}; waiting for ${limits.confirmations} confirmations`};
    }
    // Canonical, confirmed owner transaction at the reviewed nonce: any deviation from here on is permanent.
    if (R.status !== 1n) problems.push('reverted');
    if (R.from !== lc(owner)) problems.push('receipt_from');
    if (R.contractAddress !== lc(t.predictedAddress)) problems.push('contract_address');
    let runtimeCodehash = null;
    if (R.status === 1n) {
      const code = await codeAt(t.predictedAddress, snap.at);
      runtimeCodehash = keccak256(code);
      if (code !== t.runtime.code) problems.push('runtime');
    }
    if (!problems.length && index === 3) {
      try { await checkImplementation(snap.at); } catch (e) {
        if (e.code === 'runtime_mismatch' || e.code === 'implementation_binding') problems.push('implementation'); else throw e;
      }
    }
    const receipt = {hash: lc(hash), blockNumber: R.blockNumber, blockHash: R.blockHash, status: R.status, contractAddress: R.contractAddress,
      gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      gasUsed: extra(rc, 'gasUsed'), effectiveGasPrice: extra(rc, 'effectiveGasPrice'), l1Fee: extra(rc, 'l1Fee')};
    if (problems.length) return {kind: 'mismatch', code: 'mined_outside_review', problems, receipt, runtimeCodehash};
    await checkBindings(snap.at);
    return {kind: 'confirmed', receipt, runtimeCodehash, checkedAt: {block: snap.number, blockHash: snap.hash}};
  };

  return {snapshot, nonces, codeAt, checkBindings, checkDeployed, preflight, verifyMined};
}

// ---------------------------------------------------------------------------------------------------------------
// Journal: one owned file, atomic replace, mode 0600, append-only events, no rewind.

export const journalFile = (dir) => path.join(dir, 'deploy-journal.json');

export function freshJournal(inputs) {
  return {schema: JOURNAL_SCHEMA, proposalSha256: inputs.digests.proposalSha256, chainId: CHAIN_ID, owner: inputs.owner, seq: 0,
    entries: inputs.txs.map((t) => ({index: t.index, name: t.name, intent: 'create', dataHash: t.dataHash, expectedNonce: t.nonce,
      expectedAddress: t.predictedAddress, state: 'none', offerId: null, offeredAt: null, params: null, walletRejected: false,
      reportedHashes: [], hash: null, outcome: null, receipt: null, runtimeCodehash: null, events: []}))};
}

export function checkJournal(j, inputs) {
  const need = (cond, msg) => { if (!cond) refuse('journal_invalid', msg); };
  need(j && j.schema === JOURNAL_SCHEMA && j.proposalSha256 === inputs.digests.proposalSha256 && sameAddr(j.owner, inputs.owner)
    && j.chainId === CHAIN_ID && Number.isInteger(j.seq) && j.seq >= 0 && Array.isArray(j.entries) && j.entries.length === 4,
  'journal does not belong to this reviewed bundle');
  let prefix = true;
  j.entries.forEach((e, i) => {
    const t = inputs.txs[i];
    need(e && e.index === i && e.name === t.name && e.dataHash === t.dataHash && e.expectedNonce === t.nonce
      && sameAddr(e.expectedAddress, t.predictedAddress) && STATES.includes(e.state) && Array.isArray(e.events)
      && Array.isArray(e.reportedHashes) && e.reportedHashes.every(isHash), `journal entry ${i} does not match ${t.name}`);
    if (!prefix) need(e.state === 'none', `journal has activity on ${t.name} after an unconfirmed transaction`);
    if (e.state === 'confirmed') need(isHash(e.hash) && e.receipt, `${t.name} confirmed without hash/receipt`);
    else prefix = false;
  });
}

export function assertNoRewind(prev, next) {
  const no = (cond, msg) => { if (!cond) refuse('journal_rewind', msg); };
  no(next.seq === prev.seq + 1, 'journal sequence must advance by exactly one');
  no(next.schema === prev.schema && next.proposalSha256 === prev.proposalSha256 && lc(next.owner) === lc(prev.owner)
    && next.entries.length === prev.entries.length, 'journal identity changed');
  prev.entries.forEach((p, i) => {
    const n = next.entries[i];
    if (p.state === 'confirmed' || p.state === 'halted') no(stable(p) === stable(n), `${p.name} is ${p.state} and immutable`);
    no(p.state === n.state || NEXT[p.state].includes(n.state), `${p.name}: ${p.state} -> ${n.state} is not allowed`);
    no(n.events.length >= p.events.length && stable(n.events.slice(0, p.events.length)) === stable(p.events), `${p.name}: events are append-only`);
    no(n.reportedHashes.length >= p.reportedHashes.length
      && stable(n.reportedHashes.slice(0, p.reportedHashes.length)) === stable(p.reportedHashes), `${p.name}: reported hashes are append-only`);
  });
}

export function ensureJournalDir(dir) {
  let st = null;
  try { st = fs.lstatSync(dir); } catch { st = null; }
  if (!st) { fs.mkdirSync(dir, {mode: 0o700}); fs.chmodSync(dir, 0o700); return; }
  if (!st.isDirectory()) refuse('journal_invalid', `${dir} is not a directory (symlinks refused)`);
  if (st.mode & 0o077) refuse('journal_mode', `${dir} must be mode 0700`);
}

export function readJournal(file, inputs, limits = LIMITS) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!st.isFile()) refuse('journal_invalid', 'journal is not a regular file');
  if (st.mode & 0o077) refuse('journal_mode', 'journal must be mode 0600');
  let j;
  try { j = JSON.parse(readBoundedFile(file, limits.journalMaxBytes).toString('utf8')); } catch (e) {
    if (e instanceof Refusal) throw e;
    refuse('journal_invalid', 'journal is not JSON');
  }
  checkJournal(j, inputs);
  return j;
}

export function writeJournalAtomic(file, prev, next, inputs) {
  checkJournal(next, inputs);
  if (prev) assertNoRewind(prev, next); else if (next.seq !== 0) refuse('journal_rewind', 'a new journal must start at seq 0');
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.deploy-journal.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const buf = Buffer.from(JSON.stringify(next, null, 1) + '\n');
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    if (prev) fs.renameSync(tmp, file);
    else { fs.linkSync(tmp, file); fs.unlinkSync(tmp); }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    refuse('journal_write', `journal write failed: ${e.code ?? e.message}`);
  }
  const dfd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

export function acquireLock(dir) {
  const lock = path.join(dir, '.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') refuse('journal_locked', `${lock} exists: another process owns this journal. Stop it; remove a stale lock only after confirming none runs.`);
    throw e;
  }
  try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { fs.closeSync(fd); }
  let released = false;
  return () => { if (!released) { released = true; try { fs.unlinkSync(lock); } catch { /* already gone */ } } };
}

const nextIndexOf = (j) => { const k = j.entries.findIndex((e) => e.state !== 'confirmed'); return k === -1 ? null : k; };

const entryView = (e) => ({index: e.index, name: e.name, state: e.state, expectedNonce: e.expectedNonce, expectedAddress: e.expectedAddress,
  dataHash: e.dataHash, offeredAt: e.offeredAt, params: e.params, walletRejected: e.walletRejected, reportedHashes: e.reportedHashes,
  hash: e.hash, outcome: e.outcome, receipt: e.receipt, runtimeCodehash: e.runtimeCodehash, events: e.events.slice(-12)});

// Offline (no network, no writes) summary for `--check`.
export function offlineReport({inputs, toolDigests, journal, authorization, now = Date.now}) {
  let signing = {enabled: false, reason: 'SIGNING_DISABLED: no reviewed authorization artifact was passed (--authorization).'};
  if (authorization) {
    try { signing = {enabled: true, ...validateAuthorization(authorization, inputs, toolDigests, now())}; } catch (e) { signing = {enabled: false, reason: `SIGNING_DISABLED: ${e.message}`}; }
  }
  return plain({
    readOnly: true, signing, owner: inputs.owner, chainId: CHAIN_ID, providers: PROVIDERS, digests: inputs.digests, toolSourceSha256: toolDigests,
    transactions: inputs.txs.map((t) => ({name: t.name, nonce: t.nonce, dataHash: t.dataHash, dataBytes: t.dataBytes, predictedAddress: t.predictedAddress,
      runtimeCodehash: t.runtime.codehash, runtimeBytes: t.runtime.bytes, gas: t.gas, maxFeePerGas: t.maxFeePerGas,
      maxPriorityFeePerGas: t.maxPriorityFeePerGas, l2CapWei: t.l2CapWei, totalObservedWei: t.totalObservedWei})),
    implementation: {address: inputs.implementation.address, runtimeCodehash: inputs.implementation.codehash},
    totalObservedBoundWei: inputs.cost.totalObservedBoundWei, caveat: costCaveat(inputs),
    journal: journal ? {seq: journal.seq, nextIndex: nextIndexOf(journal), states: journal.entries.map((e) => `${e.name}:${e.state}`)} : 'absent',
  });
}

// Network read-only, no journal writes, no lock: what `prepare` would check for the next transaction.
export async function dryRun({inputs, journalDir, rpcs, now = Date.now, limits = LIMITS}) {
  const j = readJournal(journalFile(journalDir), inputs, limits) ?? freshJournal(inputs);
  const halted = j.entries.find((e) => e.state === 'halted');
  if (halted) return {ok: false, refusal: {code: 'halted', message: `${halted.name} is halted`}};
  const open = j.entries.find((e) => OPEN.has(e.state));
  if (open) return {ok: false, refusal: {code: 'unresolved_pending', message: `${open.name} is ${open.state}; reconcile first`, details: {reportedHashes: open.reportedHashes}}};
  const index = nextIndexOf(j);
  if (index === null) return {ok: true, complete: true};
  try {
    const pre = await createChainReader({inputs, rpcs, now, limits}).preflight(index);
    return {ok: true, index, name: inputs.txs[index].name, preflight: plain(pre), params: {...walletParams(inputs, index), data: `<${inputs.txs[index].dataBytes} bytes, keccak ${inputs.txs[index].dataHash}>`}};
  } catch (e) {
    return {ok: false, refusal: refusalView(e)};
  }
}

const refusalView = (e) => (e instanceof Refusal ? {code: e.code, message: e.message, details: plain(e.details ?? {})}
  : {code: 'internal_error', message: String(e?.message ?? e).slice(0, 300)});

// ---------------------------------------------------------------------------------------------------------------
// Service: serialized mutations, one open wallet request at a time, never an automatic resend.

export function createService({inputs, journalDir, rpcs, authorization = null, toolDigests, now = Date.now, limits = LIMITS,
  randomId = () => crypto.randomBytes(16).toString('hex')}) {
  const reader = createChainReader({inputs, rpcs, now, limits});
  ensureJournalDir(journalDir);
  const releaseLock = acquireLock(journalDir);
  const file = journalFile(journalDir);
  let journal;
  try {
    journal = readJournal(file, inputs, limits);
    if (!journal) { journal = freshJournal(inputs); writeJournalAtomic(file, null, journal, inputs); }
  } catch (e) { releaseLock(); throw e; }
  let busy = false;
  const iso = () => new Date(now()).toISOString();

  const authStatus = () => {
    if (!authorization) return {enabled: false, reason: 'SIGNING_DISABLED: no reviewed authorization artifact was passed (--authorization).'};
    try { return {enabled: true, ...validateAuthorization(authorization, inputs, toolDigests, now(), limits)}; } catch (e) {
      return {enabled: false, reason: `SIGNING_DISABLED: ${e.message}`};
    }
  };
  const exclusive = async (fn) => {
    if (busy) return {ok: false, refusal: {code: 'busy', message: 'another request is being processed; nothing was queued or resent'}};
    busy = true;
    try { return {ok: true, ...plain(await fn())}; } catch (e) { return {ok: false, refusal: refusalView(e)}; } finally { busy = false; }
  };
  const commit = (mutate) => {
    const next = structuredClone(journal);
    mutate(next);
    next.seq = journal.seq + 1;
    writeJournalAtomic(file, journal, next, inputs);
    journal = next;
  };
  const event = (x, type, details = {}) => {
    if (x.events.length >= limits.maxEvents) refuse('journal_event_limit', `${x.name} has ${limits.maxEvents} events; root must reconcile`);
    x.events.push({at: iso(), type, ...plain(details)});
  };
  const addHash = (x, h) => {
    if (x.reportedHashes.includes(h)) return;
    if (x.reportedHashes.length >= limits.maxReportedHashes) refuse('too_many_hashes', `${x.name} already has ${limits.maxReportedHashes} candidate hashes`);
    x.reportedHashes.push(h);
  };
  const idx = (v) => { if (!Number.isInteger(v) || v < 0 || v > 3) refuse('bad_request', 'index must be 0..3'); return v; };
  const text = (m) => (typeof m === 'string' ? m.replace(/[^\x20-\x7e]/g, '?').slice(0, 200) : null);
  const gate = () => {
    const halted = journal.entries.find((e) => e.state === 'halted');
    if (halted) refuse('halted', `${halted.name} is halted (${halted.outcome?.code}); root must reconcile manually. Nothing further is offered.`, {index: halted.index});
    const open = journal.entries.find((e) => OPEN.has(e.state));
    if (open) {
      refuse('unresolved_pending', `${open.name} (nonce ${open.expectedNonce}) has an unresolved wallet request (${open.state}). Reconcile it; nothing is resent automatically.`,
        {index: open.index, reportedHashes: open.reportedHashes});
    }
  };
  // Nonce unused on both providers and nothing at the address: a wallet rejection or unsent request is settled.
  const nonceUnused = async (e) => {
    const snap = await reader.snapshot();
    const n = await reader.nonces(snap.at), exp = BigInt(e.expectedNonce);
    return {snap, n, unused: n.atBlock === exp && n.pending === exp && (await reader.codeAt(e.expectedAddress, snap.at)) === '0x'};
  };

  const prepare = (body) => exclusive(async () => {
    const sig = authStatus();
    if (!sig.enabled) refuse('signing_disabled', sig.reason);
    const index = idx(body.index);
    if (!sameAddr(body.account, inputs.owner)) refuse('wrong_owner', `connected account ${text(String(body.account))} is not the expected owner ${inputs.owner}`);
    if (lc(body.walletChainId) !== CHAIN_HEX) refuse('wrong_chain', `wallet chain ${text(String(body.walletChainId))} is not Base 8453 (0x2105); switch it in the wallet`);
    gate();
    const e = journal.entries[index];
    if (e.state === 'confirmed') refuse('already_confirmed', `${e.name} is already confirmed (${e.hash})`);
    const next = nextIndexOf(journal);
    if (index !== next) refuse('out_of_order', `${e.name} cannot be offered before ${journal.entries[next].name}`);
    if (!RETRYABLE.has(e.state)) refuse('not_offerable', `${e.name} is ${e.state}`);
    const pre = await reader.preflight(index);
    const offerId = randomId(), params = walletParams(inputs, index);
    commit((j) => {
      const x = j.entries[index];
      x.state = 'offered'; x.offerId = offerId; x.offeredAt = iso(); x.walletRejected = false;
      x.params = {...params, data: undefined, dataHash: inputs.txs[index].dataHash};
      event(x, 'offered', {offerId, preflight: pre});
    });
    return {state: 'offered', index, offerId, params, preflight: pre};
  });

  const report = (body) => exclusive(async () => {
    const index = idx(body.index);
    const e = journal.entries[index];
    if (!OPEN.has(e.state)) refuse('no_open_request', `${e.name} has no open wallet request (state ${e.state})`);
    if (typeof body.offerId !== 'string' || body.offerId !== e.offerId) refuse('offer_mismatch', 'report does not match the open offer');
    if (body.kind === 'hash') {
      if (!isHash(body.hash)) refuse('bad_request', 'hash must be 0x followed by 64 hex characters');
      const h = lc(body.hash);
      commit((j) => { const x = j.entries[index]; x.state = 'pending'; addHash(x, h); event(x, 'wallet_returned_hash', {hash: h, trusted: false}); });
      return {state: 'pending', index, hash: h, message: 'Hash recorded as untrusted. Reconcile re-verifies it on both providers.'};
    }
    if (body.kind === 'unknown') {
      commit((j) => {
        const x = j.entries[index]; x.state = 'pending';
        event(x, 'wallet_outcome_unknown', {code: Number.isInteger(body.code) ? body.code : null, message: text(body.message)});
      });
      return {state: 'pending', index, message: `Outcome unknown. Do not resend. Check wallet activity for nonce ${e.expectedNonce} and reconcile with its hash if one exists.`};
    }
    if (body.kind === 'rejected' || body.kind === 'not_sent') {
      if (e.state !== 'offered' || e.reportedHashes.length) refuse('rejection_not_applicable', `${e.name} already has a reported outcome; reconcile instead`);
      if (body.kind === 'rejected' && body.code !== 4001) refuse('bad_request', 'a wallet rejection must carry EIP-1193 code 4001');
      commit((j) => {
        const x = j.entries[index]; x.state = 'pending'; x.walletRejected = true;
        event(x, body.kind === 'rejected' ? 'wallet_rejected' : 'page_did_not_send', {message: text(body.message)});
      });
      try {
        const {snap, unused} = await nonceUnused(e);
        if (unused) {
          commit((j) => { const x = j.entries[index]; x.state = 'rejected'; event(x, 'rejection_settled_nonce_unused', {block: snap.number}); });
          return {state: 'rejected', index, message: `Nonce ${e.expectedNonce} is unused on both providers; ${e.name} may be offered again by a new explicit click.`};
        }
        return {state: 'pending', index, message: 'The nonce is no longer unused; reconcile before anything else.'};
      } catch (err) {
        return {state: 'pending', index, refusal: refusalView(err), message: 'Rejection recorded; nonce check failed, reconcile later.'};
      }
    }
    refuse('bad_request', 'kind must be hash, unknown, rejected or not_sent');
  });

  const reconcile = (body) => exclusive(async () => {
    const index = idx(body.index);
    let e = journal.entries[index];
    if (e.state === 'confirmed') return {state: 'confirmed', index, hash: e.hash, receipt: e.receipt};
    if (e.state === 'halted') refuse('halted', `${e.name} is halted (${e.outcome?.code}); root must reconcile manually`, {outcome: e.outcome});
    if (!OPEN.has(e.state)) refuse('nothing_to_reconcile', `${e.name} has no open wallet request (state ${e.state})`);
    if (body.hash !== undefined) {
      if (!isHash(body.hash)) refuse('bad_request', 'hash must be 0x followed by 64 hex characters');
      const h = lc(body.hash);
      if (!e.reportedHashes.includes(h)) {
        commit((j) => { const x = j.entries[index]; x.state = 'pending'; addHash(x, h); event(x, 'hash_supplied', {hash: h, trusted: false}); });
      }
      e = journal.entries[index];
    }
    const seen = [];
    for (const h of e.reportedHashes) {
      const v = await reader.verifyMined(index, h);
      seen.push({hash: h, kind: v.kind, code: v.code, message: v.message, problems: v.problems});
      if (v.kind === 'confirmed') {
        commit((j) => {
          const x = j.entries[index];
          x.state = 'confirmed'; x.hash = h; x.receipt = plain(v.receipt); x.runtimeCodehash = v.runtimeCodehash;
          x.outcome = {code: 'confirmed', checkedAt: plain(v.checkedAt)};
          event(x, 'confirmed', {hash: h, block: v.receipt.blockNumber, runtimeCodehash: v.runtimeCodehash});
        });
        return {state: 'confirmed', index, hash: h, receipt: v.receipt, next: nextIndexOf(journal)};
      }
      if (v.kind === 'mismatch') {
        commit((j) => {
          const x = j.entries[index];
          x.state = 'halted'; x.hash = h; x.receipt = plain(v.receipt); x.runtimeCodehash = v.runtimeCodehash;
          x.outcome = {code: v.code, problems: v.problems};
          event(x, 'halted', {hash: h, problems: v.problems});
        });
        return {state: 'halted', index, hash: h, problems: v.problems,
          message: 'A canonical owner transaction at the reviewed nonce differs from review. Nothing further is offered; root must reconcile.'};
      }
    }
    // No verified inclusion through a known hash: read the nonce and the predicted address at one agreed block.
    const snap = await reader.snapshot();
    const n = await reader.nonces(snap.at), exp = BigInt(e.expectedNonce);
    if (n.atBlock === exp) {
      const notFound = seen.every((s) => s.kind === 'not_found' || s.kind === 'unrelated');
      if (e.walletRejected && n.pending === exp && notFound && (await reader.codeAt(e.expectedAddress, snap.at)) === '0x') {
        commit((j) => { const x = j.entries[index]; x.state = 'rejected'; event(x, 'rejection_settled_nonce_unused', {block: snap.number}); });
        return {state: 'rejected', index, seen, message: `Nonce ${exp} unused on both providers; may be offered again by a new explicit click.`};
      }
      if (e.state === 'offered') commit((j) => { const x = j.entries[index]; x.state = 'pending'; event(x, 'not_observed', {block: snap.number}); });
      return {state: 'pending', index, seen, code: n.pending > exp ? 'pending_in_mempool' : 'not_observed',
        message: `Nonce ${exp} not consumed at block ${snap.number}. Do not resend. Wait, or supply the hash from wallet activity.`};
    }
    if (n.atBlock > exp) {
      const code = await reader.codeAt(e.expectedAddress, snap.at);
      if (code === inputs.txs[index].runtime.code) {
        return {state: e.state, index, seen, code: 'hash_required',
          message: `Nonce ${exp} is consumed and the exact reviewed runtime is at ${e.expectedAddress}. Copy that transaction hash from wallet activity and reconcile with it; inclusion is not accepted without hash, receipt and block membership.`};
      }
      if (seen.some((s) => s.kind === 'not_final')) {
        return {state: e.state, index, seen, code: 'not_final', message: 'A candidate is known but not final; reconcile again shortly.'};
      }
      commit((j) => {
        const x = j.entries[index]; x.state = 'halted';
        x.outcome = {code: code === '0x' ? 'nonce_consumed_without_reviewed_deployment' : 'unexpected_code_at_predicted_address', block: String(snap.number)};
        event(x, 'halted', x.outcome);
      });
      return {state: 'halted', index, seen, message: `Nonce ${exp} was consumed without the reviewed deployment at ${e.expectedAddress}. Nothing further is offered; root must reconcile.`};
    }
    refuse('nonce_regressed', `providers report owner nonce ${n.atBlock}, below the expected ${exp}`);
  });

  // Root CLI only (not routed over HTTP): releases an unobserved request after a quiet period so it may be offered again.
  const releaseUnknown = (body) => exclusive(async () => {
    if (body.confirmNoPendingWalletTx !== true) refuse('confirmation_required', 'root must confirm the wallet shows no pending transaction for this nonce');
    const index = idx(body.index);
    const e = journal.entries[index];
    if (!OPEN.has(e.state)) refuse('nothing_to_release', `${e.name} is ${e.state}`);
    const age = now() - Date.parse(e.offeredAt);
    if (!(age >= limits.releaseQuietMs)) refuse('quiet_period', `offer is ${Math.floor(age / 1000)}s old; wait ${limits.releaseQuietMs / 1000}s`);
    for (const h of e.reportedHashes) {
      const v = await reader.verifyMined(index, h);
      if (v.kind !== 'not_found' && v.kind !== 'unrelated') refuse('candidate_known', `candidate ${h} is ${v.kind}; reconcile it instead`);
    }
    const {snap, unused} = await nonceUnused(e);
    if (!unused) refuse('nonce_in_use', `nonce ${e.expectedNonce} is not unused on both providers`);
    commit((j) => { const x = j.entries[index]; x.state = 'released'; event(x, 'root_released_unobserved_request', {block: snap.number, quietMs: age}); });
    return {state: 'released', index};
  });

  const state = () => plain({
    schema: 'enclave-funding-wallet-deploy-state-r1', signing: authStatus(), owner: inputs.owner, chainId: CHAIN_ID, chainHex: CHAIN_HEX,
    providers: PROVIDERS, digests: inputs.digests, toolSourceSha256: toolDigests, busy, seq: journal.seq,
    nextIndex: nextIndexOf(journal), halted: journal.entries.some((e) => e.state === 'halted'),
    cost: {...inputs.cost, caveat: costCaveat(inputs)},
    implementation: {address: inputs.implementation.address, runtimeCodehash: inputs.implementation.codehash, runtimeBytes: inputs.implementation.bytes},
    preserved: {oldBindings: inputs.oldBindings, pinnedCodehashes: inputs.bindings.length},
    transactions: inputs.txs.map((t) => ({index: t.index, name: t.name, nonce: t.nonce, from: inputs.owner, to: null, value: '0', chainId: CHAIN_ID,
      data: t.data, dataHash: t.dataHash, dataBytes: t.dataBytes, constructorArgs: t.constructorArgs, predictedAddress: t.predictedAddress,
      runtimeCodehash: t.runtime.codehash, runtimeBytes: t.runtime.bytes, gas: t.gas, maxFeePerGas: t.maxFeePerGas,
      maxPriorityFeePerGas: t.maxPriorityFeePerGas, l2CapWei: t.l2CapWei, l1ObservedWei: t.l1ObservedWei,
      operatorObservedWei: t.operatorObservedWei, totalObservedWei: t.totalObservedWei, journal: entryView(journal.entries[t.index])})),
  });

  return {state, prepare, report, reconcile, releaseUnknown, journal: () => structuredClone(journal), close: releaseLock};
}
