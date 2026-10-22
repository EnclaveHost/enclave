#!/usr/bin/env node
// Deploy the EXACT soljson-built candidate (out/*.json from scripts/build.mjs: the pinned compiler at the live
// settings) to a local anvil at its DEFAULT code-size limit (0x6000 = 24,576 bytes, EIP-170) and drive it:
//   1. the node refuses a 24,577-byte runtime and accepts 24,576 (the limit is real here);
//   2. EnclaveLedgerBandwidth, EnclaveLeaseGeneration (linked) and EnclaveDeployments (both linked) deploy, and the
//      code on chain equals the artifact with exactly its immutables and links filled in;
//   3. ONE mined block holds claim (gen 1), releaseLease(gen 1), claim (gen 2, identical leaseUntil) and a stale
//      releaseLease(gen 1): the stale one reverts, the lease of gen 2 survives;
//   4. guardedReleaseOnly refuses the legacy release(id) for the opted-in key and nobody else's.
// Local only: anvil's public dev accounts, no external RPC, nothing printed but results. Writes out/anvil-smoke.json.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createTestClient, createWalletClient, http, encodeDeployData, encodeFunctionData, decodeEventLog,
  keccak256, toHex, parseAbi, getAddress } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const C = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const art = (n) => JSON.parse(fs.readFileSync(path.join(C, 'out', n + '.json'), 'utf8'));
