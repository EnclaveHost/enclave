// schema3 r1 owned-Anvil world (TEST ONLY). The ACTUAL schema-3 contracts from the reviewed precompiled bundle
// (deploy/lifecycle/schema3-accounting/artifacts/bundle.json, sources c720f1bf/946f0b90/ac4023b9/f8dae9ab): EnclaveLifecycleAccounting library deployed
// normally, EnclaveDeployments creation code linked to it with the pure linkTemplate, EnclaveDeploymentLifecycleEmergency,
// EnclaveSelfHostingIdentity and EnclaveProofOfTime. No compiler, no vm.etch, no code-size override (Anvil default EIP-170).
// Registry/catalog/USDC/host-ownership/closure contracts and the authority/receipt sources are the SAME labelled r5 TEST doubles
// (r5-world.mjs, precompiled by the root precompile step). Public generated TEST keys only; no production RPC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, getAddress, hashTypedData, keccak256, parseEther, toBytes } from 'viem';
import { S, account, send, dep, tx, codeHash, read, anvilReceipts, testAuthority, chainNow, HOST, MEAS, ZERO, ZERO32, MAX_T, RESERVE, MAX_GAS,
  CAP6, PAID6 } from './lifecycle-evm-base.mjs';
import { createLifecycleChainAdapter } from '../../network/deployment-chain-adapter.mjs';
import { linkTemplate } from '../../network/lifecycle-linked-artifacts.mjs';
import { SCHEMA3_ROLES, SCHEMA3_PROFILE } from '../../network/lifecycle-schema3-profile.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
export const BUNDLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/lifecycle/schema3-accounting/artifacts/bundle.json'), 'utf8'));
export const ART3 = Object.fromEntries(Object.entries(SCHEMA3_ROLES).map(([role, key]) => [role, BUNDLE.contracts[key]]));
export const L3 = { LEDGER: ART3.ledger.abi, LIFECYCLE: ART3.lifecycle.abi, PROVER: ART3.proofOfTime.abi, IDENTITY: ART3.identity.abi, LIBRARY: ART3.accountingLibrary.abi };
export const WINDOW = 600n, MAX_WINDOW = 3600n;
const deployRaw = async (from, abi, bytecode, args = [], gas = 5_000_000n) => (await send(from, { gas, data: encodeDeployData({ abi, bytecode, args }) })).contractAddress;
export const deployLibrary = from => deployRaw(from, L3.LIBRARY, ART3.accountingLibrary.creationTemplate, [], 8_000_000n);
export const deployLedger = (from, library, usdc, payout, registry) => deployRaw(from, L3.LEDGER,
  linkTemplate(ART3.ledger.creationTemplate, ART3.ledger.creationLinks, { [SCHEMA3_ROLES.accountingLibrary]: library }), [usdc, payout, registry, ZERO], 28_000_000n);
export const deployController = (from, ledger, l1Oracle) => deployRaw(from, L3.LIFECYCLE, ART3.lifecycle.creationTemplate, [ledger, l1Oracle], 12_000_000n);
export const deployProver = (from, ledger, registry) => deployRaw(from, L3.PROVER, ART3.proofOfTime.creationTemplate, [ledger, registry, WINDOW, MAX_WINDOW], 8_000_000n);
// the quorum-only per-deployment emergencyOffline, signed by THIS deployment's TEST witnesses, submitted by a TEST account
export async function emergency3(w, { target = 'queued', submitter = w.other } = {}) {
  const a = await w.assignment(), b = await S.pub.getBlock({ blockTag: 'latest' });
  const x = { id: w.id, generation: a[2], revision: a[3], fromState: 2, host: a[4], operator: a[5], target: target === 'stopped' ? 3 : 1,
    deadline: b.timestamp + 60n, payee: ZERO, maxReimburseWei: 0n };
  const typedData = { domain: { name: 'EnclaveDeploymentLifecycle.EmergencyOffline', version: '1', chainId: 8453, verifyingContract: w.contracts.lifecycle },
    types: { EmergencyOffline: [{ name: 'id', type: 'bytes32' }, { name: 'generation', type: 'uint64' }, { name: 'revision', type: 'uint64' },
      { name: 'fromState', type: 'uint8' }, { name: 'host', type: 'bytes32' }, { name: 'operator', type: 'address' }, { name: 'target', type: 'uint8' },
      { name: 'deadline', type: 'uint64' }, { name: 'payee', type: 'address' }, { name: 'maxReimburseWei', type: 'uint128' }] },
    primaryType: 'EmergencyOffline', message: x };
  const digest = hashTypedData(typedData);
  if (digest !== await read(w.contracts.lifecycle, L3.LIFECYCLE, 'emergencyDigest', [x])) throw Error('fixture: emergency typed data differs from the controller');
  const sigs = await Promise.all(w.witnesses.map(s => s.signTypedData(typedData)));
  const receipt = await tx(submitter, w.contracts.lifecycle, L3.LIFECYCLE, 'emergencyOffline', [x, sigs]);
  return { receipt, digest, x, cutoff: Number((await S.pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp) };
}
export const reconcile3 = (w, from = w.other) => tx(from, w.contracts.lifecycle, L3.LIFECYCLE, 'reconcileOffline', [w.id]);
