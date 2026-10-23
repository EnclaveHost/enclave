// A local Base-like L2 (anvil `--network optimism --hardfork isthmus --chain-id 8453`) with helpers shared by the vault
// and fee tests: deploy the pinned compiled artifacts (library links by linkReferences), send setup transactions with
// TEST keys, and execute exactly the 0x7E deposit that a REAL portal log derives (viem). "Verified head" = the latest
// anvil block, labelled; in production it is Helios / P's root store.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import * as viem from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { serializeTransaction, getSourceHash, getL2TransactionHash, opaqueDataToDepositData, extractTransactionDepositedLogs } from 'viem/op-stack';

export const ART = (n) => JSON.parse(fs.readFileSync(new URL(`../../fixtures/artifacts/${n}.json`, import.meta.url)));
export const SRC = (n) => fs.readFileSync(new URL(`../../fixtures/sources/${n}`, import.meta.url));
const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

export async function startL2() {
  const port = await free();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn('anvil', ['--network', 'optimism', '--hardfork', 'isthmus', '--chain-id', '8453', '--port', String(port), '--host', '127.0.0.1', '--base-fee', '10000000', '--silent'], { stdio: 'ignore' });
  const rpc = async (method, params = []) => {
    const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
  };
  for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const chain = viem.defineChain({ id: 8453, name: 'local-8453', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pc = viem.createPublicClient({ chain, transport: viem.http(url) });
  const wc = (key) => viem.createWalletClient({ chain, account: privateKeyToAccount(key), transport: viem.http(url) });
  const DEV = generatePrivateKey();
  await rpc('anvil_setBalance', [privateKeyToAccount(DEV).address, '0x56bc75e2d63100000']);
  async function send(key, tx, { allowRevert = false } = {}) {
    const h = await wc(key).sendTransaction({ gas: 8_000_000n, ...tx });
    const rc = await pc.waitForTransactionReceipt({ hash: h });
    if (rc.status !== 'success' && !allowRevert) throw new Error('reverted: ' + (tx.label || '')); return rc;
  }
  function link(a, libs) {
    let hex = a.bytecode.object.slice(2);
    for (const [file, names] of Object.entries(a.bytecode.linkReferences || {}))
      for (const [name, refs] of Object.entries(names)) for (const r of refs) hex = hex.slice(0, r.start * 2) + libs[`${file}:${name}`].slice(2).toLowerCase() + hex.slice((r.start + r.length) * 2);
    return '0x' + hex;
  }
  async function deploy(a, args = [], libs = {}, key = DEV) {
    const bytecode = Object.keys(a.bytecode.linkReferences || {}).length ? link(a, libs) : a.bytecode.object;
    return (await send(key, { data: viem.encodeDeployData({ abi: a.abi, bytecode, args }) })).contractAddress;
  }
  const write = (key, address, abi, functionName, args = [], value = 0n, opts) => send(key, { to: address, data: viem.encodeFunctionData({ abi, functionName, args }), value, label: functionName }, opts);
  const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });
  const headNow = async () => { const b = await pc.getBlock(); return { number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp), verifiedBy: 'signed-head' }; };
  const warp = async (ts) => { await rpc('evm_setNextBlockTimestamp', [Number(ts)]); await rpc('evm_mine'); };
  const fund = (a) => rpc('anvil_setBalance', [a, '0xde0b6b3a7640000']);
  /** The L2 deposit a REAL portal log derives (viem), executed here. */
  async function executeLog(log) {
    const sourceHash = getSourceHash({ domain: 'userDeposit', l1BlockHash: log.blockHash, l1LogIndex: log.logIndex });
    const d = opaqueDataToDepositData(log.args.opaqueData);
    const raw = serializeTransaction({ type: 'deposit', sourceHash, from: log.args.from, to: log.args.to, mint: d.mint, value: d.value, gas: d.gas, isSystemTx: false, data: d.data });
    const hash = await rpc('eth_sendRawTransaction', [raw]);
    assert.equal(hash, getL2TransactionHash({ log }), 'the L2 executed exactly the deposit viem derives from the real L1 log');
    return { hash, receipt: await pc.waitForTransactionReceipt({ hash }) };
  }
  /** Load a captured account set (code + storage) from a research capture onto this chain. */
  async function loadCapture(capture) {
    for (const [a, acc] of Object.entries(capture.accounts)) {
      if (acc.code && acc.code !== '0x') await rpc('anvil_setCode', [a, acc.code]);
      for (const [k, v] of Object.entries(acc.storage)) await rpc('anvil_setStorageAt', [a, k, viem.pad(v)]);
    }
  }
  return { url, rpc, pc, chain, wc, DEV, send, deploy, write, read, headNow, warp, fund, executeLog, loadCapture, stop: () => proc.kill('SIGKILL') };
}

/** Plan -> real L1 portal transaction (TEST key or through a contract wallet) -> module match -> derived L2 deposit. */
export async function forceInclude(F, l1, l2, plan, { key, through, relayerKey } = {}) {
  const rc = through ? await l1.send(relayerKey, { to: through, data: plan.l1Transaction.data }) : await l1.send(key, plan.l1Transaction);
  const m = F.matchDepositEvent(plan, rc, { verifiedBy: 'test-anvil-l1', headerHash: rc.blockHash }, { verifiers: ['test-anvil-l1'] });
  const [log] = extractTransactionDepositedLogs({ logs: rc.logs });
  const out = await l2.executeLog(log);
  assert.equal(out.hash, m.l2TransactionHash);
  return { ...out, l1: rc, log };
}