const forgeArt = (f, n) => JSON.parse(fs.readFileSync(path.join(C, 'forge/out', f, n + '.json'), 'utf8'));
const LEDGER = art('EnclaveDeployments'), LIB_BW = art('EnclaveLedgerBandwidth'), LIB_GEN = art('EnclaveLeaseGeneration');
const LEASES = art('IEnclaveDeploymentsLeases');
const USDC = forgeArt('MockUSDC.sol', 'MockUSDC'), REG = forgeArt('LeaseRig.sol', 'LeaseRegistry');
const ABI = [...LEDGER.abi, ...LEASES.abi.filter((e) => !LEDGER.abi.some((x) => x.type === e.type && x.name === e.name))];

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const port = await freePort();
const anvil = spawn('anvil', ['--port', String(port), '--host', '127.0.0.1', '--silent', '--chain-id', '31337'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stop = () => { try { anvil.kill('SIGTERM'); } catch {} };
process.on('exit', stop);
const report = { anvil: { port, codeSizeLimit: 'default (0x6000)' } };
try {
  const transport = http(`http://127.0.0.1:${port}`);
  const pub = createPublicClient({ chain: foundry, transport });
  for (let i = 0; ; i++) { try { await pub.getChainId(); break; } catch { if (i > 100) throw Error('anvil did not start'); await new Promise((r) => setTimeout(r, 100)); } }
  const test = createTestClient({ chain: foundry, mode: 'anvil', transport });
  // anvil's well-known PUBLIC development mnemonic (not a secret, holds nothing anywhere else)
  const acct = (i) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: i });
  const [deployer, opA, user, opB] = [0, 1, 2, 3].map(acct);
  const wallet = (a) => createWalletClient({ chain: foundry, transport, account: a });
  const send = async (a, to, abi, functionName, args, opts = {}) => {
    const hash = await wallet(a).sendTransaction({ to, data: encodeFunctionData({ abi, functionName, args }), gas: 2_000_000n, ...opts });
    return hash;
  };
  const deploy = async (a, bytecode, abi = [], args = []) => {
    const hash = await wallet(a).sendTransaction({ data: abi.length ? encodeDeployData({ abi, bytecode, args }) : bytecode, gas: 29_000_000n });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r;
  };

  // 1. the limit is enforced by this node
  const initFor = (size) => `0x61${size.toString(16).padStart(4, '0')}6000f3`;
  const big = await deploy(deployer, initFor(24577)), edge = await deploy(deployer, initFor(24576));
  report.eip170Probe = { runtime24577: big.status, runtime24576: edge.status, edgeCodeBytes: (await pub.getCode({ address: edge.contractAddress })).length / 2 - 1 };
  if (big.status !== 'reverted' || edge.status !== 'success') throw Error('anvil does not enforce EIP-170 as expected: ' + JSON.stringify(report.eip170Probe));

  // 2. deploy the exact artifacts
  const link = (b, refs, addrs) => {
    let o = b.object;
    for (const libs of Object.values(refs || {})) for (const [lib, places] of Object.entries(libs))
      for (const { start, length } of places) o = o.slice(0, start * 2) + addrs[lib].slice(2).toLowerCase() + o.slice((start + length) * 2);
    return '0x' + o;
  };
  const bw = await deploy(deployer, link(LIB_BW.bytecode, LIB_BW.bytecode.linkReferences, {}));
  const gen = await deploy(deployer, link(LIB_GEN.bytecode, LIB_GEN.bytecode.linkReferences, { EnclaveLedgerBandwidth: bw.contractAddress }));
  const usdc = await deploy(deployer, '0x' + USDC.bytecode.object.replace(/^0x/, ''));
  const reg = await deploy(deployer, '0x' + REG.bytecode.object.replace(/^0x/, ''));
  const addrs = { EnclaveLedgerBandwidth: bw.contractAddress, EnclaveLeaseGeneration: gen.contractAddress };
  const payout = acct(5).address;
  const led = await deploy(deployer, link(LEDGER.bytecode, LEDGER.bytecode.linkReferences, addrs), LEDGER.abi,
    [usdc.contractAddress, payout, reg.contractAddress, '0x0000000000000000000000000000000000000000']);
  if (led.status !== 'success') throw Error('ledger deployment failed');
  const L = led.contractAddress, onChain = await pub.getCode({ address: L });
  // expected runtime: the artifact with links and the two immutables (usdc, registry) filled in
  let exp = link(LEDGER.deployedBytecode, LEDGER.deployedBytecode.linkReferences, addrs).slice(2);
  const imm = Object.values(LEDGER.deployedBytecode.immutableReferences || {});
  const words = [usdc.contractAddress, reg.contractAddress].map((a) => a.slice(2).toLowerCase().padStart(64, '0'));
  let matched = null;
  for (const order of [[0, 1], [1, 0]]) {
    let o = exp;
    imm.forEach((refs, i) => { for (const { start, length } of refs) o = o.slice(0, start * 2) + words[order[i]].slice(-length * 2) + o.slice((start + length) * 2); });
    if ('0x' + o === onChain.toLowerCase()) matched = order;
  }
  report.deployment = { ledger: L, runtimeBytes: (onChain.length - 2) / 2, initcodeBytes: (LEDGER.bytecode.object.length) / 2,
    libraries: { EnclaveLedgerBandwidth: { address: bw.contractAddress, runtimeBytes: ((await pub.getCode({ address: bw.contractAddress })).length - 2) / 2 },
      EnclaveLeaseGeneration: { address: gen.contractAddress, runtimeBytes: ((await pub.getCode({ address: gen.contractAddress })).length - 2) / 2 } },
    codeEqualsLinkedArtifact: !!matched, codeHash: keccak256(onChain), gasUsed: String(led.gasUsed),
    schema: String(await pub.readContract({ address: L, abi: ABI, functionName: 'deploymentsSchema' })) };
  if (!matched) throw Error('on-chain code differs from the linked artifact');

  // 3. one block: claim, named release, re-claim (same leaseUntil), stale named release
  const A1 = keccak256(toHex('host-a1'));
  const REGABI = REG.abi, USDCABI = USDC.abi;
  for (const h of [await send(deployer, reg.contractAddress, REGABI, 'set', [A1, opA.address, 834n, 1667n]),
    await send(deployer, L, ABI, 'setProofRequiredFrom', [0n]),
    await send(deployer, usdc.contractAddress, USDCABI, 'mint', [user.address, 1_000_000_000_000n]),
    await send(user, usdc.contractAddress, USDCABI, 'approve', [L, 2n ** 255n])]) await pub.waitForTransactionReceipt({ hash: h });
  const cHash = await send(user, L, ABI, 'create', ['catalog://app/0', 0, 1000, 8080, '', true, '', '0x0000000000000000000000000000000000000000', 0n, 834n]);
  const cRec = await pub.waitForTransactionReceipt({ hash: cHash });
  const id = cRec.logs.map((l) => { try { return decodeEventLog({ abi: ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'Created').args.id;
  await pub.waitForTransactionReceipt({ hash: await send(user, L, ABI, 'fund', [id, 100_000_000n]) });

  await test.setAutomine(false);
  const nonce = await pub.getTransactionCount({ address: opA.address });
  const hs = [];
  hs.push(await send(opA, L, ABI, 'claim', [id, A1], { nonce }));
  hs.push(await send(opA, L, ABI, 'releaseLease', [id, A1, 1n], { nonce: nonce + 1 }));
  hs.push(await send(opA, L, ABI, 'claim', [id, A1], { nonce: nonce + 2 }));
  hs.push(await send(opA, L, ABI, 'releaseLease', [id, A1, 1n], { nonce: nonce + 3 }));   // the stale duplicate
  await test.mine({ blocks: 1 });
  await test.setAutomine(true);
  const recs = await Promise.all(hs.map((hash) => pub.waitForTransactionReceipt({ hash })));
  const evs = (r) => r.logs.map((l) => { try { return decodeEventLog({ abi: ABI, ...l }); } catch { return null; } }).filter(Boolean);
  const claimed = recs.filter((_, i) => i % 2 === 0).map((r) => evs(r).find((e) => e.eventName === 'Claimed').args.leaseUntil);
  const opened = recs.filter((_, i) => i % 2 === 0).map((r) => evs(r).find((e) => e.eventName === 'LeaseOpened').args.generation);
  const lease = await pub.readContract({ address: L, abi: ABI, functionName: 'leaseOf', args: [id] });
  let staleReason = null;
  try { await pub.call({ account: opA.address, to: L, data: encodeFunctionData({ abi: ABI, functionName: 'releaseLease', args: [id, A1, 1n] }) }); }
  catch (e) { staleReason = (e.shortMessage || e.message).split('\n').find((l) => /not this lease/.test(l)) || (e.shortMessage || '').slice(0, 120); }
  report.sameBlock = { blockNumbers: [...new Set(recs.map((r) => String(r.blockNumber)))], statuses: recs.map((r) => r.status),
    leaseUntilOfBothClaims: claimed.map(String), generationsOpened: opened.map(String),
    leaseAfter: { runner: lease[0], operator: lease[1], leaseUntil: String(lease[2]), generation: String(lease[3]) }, staleRevert: staleReason,
    gasUsed: { claim: String(recs[0].gasUsed), releaseLease: String(recs[1].gasUsed) } };
  const okBlock = report.sameBlock.blockNumbers.length === 1 && JSON.stringify(recs.map((r) => r.status)) === '["success","success","success","reverted"]'
    && claimed[0] === claimed[1] && String(opened) === '1,2' && lease[3] === 2n && lease[1] === opA.address;
  if (!okBlock) throw Error('same-block scenario failed: ' + JSON.stringify(report.sameBlock));

  // 4. the opt-in guard, on a real node
  await pub.waitForTransactionReceipt({ hash: await send(opA, L, ABI, 'setGuardedReleaseOnly', [true]) });
  let legacy = null;
  try { await pub.call({ account: opA.address, to: L, data: encodeFunctionData({ abi: ABI, functionName: 'release', args: [id] }) }); legacy = 'succeeded'; }
  catch (e) { legacy = /guarded release only/.test(e.message) ? 'reverted: guarded release only' : 'reverted: ' + (e.shortMessage || '').slice(0, 80); }
  const named = await pub.waitForTransactionReceipt({ hash: await send(opA, L, ABI, 'releaseLease', [id, A1, 2n]) });
  report.guard = { optedIn: await pub.readContract({ address: L, abi: ABI, functionName: 'guardedReleaseOnly', args: [opA.address] }),
    legacyReleaseByOptedInKey: legacy, namedRelease: named.status, otherKeyOptedIn: await pub.readContract({ address: L, abi: ABI, functionName: 'guardedReleaseOnly', args: [opB.address] }) };
  if (legacy !== 'reverted: guarded release only' || named.status !== 'success') throw Error('guard scenario failed: ' + JSON.stringify(report.guard));
  report.result = 'pass';
} catch (e) {
  report.result = 'fail'; report.error = String(e.message).slice(0, 600);
} finally {
  stop();
  fs.writeFileSync(path.join(C, 'out/anvil-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 1));
  process.exitCode = report.result === 'pass' ? 0 : 1;
}
