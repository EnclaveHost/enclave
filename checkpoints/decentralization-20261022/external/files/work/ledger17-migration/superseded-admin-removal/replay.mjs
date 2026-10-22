// replay: execute plan v2's EXACT chain-8453 transactions on an impersonation-only fork of Base at the snapshot block
// (no key exists on the node; every write is an unsigned node-local impersonated call). Proves the plan itself:
// predicted addresses, seal configuration hashes, runtime code, stranded-escrow serve-out, per-deployment continuity,
// owner carries by each owner's real execution method, conservation, entitlement and the end of admin powers.
// Writes rehearsal/replay-<block>.json. Reads only the allowlisted fork source; writes only to its own loopback node.
import fs from 'node:fs';
import path from 'node:path';
import { encodeFunctionData, getAddress, keccak256, stringToHex, toFunctionSelector, parseAbi } from 'viem';
import { HERE, LEDGER_ABI, ERC20, PROVER, OWNABLE, REGISTRY4 } from './lib/abis.mjs';
import { ForkNode } from './lib/fork.mjs';
import { readLedger, planImport, parity, prefixSlot } from './lib/ledgerstate.mjs';
import { assertCanImport, assertCanSeal, assertCanBack } from './lib/gates.mjs';
import { staticPlan, escrowStages, strandedAtRetire } from './plan2.mjs';
import { serviceMetrics } from './lib/stages.mjs';

const lc = (a) => String(a).toLowerCase();
const J = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const ANY = '0x000000000000000000000000000000000000c0DE';   // "anyone": an address with no code and no role