/**
 * The app-funded lease world on `l2`: live ledger rev 16d, registry schema 4, EnclaveLeaseGasReserve (with the given
 * L1 fee oracle and l1Bps) and EnclaveLeaseExecutor; a registered host whose key is delegated to the executor and then
 * holds no ETH; an app created, funded and its reserve enabled by its owner with `policy`.
 */
export async function setupLeaseWorld(l2, { l1Oracle = viem.zeroAddress, l1Bps = 0, policy = {}, limits = {} } = {}) {
  const A = {}; for (const n of ['EnclaveLeaseExecutor', 'EnclaveLeaseGasReserve', 'EnclaveDeployments', 'EnclaveLedgerBandwidth', 'EnclaveRegistry', 'MockUSDC', 'MockFeed']) A[n] = ART(n);
  const addr = {};
  addr.usdc = await l2.deploy(A.MockUSDC);
  addr.feed = await l2.deploy(A.MockFeed);
  await l2.write(l2.DEV, addr.feed, A.MockFeed.abi, 'set', [300000000000n, (await l2.pc.getBlock()).timestamp]);
  addr.registry = await l2.deploy(A.EnclaveRegistry);
  addr.lib = await l2.deploy(A.EnclaveLedgerBandwidth);
  addr.ledger = await l2.deploy(A.EnclaveDeployments, [addr.usdc, privateKeyToAccount(generatePrivateKey()).address, addr.registry, addr.feed], { 'src/live/EnclaveDeployments.sol:EnclaveLedgerBandwidth': addr.lib });
  addr.reserve = await l2.deploy(A.EnclaveLeaseGasReserve, [addr.ledger, addr.registry, l1Oracle,
    { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 29500, overheadRenewGas: 24000, overheadReleaseGas: 7000, minClaimInterval: 60, l1Bps, ...limits }]);
  addr.executor = await l2.deploy(A.EnclaveLeaseExecutor, [addr.reserve]);
  await l2.write(l2.DEV, addr.reserve, A.EnclaveLeaseGasReserve.abi, 'bindExecutor', [addr.executor]);
  const opKey = generatePrivateKey(), operator = privateKeyToAccount(opKey).address, relayer = generatePrivateKey();
  const owner = { key: generatePrivateKey() }; owner.address = privateKeyToAccount(owner.key).address;
  for (const a of [operator, privateKeyToAccount(relayer).address, owner.address]) await l2.fund(a);
  const endpoint = 'https://api.enclave.host/t/world-' + Math.random().toString(16).slice(2);
  await l2.write(opKey, addr.registry, A.EnclaveRegistry.abi, 'register', [endpoint, 'EnclaveHost/enclave', '0x' + '00'.repeat(32), 1000n, 0n, '0x000000000000000000000000000000000000bEEF']);
  const enclaveId = viem.keccak256(viem.toBytes(endpoint));
  const auth = await l2.wc(opKey).signAuthorization({ account: privateKeyToAccount(opKey), contractAddress: addr.executor });
  await l2.send(relayer, { authorizationList: [auth], to: privateKeyToAccount(relayer).address, data: '0x' });
  await l2.rpc('anvil_setBalance', [operator, '0x0']);
  const args = ['catalog://app/0', 0, 500, 8080, '', true, '', viem.zeroAddress, 0n, 1000n];
  const id = (await l2.pc.simulateContract({ account: owner.address, address: addr.ledger, abi: A.EnclaveDeployments.abi, functionName: 'create', args })).result;
  await l2.write(owner.key, addr.ledger, A.EnclaveDeployments.abi, 'create', args);
  await l2.write(l2.DEV, addr.usdc, viem.parseAbi(['function mint(address,uint256)']), 'mint', [owner.address, 6_000_000n]);
  await l2.write(owner.key, addr.usdc, viem.parseAbi(['function approve(address,uint256) returns (bool)']), 'approve', [addr.ledger, 6_000_000n]);
  await l2.write(owner.key, addr.ledger, A.EnclaveDeployments.abi, 'fund', [id, 6_000_000n]);
  await l2.write(owner.key, addr.reserve, A.EnclaveLeaseGasReserve.abi, 'deposit', [id], 10n ** 16n);
  await l2.write(owner.key, addr.reserve, A.EnclaveLeaseGasReserve.abi, 'configure', [id, { enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4,
    maxPerOpWei: 10n ** 15n, epochCapWei: 5n * 10n ** 15n, epochSec: 3600, renewWindow: 300, minExtension: 600, claimCooldown: 1800, maxGasPrice: 100_000_000n, ...policy }]);
  const LEASE_TYPES = { Lease: [{ name: 'reserve', type: 'address' }, { name: 'id', type: 'bytes32' }, { name: 'kind', type: 'uint8' }, { name: 'enclaveId', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' }, { name: 'deadline', type: 'uint64' }, { name: 'payee', type: 'address' }, { name: 'maxChargeWei', type: 'uint256' }] };
  const signLease = (l) => privateKeyToAccount(opKey).signTypedData({ domain: { name: 'EnclaveLeaseExecutor', version: '1', chainId: 8453, verifyingContract: operator },
    types: LEASE_TYPES, primaryType: 'Lease', message: { reserve: addr.reserve, ...l } });
  return { A, addr, opKey, operator, relayer, owner, enclaveId, id, signLease, pins: { executor: addr.executor, reserve: addr.reserve, ledger: addr.ledger } };
}
