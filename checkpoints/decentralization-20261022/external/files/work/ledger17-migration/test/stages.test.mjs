// Pure tests for plan v2's stage library: owner kinds and their exact carry recipes, stranded-escrow detection,
// deterministic seal addresses and configuration hashes. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, toHex, parseAbi, getContractAddress } from 'viem';
import { ownerKind, escrowStages, strandedAtRetire, configHash, sealDeployment, expectedLedgerGetters, LEDGER_SEAL_GETTERS, CREATE2_PROXY, serviceMetrics } from '../lib/stages.mjs';
import { LEDGER_ABI, ERC20 } from '../lib/abis.mjs';

const Z = '0x' + '0'.repeat(40);
const A = (n) => '0x' + String(n).padStart(40, '0');
const rec = (i, o = {}) => ({ id: keccak256(toHex('r' + i)), owner: A(i), appRef: 'catalog://a/' + i, ports: '', configCid: '', gpuMilli: 0, cpuMilli: 100, appPort: 80,
  isPublic: true, active: true, createdAt: 1n, rate: 100n, balance6: 10000n, spent6: 0n, runner: '0x' + '0'.repeat(64), runnerOperator: Z, leaseUntil: 0n,
  fee: { recipient: Z, rate6: 0n }, earn: { rate6: 80n, escrow6: 0n, creditedUntil: 0n }, cap6: 100n, refundable6: 0n, ownerEscrow6: 0n, provenUntil: 0n, ...o });

test('owner kinds come from evidence (code prefix, verified role), never assumed', () => {
  assert.equal(ownerKind({ contract: false }), 'eoa');
  assert.equal(ownerKind({ contract: true, code: '0xef01007179b77479c797bcf93361f0c3fab663d37f28d1' }), 'eip7702-eoa');
  assert.equal(ownerKind({ contract: true, code: '0x6080', kind: 'verification-fee wallet (controller: verificationFees)' }), 'fee-wallet');
  assert.equal(ownerKind({ contract: true, code: '0x6080', kind: 'session vault' }), 'legacy-session-vault');
  assert.equal(ownerKind({ contract: true, code: '0x363d3d37', kind: 'credit vault (book-bound)' }), 'credit-vault');
  assert.equal(ownerKind({ contract: true, code: '0x6080', kind: 'contract' }), 'contract-unknown');
});

test('escrow stages: exact calldata per owner kind; unsupported paths listed, never assumed', () => {
  const vault = A(50), vaultOwner = A(51), credit = A(60), eoa = A(70), d7702 = A(80);
  const post = [
    rec(1, { owner: eoa, earn: { rate6: 80n, escrow6: 1000n }, refundable6: 1000n }),                  // EOA: carry its own refund back
    rec(2, { owner: vault, earn: { rate6: 80n, escrow6: 500n }, refundable6: 500n }),                  // legacy session vault
    rec(3, { owner: credit, earn: { rate6: 80n, escrow6: 300n }, refundable6: 300n }),                 // credit vault: unsupported
    rec(4, { owner: d7702, earn: { rate6: 80n, escrow6: 200n }, refundable6: 200n }),                  // 7702-delegated EOA: same as EOA
    rec(5, { owner: eoa, active: false, earn: { rate6: 80n, escrow6: 100n }, refundable6: 100n }),     // inactive: nothing to continue
  ];
  const owners = [{ address: eoa, contract: false }, { address: vault, contract: true, code: '0x60', kind: 'session vault', ownerOf: vaultOwner },
    { address: credit, contract: true, code: '0x363d3d37', kind: 'credit vault (book-bound)' }, { address: d7702, contract: true, code: '0xef0100' + 'ab'.repeat(20) }];
  const OLD = A(900), NEW = A(901), USDC = A(902), PAYOUT = A(903);
  const st = escrowStages({ postOld: post, imported: post, owners, OLD, NEW, USDC, PAYOUT, feeWallets: [{ payer: eoa, wallet: A(990), source: keccak256(toHex('s')) }], feeRouter: A(904) });
  const by = (re) => st.txs.filter((t) => re.test(t.label));
  // EOA: approve + fundEscrow on its own active record, signed by itself
  const eoaFund = st.txs.filter((t) => t.signer.address === eoa && /fundEscrow/.test(t.label));
  assert.equal(eoaFund.length, 1);
  assert.deepEqual(decodeFunctionData({ abi: LEDGER_ABI, data: eoaFund[0].data }).args, [post[0].id, 1000n]);
  assert.equal(eoaFund[0].to, NEW);
  assert.deepEqual(decodeFunctionData({ abi: ERC20, data: st.txs.find((t) => t.signer.address === eoa && /approve/.test(t.label)).data }).args, [NEW, 1000n]);
  // 7702: same direct recipe as an EOA
  assert.equal(st.txs.filter((t) => t.signer.address === d7702 && /fundEscrow/.test(t.label)).length, 1);
  // vault: its OWNER withdraws directly (no signature), then carries from its own wallet; marked not owner-refundable
  const w = st.txs.find((t) => t.to === vault);
  const { args } = decodeFunctionData({ abi: parseAbi(['function withdraw(uint256,bytes32,uint64,bytes)']), data: w.data });
  assert.equal(w.signer.address, vaultOwner); assert.equal(args[0], 500n); assert.equal(args[3], '0x');
  assert.match(st.txs.find((t) => t.signer.address === vaultOwner && /fundEscrow/.test(t.label)).label, /NOT owner-refundable/);
  // credit vault: explicitly unsupported, with the reason
  assert.equal(st.unsupported.length, 1); assert.equal(st.unsupported[0].kind, 'credit-vault'); assert.match(st.unsupported[0].why, /no fundEscrow/);
  // inactive: a note, no transaction
  assert.ok(st.carry.some((c) => c.id === post[4].id && /inactive/.test(c.note)));
  // refunds pushed in one multicall, fee wallet revoked by its payer
  assert.equal(by(/refund push x5/).length, 1);
  assert.equal(by(/revoke/)[0].signer.address, eoa);
});

