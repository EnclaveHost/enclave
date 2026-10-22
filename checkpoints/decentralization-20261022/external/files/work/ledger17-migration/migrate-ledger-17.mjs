#!/usr/bin/env node
// migrate-ledger-17: the rev-16d -> rev-17 ledger cutover tooling. See ../ledger17-migration-interface.txt.
//
//   snapshot                          READ-ONLY live Base: pin an agreed block, inventory every binding/balance
//   build --only <component>          ledger17 | proofOfTime | verificationFees | connectivity | pinned | governanceSeal
//   rehearse [--snapshot FILE]        LOCAL FORK ONLY (anvil, chain 31337, at the snapshot block)
//   plan --snapshot F --rehearsal R --migrator 0x…   UNSIGNED transaction plan for owner signing (chain 8453)
//   verify --plan FILE                READ-ONLY live: which plan steps have landed; code of every predicted address
//   replay --snapshot F --migrator 0x…           plan v2 on an IMPERSONATION-ONLY chain-8453 fork (no key exists there)
//   plan2 --snapshot F --replay R                plan v2: every tx executed in the replay, costs measured, unknowns explicit
//   verify2 --plan2 FILE              READ-ONLY live: migrator nonce, every predicted address still empty; admin-retaining plan required
//   status
//
// There is no command that signs or sends to Base, and none will be added here: the owners sign the plan's
// transactions with their own wallets. Gates G1-G5 are in lib/live.mjs, lib/fork.mjs and lib/gates.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { keccak256 } from 'viem';
import { HERE } from './lib/abis.mjs';
import { pinBlock, codeAt, agree } from './lib/live.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const latest = (dir) => { const f = fs.readdirSync(path.join(HERE, dir)).filter((x) => x.endsWith('.json')).sort().pop(); return f ? path.join(HERE, dir, f) : null; };
const out = (v) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 1));

async function main() {
  if (cmd === 'snapshot') { const { takeSnapshot } = await import('./snapshot.mjs'); const r = await takeSnapshot(); return out({ file: r.file, digest: r.digest, block: r.snapshot.block }); }
  if (cmd === 'build') { const { build } = await import('./build.mjs'); return out(await build(arg('--only'))); }
  if (cmd === 'rehearse') { const { rehearse } = await import('./rehearse.mjs'); const r = await rehearse({ snapshotFile: arg('--snapshot') || latest('snapshots') });
    process.exitCode = r.report.result === 'pass' ? 0 : 1; return out({ file: r.file, result: r.report.result, error: r.report.error }); }
  if (cmd === 'plan') { const { makePlan } = await import('./plan.mjs'); const r = await makePlan({ snapshotFile: arg('--snapshot'), rehearsalFile: arg('--rehearsal'), migrator: arg('--migrator') });
    return out({ file: r.file, sha256: r.sha256, txs: r.plan.transactions.length, usdc: r.plan.usdc }); }
  if (cmd === 'verify') {   // read-only: is anything of the plan live yet?
    const plan = JSON.parse(fs.readFileSync(arg('--plan'), 'utf8'));
    const block = await pinBlock();
    const res = {};
    for (const [k, a] of Object.entries(plan.addresses)) { const addr = String(a).split(' ')[0]; const c = await codeAt(block, addr); res[k] = { address: addr, deployed: c.length > 2, codeHash: c.length > 2 ? keccak256(c) : null }; }
    const nonce = Number(await agree('eth_getTransactionCount', [plan.migrator.address, '0x' + block.number.toString(16)]));
    return out({ block: block.number, migratorNonceNow: nonce, migratorNonceAtPlan: plan.migrator.nonceAtSnapshot, contracts: res,
      note: nonce !== plan.migrator.nonceAtSnapshot ? 'the migrator nonce moved: predicted addresses are void; regenerate the plan' : 'no migrator transaction has landed since the plan' });
  }
  if (cmd === 'replay') { const { replay } = await import('./replay.mjs'); const r = await replay({ snapshotFile: arg('--snapshot'), migrator: arg('--migrator') });
    process.exitCode = r.rep.result === 'pass' ? 0 : 1; return out({ file: r.file, result: r.rep.result, error: r.rep.error?.split('\n')[0], regressions: r.rep.continuity?.regressions }); }
  if (cmd === 'plan2') { const { writePlan2 } = await import('./plan2.mjs'); const r = await writePlan2({ snapshotFile: arg('--snapshot'), replayFile: arg('--replay') });
    return out({ file: r.file, sha256: r.sha256, txs: r.plan.transactions.length }); }
  if (cmd === 'verify2') {   // read-only: is the plan still executable as written?
    const plan = JSON.parse(fs.readFileSync(arg('--plan2'), 'utf8'));
    const {assertAdminRetainedReplay}=await import('./plan2.mjs');
    if(plan.version!==3)throw Error('superseded migration plan; regenerate with admin retention');
    assertAdminRetainedReplay({result:plan.replay?.result,governancePolicy:plan.governancePolicy,checks:{adminRetained:plan.adminControls},addresses:plan.addresses,executed:plan.transactions},plan.admin);
    const block = await pinBlock();
    const nonce = Number(await agree('eth_getTransactionCount', [plan.migrator.address, '0x' + block.number.toString(16)]));
    const occupied = [];
    for (const [k, a] of Object.entries(plan.addresses)) { const reused = ['EnclaveLedgerBandwidth', 'sessionVaultLib', 'hostOwnership'].includes(k);
      const c = await codeAt(block, a); if ((c.length > 2) !== reused) occupied.push({ k, address: a, hasCode: c.length > 2, expected: reused ? 'live, reused' : 'empty until executed' }); }
    const ok = nonce === plan.migrator.nonceAtSnapshot && !occupied.length;
    process.exitCode = ok ? 0 : 1;
    return out({ block: block.number, executableAsWritten: ok, migratorNonceNow: nonce, migratorNonceInPlan: plan.migrator.nonceAtSnapshot, unexpected: occupied,
      governancePolicy: plan.governancePolicy, note: ok ? 'predicted addresses still valid' : 'REGENERATE: the plan no longer matches chain state' });
  }
  if (cmd === 'status') return out({ snapshots: fs.readdirSync(path.join(HERE, 'snapshots')), rehearsals: fs.readdirSync(path.join(HERE, 'rehearsal')),
    plans: fs.readdirSync(path.join(HERE, 'plans')), builds: fs.readdirSync(path.join(HERE, 'build')) });
  console.error('usage: migrate-ledger-17.mjs snapshot | build --only NAME | rehearse [--snapshot F] | plan --snapshot F --rehearsal R --migrator 0x… | verify --plan P | status');
  process.exitCode = 2;
}
main().catch((e) => { console.error('error: ' + e.message); process.exitCode = 1; });
