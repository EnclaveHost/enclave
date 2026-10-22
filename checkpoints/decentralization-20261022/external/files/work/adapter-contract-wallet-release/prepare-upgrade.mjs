// Read-only production preparation. Never imports a signer or sends a transaction.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createPublicClient, http, encodeFunctionData, keccak256} from '../enclave/node_modules/viem/_esm/index.js';

const json = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const sha = x => createHash('sha256').update(x).digest('hex');
const outDir = new URL('../../outputs/adapter-contract-wallet-release/', import.meta.url);
const publication = JSON.parse(fs.readFileSync(new URL('publication.json', outDir)));
const profile = JSON.parse(fs.readFileSync(new URL('../../outputs/authority-profile/network-profile-base.json', import.meta.url)));
const ledgerPin = profile.contracts.deployments;
const catalogPin = profile.contracts.appCatalog;
const abi = JSON.parse(fs.readFileSync(new URL('../enclave/contracts/EnclaveDeployments.abi.json', import.meta.url)));
const catalogAbi = JSON.parse(fs.readFileSync(new URL('../enclave/contracts/EnclaveAppCatalog.abi.json', import.meta.url)));
const id = '0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33';
const urls = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.public.blockpi.network/v1/rpc/public'];
const peers = urls.map(url => ({url, c: createPublicClient({transport: http(url, {timeout: 15000, retryCount: 0})})}));
const heads = await Promise.all(peers.map(p => p.c.getBlockNumber()));
const blockNumber = heads.reduce((a, b) => a < b ? a : b) - 2n;
const states = await Promise.all(peers.map(async ({c}) => {
  if (await c.getChainId() !== 8453) throw Error('wrong chain');
  const before = await c.getBlock({blockNumber});
  const [code, catalogCode, record, app] = await Promise.all([
    c.getCode({address: ledgerPin.address, blockNumber}),
    c.getCode({address: catalogPin.address, blockNumber}),
    c.readContract({address: ledgerPin.address, abi, functionName: 'get', args: [id], blockNumber}),
    c.readContract({address: catalogPin.address, abi: catalogAbi, functionName: 'getApp', args: [publication.appId], blockNumber})
  ]);
  if (!code || keccak256(code) !== ledgerPin.codeHash || !catalogCode || keccak256(catalogCode) !== catalogPin.codeHash)
    throw Error('contract differs from reviewed authority profile');
  const after = await c.getBlock({blockNumber});
  if (before.hash !== after.hash) throw Error('block changed');
  return {hash: before.hash, record, app};
}));
if (states.some(s => json(s) !== json(states[0]))) throw Error('deployment/catalog state lacks three agreeing peers');
const {record, app, hash} = states[0];
if (record.owner.toLowerCase() !== publication.transaction.from.toLowerCase() || app.publisher.toLowerCase() !== record.owner.toLowerCase())
  throw Error('deployment owner/publisher changed');
if (Number(app.versionCount) !== publication.index) throw Error('publication index changed; regenerate and review publication');
const expectedOldRef = `catalog://${publication.appId}/${publication.index - 1}`;
if (record.appRef !== expectedOldRef || !record.active) throw Error('deployment version/active state changed');
const before = JSON.parse(record.configCid);
if (!before.config?.upload || before.config.upload.walletAudience?.toLowerCase() !== id)
  throw Error('existing deployment lacks reviewed upload audience/config');
if (!before.config.upload.allowOrigins?.includes('https://enclave.host'))
  throw Error('existing dashboard CORS origin absent; review required');
const after = structuredClone(before);
// Runtime and kernel artifacts need the generic file route, which is off by
// default. Keep the existing per-wallet/global budgets and four upload slots.
after.config.upload.maxFileBytes = 2147483648;
after.config.upload.contractWallets = {
  chainId: 8453, rpcs: urls, quorum: 2, confirmations: 2,
  max_age_secs: 120, timeout_secs: 5, max_bytes: 65536
};
const newConfig = JSON.stringify(after);
const newRef = `catalog://${publication.appId}/${publication.index}`;
const calls = [
  encodeFunctionData({abi, functionName: 'setAppRef', args: [id, newRef]}),
  encodeFunctionData({abi, functionName: 'setConfig', args: [id, newConfig]})
];
const data = encodeFunctionData({abi, functionName: 'multicall', args: [calls]});
await Promise.all(peers.map(({c}) => c.simulateContract({
  account: record.owner, address: ledgerPin.address, abi, functionName: 'multicall', args: [calls], blockNumber
})));
const gas = await peers[0].c.estimateGas({account: record.owner, to: ledgerPin.address, data});
const prepared = {
  status: 'prepared-not-signed', preparedAt: new Date().toISOString(), chainId: 8453,
  blockNumber: blockNumber.toString(), blockHash: hash, agreeingRpcPeers: urls,
  deployment: id, version: publication.version, artifact: publication.artifact,
  sourceCommit: publication.sourceCommit, ledgerCodeHash: ledgerPin.codeHash,
  oldAppRef: record.appRef, newAppRef: newRef,
  oldConfigSha256: sha(record.configCid), newConfigSha256: sha(newConfig),
  oldConfigBytes: Buffer.byteLength(record.configCid), newConfigBytes: Buffer.byteLength(newConfig),
  changedConfigFields: {
    'config.upload.maxFileBytes': {before: before.config.upload.maxFileBytes ?? 0, after: after.config.upload.maxFileBytes},
    'config.upload.contractWallets': after.config.upload.contractWallets
  },
  preservedConfigFields: 'Every other existing field, including storage, upload restrictions, CORS origins, routing and WASM runtime flags.',
  transaction: {from: record.owner, to: ledgerPin.address, value: '0x0', data, estimatedGas: gas.toString()},
  simulationScope: 'Owner-authorized ledger atomic appRef/config update only. The ledger does not parse catalog refs, so this does NOT prove that an unpublished version can run.',
  prerequisites: [
    'Publish the exact artifact in publication.json, then verify version 1.0.18/index 18/CID and approval through agreeing RPCs.',
    'Re-read owner, active state, appRef, full configuration hash, contract pins and catalog state immediately before signing. Any drift requires regenerating and reviewing this transaction.',
    'After confirmation, verify the actual host applies the new component/config, preserves data and EOA uploads, and accepts contract-wallet uploads plus browser CORS/readback. Verify signed generic file upload/readback and unsigned/wrong-scope refusal; storing a file does not authorize it as a runtime.',
    'No catalog publication, upgrade, configuration change, wallet prompt or transaction submission has occurred during preparation.'
  ]
};
fs.writeFileSync(new URL('upgrade.json', outDir), JSON.stringify(prepared, null, 2) + '\n', {mode: 0o600});
console.log(JSON.stringify({
  status: prepared.status, version: prepared.version, blockNumber: prepared.blockNumber,
  simulatedPeers: peers.length, estimatedGas: gas.toString(),
  changedFields: Object.keys(prepared.changedConfigFields),
  configBytes: [prepared.oldConfigBytes, prepared.newConfigBytes]
}));