test('stranded escrow: non-owner escrow behind a still-fundable balance, with its serve-out time', () => {
  const s = strandedAtRetire([rec(1, { earn: { rate6: 462n, escrow6: 4667026n }, refundable6: 0n, balance6: 5838833n, rate: 578n }),
    rec(2, { earn: { rate6: 80n, escrow6: 100n }, refundable6: 100n }), rec(3, { earn: { rate6: 80n, escrow6: 100n }, refundable6: 0n, balance6: 50n })]);
  assert.equal(s.length, 1);
  assert.equal(s[0].stranded6, 4667026n); assert.equal(s[0].serveOutSeconds, 4667026n / 462n);
});

test('seals: CREATE2 address and configuration hash are deterministic and bind every committed value', () => {
  const SEAL = { abi: [{ type: 'constructor', inputs: [{ type: 'address' }, { type: 'bytes4[]' }, { type: 'bytes32' }] }], bytecode: { object: '6080' } };
  const P = { payout: A(1), usdc: A(2), registry: A(3), ethUsdFeed: A(4), leaseSec: 1800n, maxGpuMilli: 1000, maxFeePerSec6: 1389n, runnerBps: 8000, claimBond6: 0n, bondExitDelay: 86400n, proofRequiredFrom: 5n };
  const values = expectedLedgerGetters({ P, prover: A(5), feeRouter: A(6), bandwidthRouter: A(7) });
  const h1 = configHash({ chainId: 8453, target: A(9), codeHash: keccak256('0x01'), getters: LEDGER_SEAL_GETTERS, values });
  assert.equal(h1, configHash({ chainId: 8453, target: A(9), codeHash: keccak256('0x01'), getters: LEDGER_SEAL_GETTERS, values }));
  for (const changed of [{ chainId: 31337 }, { target: A(10) }, { codeHash: keccak256('0x02') }])
    assert.notEqual(configHash({ chainId: 8453, target: A(9), codeHash: keccak256('0x01'), getters: LEDGER_SEAL_GETTERS, values, ...changed }), h1);
  const v2 = expectedLedgerGetters({ P: { ...P, payout: A(99) }, prover: A(5), feeRouter: A(6), bandwidthRouter: A(7) });
  assert.notEqual(configHash({ chainId: 8453, target: A(9), codeHash: keccak256('0x01'), getters: LEDGER_SEAL_GETTERS, values: v2 }), h1, 'a changed payout breaks the seal');
  const s = sealDeployment({ SEAL, target: A(9), getters: LEDGER_SEAL_GETTERS, hash: h1, saltLabel: 'x' });
  assert.equal(s.address, getContractAddress({ opcode: 'CREATE2', from: CREATE2_PROXY, salt: s.salt, bytecode: s.initcode }));
  assert.equal(s.data.slice(0, 66), s.salt);
  assert.ok(!LEDGER_SEAL_GETTERS.includes('owner()') && !LEDGER_SEAL_GETTERS.includes('pendingOwner()'));
});

test('service metrics: paid seconds are bounded by escrow and by funded runtime', () => {
  const m = serviceMetrics(rec(1, { balance6: 1000n, rate: 10n, earn: { rate6: 8n, escrow6: 40n } }), ['h']);
  assert.equal(m.fundableSeconds, '100'); assert.equal(m.paidSeconds, '5'); assert.equal(m.claimableHosts, 1);
  assert.equal(serviceMetrics(rec(2, { rate: 0n, earn: { rate6: 0n, escrow6: 0n } }), []).paidSeconds, 'free');
});