export async function replay({ snapshotFile, migrator, log = console.error }) {
  const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const block = BigInt(snap.block.number), P = snap.ledger.params, OLD = getAddress(snap.ledger.address);
  const rep = { kind: 'enclave.ledger17.plan2-replay', snapshot: { file: path.basename(snapshotFile), digest: snap.digest, block: snap.block },
    fork: { chainId: 8453, impersonationOnly: true }, executed: [], checks: {}, negative: {} };
  const node = await ForkNode.start({ block, log, chainId: 8453, impersonationOnly: true, logFile: path.join(HERE, 'rehearsal', `anvil-replay-${snap.block.number}.log`) });
  const exec = async (t, extra = {}) => {
    const from = t.signer.address && /^0x[0-9a-fA-F]{40}$/.test(t.signer.address) ? t.signer.address : ANY;
    const r = await node.send({ from, to: t.to || undefined, data: t.data, label: t.label, gas: 29_000_000n });
    const row = { phase: t.phase, label: t.label, signer: { ...t.signer, address: from === ANY && !t.signer.address ? null : from }, to: t.to, data: t.data, chainId: 8453, value: '0',
      irreversible: !!t.irreversible, gasUsed: String(r.gasUsed), status: r.status, ...extra };
    if (t.creates) { row.creates = t.creates; if (lc(r.contractAddress) !== lc(t.creates)) throw Error(`${t.label}: created ${r.contractAddress}, predicted ${t.creates}`); }
    if (t.createsViaCreate2) { row.createsViaCreate2 = t.createsViaCreate2; if ((await node.pub.getCode({ address: t.createsViaCreate2 }))?.length <= 2) throw Error(`${t.label}: nothing at the predicted CREATE2 address`); }
    for (const k of ['usdc6', 'targetCodeHash', 'preconditions']) if (t[k] !== undefined) row[k] = t[k];
    rep.executed.push(J(row)); log(`  ✓ [${t.phase}] ${t.label} ${r.gasUsed}`);
    return r;
  };
  try {
    await node.assertGuarded();
    if (keccak256(await node.pub.getCode({ address: OLD })) !== snap.code.deployments.codeHash) throw Error('fork ledger code differs from the snapshot');
    const nonce = await node.pub.getTransactionCount({ address: migrator });
    const S = staticPlan({ snap, migrator, nonce });
    Object.assign(rep, { migrator: { address: S.M, nonceAtSnapshot: nonce, note: 'example signer; every predicted address depends on it and this nonce; `verify` revalidates before execution' },
      addresses: S.addresses, predicted: S.predicted });
    const GOV = S.GOV, NEW = S.addresses.ledger17, PRF = S.addresses.proofOfTime17;

    // ---- the global administrative powers that exist before anything happens ----
    const PROFILE = JSON.parse(fs.readFileSync(path.join(HERE, '../enclave/contracts/deployments/network-profile-base.json'), 'utf8'));
    const gp = [];
    const targets = [...Object.entries(PROFILE.contracts).map(([k, c]) => [k, c.address, c.ownerPowers || []]), ['addressBook', snap.book.address, ['repoint every book key']]];
    for (const [name, address, powers] of targets) {
      let owner = null, pending = null; try { owner = await node.read(address, OWNABLE, 'owner'); } catch {} try { pending = await node.read(address, OWNABLE, 'pendingOwner'); } catch {}
      const code = (await node.pub.getCode({ address })) || '0x';
      const sealable = !!owner && code.includes(toFunctionSelector('acceptOwnership()').slice(2)) && code.includes(toFunctionSelector('pendingOwner()').slice(2));
      gp.push({ name, address, owner, pendingOwner: pending, sealableByGovernanceSeal: sealable, powers: powers.slice(0, 3) });
    }
    rep.globalPowers = gp.filter((g) => g.owner && !/^0x0{40}$/i.test(g.owner));

    // ---- pre: every active deployment's service on the OLD ledger ----
    const reg = await node.read(P.registry, REGISTRY4, 'getPage', [0n, 200n]);
    const hosts = reg.filter((h) => h.active && h.cpuPricePerSec6 > 0n && !/^0x0{40}$/i.test(h.proofKey)).map((h) => ({ id: keccak256(stringToHex(h.endpoint)), endpoint: h.endpoint, operator: h.operator }));
    const claimers = async (L, id) => { const out = []; for (const h of hosts) if (await node.read(L, LEDGER_ABI, 'claimableBy', [id, h.id])) out.push(h.endpoint); return out; };
    const oldNow = await readLedger(node, OLD);
    const ts0 = BigInt((await node.pub.getBlock()).timestamp);
    const pre = {};
    for (const d of oldNow.filter((x) => x.active)) pre[lc(d.id)] = { ...serviceMetrics(d, await claimers(OLD, d.id)), leaseLive: BigInt(d.leaseUntil) > ts0,
      leaseRemaining: BigInt(d.leaseUntil) > ts0 ? String(BigInt(d.leaseUntil) - ts0) : '0', backingShortfall6: String(await node.read(OLD, LEDGER_ABI, 'bandwidthBackingRequired6', [d.id])) };
    rep.checks.hosts = hosts.map((h) => h.endpoint);
    const parties = new Set([OLD, NEW, P.payout, GOV, ANY, ...oldNow.map((d) => d.owner), ...snap.ledger.holders.map((h) => h.address), ...hosts.map((h) => h.operator),
      ...snap.feeWallets.map((w) => w.wallet), ...snap.owners.filter((o) => o.ownerOf).map((o) => o.ownerOf)].map((a) => getAddress(a)));
    const bal = async () => { const o = {}; for (const a of parties) o[a] = await node.read(P.usdc, ERC20, 'balanceOf', [a]); return o; };
    const bal0 = await bal();

    // ---- C: serve out escrow that retirement would strand (a real registry host claims and serves it) ----
    log('C. stranded escrow serve-out (before retirement)');
    const stranded = strandedAtRetire(oldNow);
    rep.stranded = [];
    for (const s of stranded) {
      const pick = async () => { for (const x of hosts) if (await node.read(OLD, LEDGER_ABI, 'claimableBy', [s.id, x.id])) return x; return null; };
      let h = await pick(), capTx = null;
      if (!h) {
        // C0: no host prices it under its cap. The record OWNER may raise the cap to the cheapest host's price (an exact
        // owner transaction in the plan); a cap raise only lets its own prepaid runtime be served, it buys nothing new.
        let best = null;
        for (const x of hosts) { try { const r = await node.read(OLD, LEDGER_ABI, 'rateFor', [s.id, x.id]); if (!best || r < best.r) best = { r, x }; } catch {} }
        if (best) {
          capTx = { phase: 'C0', signer: { role: 'record owner (its own key)', address: getAddress(s.owner) }, to: OLD, label: `setMaxRate(${s.id.slice(0, 10)}, ${best.r}) - the cheapest host's price, so its prepaid runtime can be served out`,
            data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'setMaxRate', args: [s.id, best.r] }) };
          await exec(capTx);
          h = await pick();
        }
      }
      const before = await readLedger(node, OLD).then((r) => r.find((d) => lc(d.id) === lc(s.id)));
      if (!h) { rep.stranded.push(J({ ...s, served: false, why: 'no active host can claim it even at the cheapest host price; the loss needs an explicit reviewed choice' })); continue; }
      const earned0 = await node.read(OLD, LEDGER_ABI, 'earned6', [h.operator]);
      await node.send({ from: h.operator, to: OLD, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'claim', args: [s.id, h.id] }), label: `C serve-out: ${h.endpoint} claims ${s.id.slice(0, 10)}` });
      let rounds = 0;
      for (;;) {
        const d = (await readLedger(node, OLD)).find((x) => lc(x.id) === lc(s.id));
        const now = BigInt((await node.pub.getBlock()).timestamp);
        if (BigInt(d.leaseUntil) - 5n > now) await node.warp(BigInt(d.leaseUntil) - 5n - now);
        const t = BigInt((await node.pub.getBlock()).timestamp);
        // the host's checkpoints (on Base: EnclaveProofOfTime.checkpoint from its CVM key; here the bound prover is impersonated)
        await node.send({ from: P.prover, to: OLD, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'creditProven', args: [s.id, t] }), label: 'C checkpoint (prover)' });
        const d2 = (await readLedger(node, OLD)).find((x) => lc(x.id) === lc(s.id));
        rounds++;
        if (BigInt(d2.balance6) < BigInt(d2.rate) || BigInt(d2.earn.escrow6) < BigInt(d2.earn.rate6) || rounds > 40) break;
        await node.send({ from: h.operator, to: OLD, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'renew', args: [s.id] }), label: 'C renew' });
      }
      const d3 = (await readLedger(node, OLD)).find((x) => lc(x.id) === lc(s.id));
      const now = BigInt((await node.pub.getBlock()).timestamp);
      if (BigInt(d3.leaseUntil) > now) await node.warp(BigInt(d3.leaseUntil) - now + 1n);
      await node.send({ from: P.prover, to: OLD, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'creditProven', args: [s.id, BigInt(d3.leaseUntil)] }), label: 'C final checkpoint', expectRevert: false }).catch(() => null);
      const after = (await readLedger(node, OLD)).find((x) => lc(x.id) === lc(s.id));
      rep.stranded.push(J({ ...s, served: true, host: h.endpoint, ownerCapRaise: capTx ? capTx.label : null, rounds, escrowBefore6: before.earn.escrow6, escrowAfter6: after.earn.escrow6, balanceBefore6: before.balance6, balanceAfter6: after.balance6,
        hostEarned6: (await node.read(OLD, LEDGER_ABI, 'earned6', [h.operator])) - earned0, simulatedSeconds: BigInt((await node.pub.getBlock()).timestamp) - ts0,
        strandedAfter: strandedAtRetire([after]).length === 0 ? '0 (nothing left to strand)' : 'still stranded' }));
    }

    // ---- P: the exact prebuild, then code and binding verification against the predictions ----
    log('P. prebuild');
    for (const t of S.txs.filter((x) => x.phase === 'P')) await exec(t);
    const codeL = await node.pub.getCode({ address: NEW }), codeP = await node.pub.getCode({ address: PRF });
    rep.checks.runtimes = { ledger17: keccak256(codeL) === S.predicted.ledgerRuntimeCodeHash, prover17: keccak256(codeP) === S.predicted.proverRuntimeCodeHash, ledgerBytes: (codeL.length - 2) / 2 };
    if (!rep.checks.runtimes.ledger17 || !rep.checks.runtimes.prover17) throw Error('deployed runtime differs from the plan prediction');
    // ---- G1 ----
    log('G1. retire');
    for (const t of S.txs.filter((x) => x.phase === 'G1')) await exec(t);
    // ---- I: snapshot F, exact import, then the static tail at the nonce the imports leave ----
    log('I. import from F');
    assertCanImport({ sourceRetired: await node.read(OLD, LEDGER_ABI, 'retired') });
    const F = await readLedger(node, OLD);
    const imports = planImport(F, await readLedger(node, NEW));
    let mn = await node.pub.getTransactionCount({ address: S.M });
    if (mn !== S.nextNonce()) throw Error(`migrator nonce ${mn} != plan ${S.nextNonce()}`);
    for (const t of imports) await exec({ phase: 'I', signer: { role: 'migrator', address: S.M, nonce: mn++ }, to: NEW, data: t.data, label: t.label + ' (generated from snapshot F)' });
    S.setNonce(mn);
    const tgt = await readLedger(node, NEW);
    const prefix = {}; for (const d of F) prefix[lc(d.id)] = BigInt(await node.pub.getStorageAt({ address: NEW, slot: prefixSlot(d.id) })) === 1n;
    const par = parity(F, tgt, prefix); assertCanSeal(par);
    rep.checks.importParity = { total: par.total, ok: par.ok, bad: par.bad.length, prefixReservations: Object.values(prefix).filter(Boolean).length };
    for (const f of S.iTail) await exec(f());
    // ---- G2 ----
    log('G2. handoff + repoint');
    for (const f of S.g2) await exec(f());
    // ---- lapse every old lease (no renewal after retire), then the escrow stages ----
    const maxUntil = F.reduce((m, d) => (BigInt(d.leaseUntil) > m ? BigInt(d.leaseUntil) : m), 0n);
    const nowL = BigInt((await node.pub.getBlock()).timestamp), win = BigInt(snap.dependents.proofOfTime.proofWindowSec);
    if (maxUntil + win + 1n > nowL) await node.warp(maxUntil + win + 1n - nowL);
    log('R/S/B/O. escrow + carries');
    assertCanBack({ importsSealed: await node.read(NEW, LEDGER_ABI, 'importsSealed') });
    const postOld = await readLedger(node, OLD), imported = await readLedger(node, NEW);
    const st = escrowStages({ postOld, imported, owners: snap.owners, OLD, NEW, USDC: P.usdc, PAYOUT: P.payout, feeWallets: snap.feeWallets, feeRouter: snap.dependents.verificationFees.address });
    for (const ph of ['R', 'S', 'B', 'O']) for (const t of st.txs.filter((x) => x.phase === ph)) await exec(t);
    rep.ownerCarryUnsupported = J(st.unsupported); rep.ownerCarryNotes = J(st.carry);
    // ---- X: both seals, exactly as planned ----
    log('X. seals');
    for (const f of S.x) await exec(f());
    const sealL = S.addresses.sealLedger17, sealP = S.addresses.sealProver17;
    rep.checks.seals = {
      ledgerOwner: await node.read(NEW, OWNABLE, 'owner'), proverOwner: await node.read(PRF, OWNABLE, 'owner'),
      ledgerSealed: await node.read(sealL, S.SEAL_ABI, 'isSealed'), proverSealed: await node.read(sealP, S.SEAL_ABI, 'isSealed'),
      ledgerConfig: { committed: await node.read(sealL, S.SEAL_ABI, 'configurationHash'), current: await node.read(sealL, S.SEAL_ABI, 'currentConfigurationHash'), predicted: S.predicted.sealLedgerConfigHash },
      proverConfig: { committed: await node.read(sealP, S.SEAL_ABI, 'configurationHash'), current: await node.read(sealP, S.SEAL_ABI, 'currentConfigurationHash'), predicted: S.predicted.sealProverConfigHash },
      adminRefused: {
        'ledger17.setLeaseSec': await node.revertReason({ from: GOV, to: NEW, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'setLeaseSec', args: [3600n] }) }),
        'ledger17.setPayout': await node.revertReason({ from: GOV, to: NEW, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'setPayout', args: [GOV] }) }),
        'ledger17.retire': await node.revertReason({ from: GOV, to: NEW, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'retire', args: [] }) }),
        'ledger17.slashBond': await node.revertReason({ from: GOV, to: NEW, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'slashBond', args: [GOV, 1n, 'x'] }) }),
        'prover17.setProofWindow': await node.revertReason({ from: GOV, to: PRF, data: encodeFunctionData({ abi: PROVER, functionName: 'setProofWindow', args: [600n] }) }),
        'prover17.transferOwnership': await node.revertReason({ from: GOV, to: PRF, data: encodeFunctionData({ abi: PROVER, functionName: 'transferOwnership', args: [GOV] }) }) } };
    const sc = rep.checks.seals;
    if (lc(sc.ledgerOwner) !== lc(sealL) || lc(sc.proverOwner) !== lc(sealP) || !sc.ledgerSealed || !sc.proverSealed
      || sc.ledgerConfig.committed !== sc.ledgerConfig.predicted || sc.ledgerConfig.current !== sc.ledgerConfig.committed
      || sc.proverConfig.committed !== sc.proverConfig.predicted || sc.proverConfig.current !== sc.proverConfig.committed
      || Object.values(sc.adminRefused).some((x) => x === null)) throw Error('seal state is not as planned: ' + JSON.stringify(J(sc)));

    // ---- post: the same deployments on ledger17, and the continuity verdict ----
    log('continuity');
    const newNow = await readLedger(node, NEW), oldAfter = await readLedger(node, OLD);
    const rows = [];
    for (const [id, a] of Object.entries(pre)) {
      const d = newNow.find((x) => lc(x.id) === id), dOldPost = postOld.find((x) => lc(x.id) === id);
      const b = d ? serviceMetrics(d, await claimers(NEW, d.id)) : null;
      const servedOut = rep.stranded.some((s) => lc(s.id) === id && s.served);
      const N = d && BigInt(d.rate) > 0n && BigInt(d.earn.rate6) > 0n ? (BigInt(d.balance6) * BigInt(d.earn.rate6) + BigInt(d.rate) - 1n) / BigInt(d.rate) : 0n;
      const unspent = dOldPost ? BigInt(dOldPost.earn.escrow6) : 0n;   // old escrow left after every lease lapsed and settled
      const want = N < unspent ? N : unspent;
      const verdict = !b ? 'MISSING'
        : servedOut ? 'served out before retirement (its escrow became host earnings; nothing stranded)'
        : b.claimableHosts < a.claimableHosts ? 'REGRESSION: fewer hosts can claim it'
        : a.fundableSeconds !== b.fundableSeconds && !(a.leaseLive) ? 'REGRESSION: fundable runtime changed'
        : BigInt(d.earn.escrow6) < want ? `REGRESSION: backing ${d.earn.escrow6} < carried-able ${want}`
        : BigInt(a.backingShortfall6) > 0n ? 'continuous; inherited under-backing (pre-existing on the old ledger, not caused by the migration)' : 'continuous';
      rows.push({ id, owner: a.owner, pre: a, post: b, unspentOldEscrow6: String(unspent), backingNeeded6: String(N), verdict });
    }
    rep.continuity = { activeBefore: Object.keys(pre).length, regressions: rows.filter((r) => /REGRESSION|MISSING/.test(r.verdict)).length,
      inheritedUnderBacking: rows.filter((r) => /inherited/.test(r.verdict)).length, rows: J(rows) };
    if (rep.continuity.regressions) throw Error('migration-induced regressions: ' + JSON.stringify(rows.filter((r) => /REGRESSION|MISSING/.test(r.verdict)).map((r) => [r.id, r.verdict])));

    // ---- conservation + entitlement ----
    const bal1 = await bal(); let net = 0n; const delta = {};
    for (const a of parties) { delta[a] = bal1[a] - bal0[a]; net += delta[a]; }
    rep.checks.conservation = J({ net, deltas: delta, newLedgerHolds6: bal1[getAddress(NEW)], oldLedgerHolds6: bal1[getAddress(OLD)],
      oldLedgerOwes: { earned6: (await Promise.all(snap.ledger.holders.map((h) => node.read(OLD, LEDGER_ABI, 'earned6', [h.address])))) } });
    if (net !== 0n) throw Error('USDC created or destroyed: ' + net);
    const own = {}; for (const t of st.txs.filter((x) => x.phase === 'O' && /fundEscrow/.test(x.label))) {
      const id = t.label.match(/fundEscrow (0x[0-9a-f]{8})/)?.[1]; const rec = imported.find((d) => d.id.startsWith(id));
      if (rec && lc(rec.owner) === lc(t.signer.address)) own[lc(rec.id)] = (own[lc(rec.id)] || 0n) + BigInt(t.usdc6); }
    for (const t of st.txs.filter((x) => x.phase === 'B' && /fundEscrow/.test(x.label))) { const id = t.label.match(/fundEscrow (0x[0-9a-f]{8})/)?.[1]; const rec = imported.find((d) => d.id.startsWith(id));
      if (rec && lc(rec.owner) === lc(P.payout)) own[lc(rec.id)] = (own[lc(rec.id)] || 0n) + BigInt(t.usdc6); }
    const ent = [];
    for (const d of newNow) { const oe = await node.read(NEW, LEDGER_ABI, 'ownerEscrow6', [d.id]); if (oe !== (own[lc(d.id)] || 0n)) throw Error(`entitlement: ${d.id} ownerEscrow6 ${oe} vs its owner's own ${own[lc(d.id)] || 0n}`); if (oe > 0n) ent.push({ id: d.id, ownerEscrow6: oe }); }
    rep.checks.ownerRefundableOnNew = J(ent);
    rep.completion = { onThisFork: 'every plan v2 phase executed; ledger17 and prover17 sealed; no migration-induced continuity regression',
      migrationComplete: 'NOT on Base: requires the owners to sign and execute every phase, then a post-activation proof',
      decentralizationComplete: 'NOT YET: the sealed ledger17/prover17 remove those admin powers, but the global powers listed in globalPowers (catalog, key attestations, address book, pay, old ledger/prover) still exist and each needs its own reviewed disposition' };
    rep.result = 'pass';
  } catch (e) { rep.result = 'fail'; rep.error = String(e.stack || e.message).slice(0, 3000); }
  finally { await node.stop(); }
  const file = path.join(HERE, 'rehearsal', `replay-${snap.block.number}.json`);
  fs.writeFileSync(file, JSON.stringify(J(rep), null, 1) + '\n');
  return { file, rep };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  replay({ snapshotFile: arg('--snapshot'), migrator: getAddress(arg('--migrator')) }).then(({ file, rep }) => {
    console.log(JSON.stringify({ file, result: rep.result, error: rep.error?.split('\n')[0], executed: rep.executed.length, regressions: rep.continuity?.regressions }));
    process.exitCode = rep.result === 'pass' ? 0 : 1; });
}
