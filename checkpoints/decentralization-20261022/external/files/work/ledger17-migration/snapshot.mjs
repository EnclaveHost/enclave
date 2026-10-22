// snapshot: READ-ONLY inventory of every binding and balance the rev-17 migration touches, at ONE agreed Base block.
// Nothing is written anywhere but snapshots/<block>.json. See lib/live.mjs for the endpoint and method guards.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { keccak256, decodeEventLog, getAddress, encodeAbiParameters, hexToBigInt, stringToHex, hexToString } from 'viem';
import { pinBlock, readMany, readOne, codeAt, storageAt, logs, agree, rpcCalls, LIVE } from './lib/live.mjs';
import { HERE, REPO, LEDGER_ABI, ERC20, BOOK, PROVER, FEES, CONNECTIVITY, AUTHORITY, FACTORY, VAULT, SECRET_V2, REGISTRY4, OWNABLE, EVENT_ABI } from './lib/abis.mjs';

export const PROFILE_FILE = path.join(REPO, 'contracts/deployments/network-profile-base.json');
export const PROFILE_DIGEST = 'sha256:ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8';   // the reviewed pin
export const EXTRA = Object.freeze({   // ledger-related contracts the profile does not list (deployment records in contracts/deployments)
  addressBook: '0xab214342d5A490150A4A977063A2f88E21F80907',
  sessionVaultFactoryV1Book: '0x00bB59c40768aA56E292b4E789f9f3B5826E3a8d',      // sessions-base.json, book-bound
  secretVaultV2Book: '0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5',               // secret-vault-v2-base.json, book-bound
  ledger15d: '0x606C7910acDeC5DE534FD6d16Bf71AEb0C43eAe9',                       // previous ledger (ledger-15d-base.json)
  ledgerBefore15d: '0xb36DCE7689834D59364ca37Ade1896D0E6404830',
  prover15d: '0x3301605ac208e6d8A9711E5B3835f91Ca4Fdd946',
  fees15d: '0x7898E8D219aA235E3b9d9132c7BE9E7BA7f12417',
  hostPaymaster: '0x0ad1095201B9819b7238B1661d5c1e0C7f48A1D1',
});
export const LEDGER_FIRST_BLOCK = 52515705n;
export const SESSION_FACTORIES_FIRST_BLOCK = 52280280n;   // sessions-base.json: the first session factory's block   // first block with code at the live ledger (archive bisection, 2026-10-20)
const ZERO = '0x0000000000000000000000000000000000000000';
const j = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const lc = (a) => String(a).toLowerCase();

export async function takeSnapshot({ out = path.join(HERE, 'snapshots'), log = console.error } = {}) {
  const profileBytes = fs.readFileSync(PROFILE_FILE);
  const pd = 'sha256:' + createHash('sha256').update(profileBytes).digest('hex');
  if (pd !== PROFILE_DIGEST) throw Error(`authority profile digest ${pd} is not the reviewed ${PROFILE_DIGEST}`);
  const profile = JSON.parse(profileBytes);
  const P = Object.fromEntries(Object.entries(profile.contracts).map(([k, c]) => [k, getAddress(c.address)]));
  const block = await pinBlock();
  log(`pinned block ${block.number} ${block.hash}`);
  const s = { kind: 'enclave.ledger17.snapshot', version: 1, chainId: 8453, block: { number: block.number, hash: block.hash, timestamp: block.timestamp,
    baseFeePerGas: block.baseFeePerGas }, endpoints: { state: LIVE.state, logs: LIVE.logs }, profile: { file: 'contracts/deployments/network-profile-base.json', digest: pd } };
  const L = P.deployments;

  // ---- 1. code of everything that matters, against the reviewed profile ----
  s.code = {};
  for (const [name, address] of [...Object.entries(P), ...Object.entries(EXTRA)]) {
    const code = await codeAt(block, address);
    const c = profile.contracts[name];
    s.code[name] = { address, bytes: (code.length - 2) / 2, codeHash: code === '0x' ? null : keccak256(code),
      profileCodeHash: c?.codeHash ?? null, matchesProfile: c ? keccak256(code) === c.codeHash : null };
  }

  // ---- 2. the address book: every key, and what each target binds ----
  const [keys, values] = await readOne(block, { address: EXTRA.addressBook, abi: BOOK, functionName: 'all' });
  const [bookOwner, bookPending] = (await readMany(block, [{ address: EXTRA.addressBook, abi: BOOK, functionName: 'owner' },
    { address: EXTRA.addressBook, abi: BOOK, functionName: 'pendingOwner', allowFailure: true }])).map((r) => r.value);
  s.book = { address: EXTRA.addressBook, owner: bookOwner, pendingOwner: bookPending ?? null,
    entries: keys.map((k, i) => ({ key: hexToString(k, { size: 32 }).replace(/\0+$/, ''), keyHex: k, value: values[i] })) };

  // generic binding probe: which known contracts hold the old ledger (or the book) as a binding
  const probes = ['deployments', 'ledger', 'deploymentLedger', 'book'];
  const probeAbi = probes.map((n) => ({ type: 'function', name: n, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }));
  const targets = [...new Set([...Object.values(P), ...Object.values(EXTRA), ...values].map(lc))].filter((a) => a !== lc(ZERO));
  const pr = await readMany(block, targets.flatMap((t) => probes.map((n) => ({ address: t, abi: probeAbi, functionName: n, allowFailure: true }))));
  s.bindings = {};
  targets.forEach((t, i) => probes.forEach((n, k) => { const r = pr[i * probes.length + k]; if (r.ok) (s.bindings[t] ||= {})[n] = r.value; }));
  s.ledgerBound = Object.entries(s.bindings).filter(([, b]) => Object.values(b).some((v) => lc(v) === lc(L))).map(([t, b]) => ({ address: t, via: b }));

  // ---- 3. the live ledger: parameters, every record and its side mappings, holdings ----
  const PARAMS = ['owner', 'pendingOwner', 'retired', 'payout', 'usdc', 'registry', 'ethUsdFeed', 'leaseSec', 'maxGpuMilli', 'maxFeePerSec6',
    'deploymentsSchema', 'bandwidthRouter', 'feeRouter', 'runnerBps', 'claimBond6', 'bondExitDelay', 'prover', 'proofRequiredFrom', 'importsSealed', 'count'];
  const pv = await readMany(block, PARAMS.map((n) => ({ address: L, abi: LEDGER_ABI, functionName: n })));
  s.ledger = { address: L, params: Object.fromEntries(PARAMS.map((n, i) => [n, pv[i].value])) };
  const count = Number(s.ledger.params.count);
  const recs = [];
  for (let i = 0; i < count; i += 50) recs.push(...await readOne(block, { address: L, abi: LEDGER_ABI, functionName: 'getPage', args: [BigInt(i), 50n] }));
  if (recs.length !== count) throw Error(`getPage returned ${recs.length} of ${count}`);
  const SIDE = ['feeOf', 'earnOf', 'capOf', 'refundableOf', 'ownerEscrow6', 'provenUntil', 'bandwidthBackingRequired6', 'claimable', 'secondsFundable'];
  const sv = await readMany(block, recs.flatMap((r) => SIDE.map((n) => ({ address: L, abi: LEDGER_ABI, functionName: n, args: [r.id] }))));
  s.ledger.records = recs.map((r, i) => {
    const v = (k) => sv[i * SIDE.length + SIDE.indexOf(k)].value;
    return { ...r, fee: { recipient: v('feeOf')[0], rate6: v('feeOf')[1] }, earn: { rate6: v('earnOf')[0], escrow6: v('earnOf')[1], creditedUntil: v('earnOf')[2] },
      cap6: v('capOf'), refundable6: v('refundableOf'), ownerEscrow6: v('ownerEscrow6'), provenUntil: v('provenUntil'),
      backingRequired6: v('bandwidthBackingRequired6'), claimable: v('claimable'), secondsFundable: v('secondsFundable'),
      leaseLive: BigInt(r.leaseUntil) > block.timestamp };
  });
  s.ledger.usdcHeld6 = await readOne(block, { address: s.ledger.params.usdc, abi: ERC20, functionName: 'balanceOf', args: [L] });

  // ---- 4. discovery from events (then re-read as agreed state) ----
  const watched = [L, P.proofOfTime, P.verificationFees, P.connectivity, P.sessionVaultFactory, P.legacySessionVaultFactory,
    EXTRA.sessionVaultFactoryV1Book, P.secretVaultV2, EXTRA.secretVaultV2Book].map((a) => getAddress(a));
  const t0 = Date.now();
  const raw = await logs({ addresses: watched, fromBlock: EXTRA_FROM(), toBlock: block.number, onProgress: (b) => { if (Number(b) % 50000 < 5000) log(`  logs to ${b}`); } });
  // the book-bound session factories predate the ledger: their vaults were created from their own deployment on
  raw.push(...await logs({ addresses: [P.legacySessionVaultFactory, EXTRA.sessionVaultFactoryV1Book].map((a) => getAddress(a)), fromBlock: SESSION_FACTORIES_FIRST_BLOCK, toBlock: EXTRA_FROM() - 1n }));
  log(`  ${raw.length} logs in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const ev = [];
  for (const l of raw) { try { const d = decodeEventLog({ abi: EVENT_ABI, data: l.data, topics: l.topics }); ev.push({ address: lc(l.address), block: BigInt(l.blockNumber), tx: l.transactionHash, name: d.eventName, args: d.args }); } catch { ev.push({ address: lc(l.address), block: BigInt(l.blockNumber), name: 'unknown', topic0: l.topics[0] }); } }
  s.events = { from: EXTRA_FROM(), to: block.number, total: ev.length, byContract: {} };
  for (const e of ev) { const c = (s.events.byContract[e.address] ||= {}); c[e.name] = (c[e.name] || 0) + 1; }

  // operators and earnings beneficiaries: every address that can hold earned6 or a bond on the ledger
  const ledgerEv = ev.filter((e) => e.address === lc(L));
  const reg = [];
  const rc = Number(await readOne(block, { address: s.ledger.params.registry, abi: REGISTRY4, functionName: 'count' }));
  for (let i = 0; i < rc; i += 50) reg.push(...await readOne(block, { address: s.ledger.params.registry, abi: REGISTRY4, functionName: 'getPage', args: [BigInt(i), 50n] }));
  const holders = new Set([...reg.map((h) => lc(h.operator)), ...recs.map((r) => lc(r.runnerOperator)),
    ...ledgerEv.filter((e) => ['RunnerCredited', 'EarningsWithdrawn', 'BondPosted', 'BondExitRequested', 'BondWithdrawn', 'BondSlashed', 'Claimed', 'BandwidthSplit'].includes(e.name))
      .map((e) => lc(e.args.operator))].filter((a) => a && a !== lc(ZERO)));
  const hl = [...holders].sort();
  const hv = await readMany(block, hl.flatMap((a) => [{ address: L, abi: LEDGER_ABI, functionName: 'earned6', args: [a] }, { address: L, abi: LEDGER_ABI, functionName: 'bondOf', args: [a] }]));
  s.ledger.holders = hl.map((a, i) => ({ address: a, earned6: hv[2 * i].value, bond6: hv[2 * i + 1].value[0], bondExitAt: hv[2 * i + 1].value[1] }))
    .filter((h) => h.earned6 > 0n || h.bond6 > 0n);
  s.ledger.registryHosts = reg.length;

  // solvency: what the ledger holds vs what it owes (escrow + earnings + bonds); an exact match proves discovery complete
  const sumEscrow = s.ledger.records.reduce((a, r) => a + BigInt(r.earn.escrow6), 0n);
  const sumEarned = s.ledger.holders.reduce((a, h) => a + h.earned6, 0n), sumBond = s.ledger.holders.reduce((a, h) => a + BigInt(h.bond6), 0n);
  s.ledger.solvency = { held6: s.ledger.usdcHeld6, escrow6: sumEscrow, earned6: sumEarned, bonds6: sumBond,
    surplus6: s.ledger.usdcHeld6 - sumEscrow - sumEarned - sumBond };

  // delegates (no getter): every DelegateSet pair, then the CURRENT grant from storage slot 23 at the pinned block
  const pairs = new Map();
  for (const e of ledgerEv.filter((x) => x.name === 'DelegateSet')) pairs.set(lc(e.args.owner) + lc(e.args.delegate), [lc(e.args.owner), lc(e.args.delegate)]);
  // vault discovery (book-bound legacy factories and the pinned factory)
  const factories = [P.sessionVaultFactory, P.legacySessionVaultFactory, EXTRA.sessionVaultFactoryV1Book].map(lc);
  const vaults = ev.filter((e) => e.name === 'VaultCreated' && factories.includes(e.address)).map((e) => ({ factory: e.address, owner: lc(e.args.owner), vault: lc(e.args.vault), block: e.block }));
  for (const v of vaults) pairs.set(v.owner + v.vault, [v.owner, v.vault]);   // a vault is its owner's intended delegate
  const slotOf = (o, d) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [d, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [o, 23n]))]));
  s.ledger.delegates = [];
  for (const [o, d] of pairs.values()) {
    const v = await storageAt(block, L, slotOf(o, d));
    s.ledger.delegates.push({ owner: o, delegate: d, granted: hexToBigInt(v) === 1n, fromEvent: ledgerEv.some((e) => e.name === 'DelegateSet' && lc(e.args.owner) === o && lc(e.args.delegate) === d) });
  }
  // vault holdings and bindings
  const vr = await readMany(block, vaults.flatMap((v) => [{ address: s.ledger.params.usdc, abi: ERC20, functionName: 'balanceOf', args: [v.vault] },
    { address: v.vault, abi: VAULT, functionName: 'owner', allowFailure: true }, { address: v.vault, abi: VAULT, functionName: 'book', allowFailure: true }]));
  s.vaults = vaults.map((v, i) => ({ ...v, usdc6: vr[3 * i].value, ownerNow: vr[3 * i + 1].value ?? null, book: vr[3 * i + 2].value ?? null }));

  // fee wallets (EnclaveVerificationFees): per (source, payer) wallets that hold USDC and act on the ledger
  const fw = [...new Map(ev.filter((e) => e.name === 'Configured' && e.address === lc(P.verificationFees)).map((e) => [lc(e.args.wallet), e])).values()];
  const fb = await readMany(block, fw.map((e) => ({ address: s.ledger.params.usdc, abi: ERC20, functionName: 'balanceOf', args: [e.args.wallet] })));
  s.feeWallets = fw.map((e, i) => ({ source: e.args.source, payer: lc(e.args.payer), wallet: lc(e.args.wallet), usdc6: fb[i].value }));

  // ---- 5. dependents: bindings and owner powers ----
  const dep = await readMany(block, [
    ...['owner', 'pendingOwner', 'proofWindowSec', 'deployments', 'proofSchema'].map((n) => ({ address: P.proofOfTime, abi: PROVER, functionName: n, allowFailure: true })),
    ...['ledger', 'proof', 'token'].map((n) => ({ address: P.verificationFees, abi: FEES, functionName: n, allowFailure: true })),
    ...['ledger', 'registry'].map((n) => ({ address: P.connectivity, abi: CONNECTIVITY, functionName: n, allowFailure: true })),
    ...['deployments', 'appCatalog', 'sessionVaultFactory'].map((n) => ({ address: P.pinnedSessionAuthority, abi: AUTHORITY, functionName: n, allowFailure: true })),
    { address: P.sessionVaultFactory, abi: FACTORY, functionName: 'implementation', allowFailure: true },
    ...['book', 'enclaveOwner', 'hostOwnership', 'hostRegistry', 'deploymentLedger', 'sessionVaultFactory'].map((n) => ({ address: P.secretVaultV2, abi: SECRET_V2, functionName: n, allowFailure: true })),
    ...['book', 'enclaveOwner', 'hostOwnership', 'hostRegistry', 'deploymentLedger', 'sessionVaultFactory'].map((n) => ({ address: EXTRA.secretVaultV2Book, abi: SECRET_V2, functionName: n, allowFailure: true })),
  ]);
  const take = (n) => dep.splice(0, n).map((r) => (r.ok ? r.value : null));
  const [po, pp, pw, pd2, ps] = take(5), [fl, fpf, ft] = take(3), [cl, cr] = take(2), [ad, ac, af] = take(3), [fi] = take(1);
  const sv2 = take(6), sv2b = take(6);
  s.dependents = {
    proofOfTime: { address: P.proofOfTime, owner: po, pendingOwner: pp, proofWindowSec: pw, deployments: pd2, proofSchema: ps },
    verificationFees: { address: P.verificationFees, ledger: fl, proof: fpf, token: ft, wallets: s.feeWallets.length },
    connectivity: { address: P.connectivity, ledger: cl, registry: cr, boundAsBandwidthRouter: lc(s.ledger.params.bandwidthRouter) === lc(P.connectivity) },
    pinnedSessionAuthority: { address: P.pinnedSessionAuthority, deployments: ad, appCatalog: ac, sessionVaultFactory: af },
    sessionVaultFactory: { address: P.sessionVaultFactory, implementation: fi },
    secretVaultV2: { address: P.secretVaultV2, ...Object.fromEntries(['book', 'enclaveOwner', 'hostOwnership', 'hostRegistry', 'deploymentLedger', 'sessionVaultFactory'].map((k, i) => [k, sv2[i]])) },
    secretVaultV2Book: { address: EXTRA.secretVaultV2Book, ...Object.fromEntries(['book', 'enclaveOwner', 'hostOwnership', 'hostRegistry', 'deploymentLedger', 'sessionVaultFactory'].map((k, i) => [k, sv2b[i]])) },
  };
  // previous ledgers: still hold real USDC and owe it to their owners / operators
  const prev = await readMany(block, [EXTRA.ledger15d, EXTRA.ledgerBefore15d].flatMap((a) => [{ address: s.ledger.params.usdc, abi: ERC20, functionName: 'balanceOf', args: [a] },
    { address: a, abi: LEDGER_ABI, functionName: 'retired', allowFailure: true }, { address: a, abi: LEDGER_ABI, functionName: 'count', allowFailure: true }]));
  s.previousLedgers = [EXTRA.ledger15d, EXTRA.ledgerBefore15d].map((a, i) => ({ address: a, usdc6: prev[3 * i].value, retired: prev[3 * i + 1].value ?? null, count: prev[3 * i + 2].value ?? null }));
  // record owners: contract or wallet, and for contracts what they are (they can only take the actions their code allows)
  const owners = [...new Set(recs.map((r) => lc(r.owner)))].sort();
  const ownerInfo = [];
  for (const o of owners) {
    const code = await codeAt(block, o);
    const info = { address: o, contract: code.length > 2, codeHash: code.length > 2 ? keccak256(code) : null, code: code.length > 2 ? code.slice(0, 96) : null };   // prefix: 0xef0100 = EIP-7702, 0x363d3d37 = EIP-1167
    if (info.contract) {
      const g = await readMany(block, ['factory', 'book', 'owner'].map((n) => ({ address: o, abi: [{ type: 'function', name: n, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: n, allowFailure: true }))
        .concat([{ address: s.ledger.params.usdc, abi: ERC20, functionName: 'balanceOf', args: [o] }]));
      Object.assign(info, { factory: g[0].value ?? null, book: g[1].value ?? null, ownerOf: g[2].value ?? null, usdc6: g[3].value });
      info.kind = s.feeWallets.some((w) => w.wallet === o) ? 'verification-fee wallet (controller: verificationFees)'
        : info.factory && lc(info.factory) === lc(values[keys.findIndex((k) => hexToString(k, { size: 32 }).replace(/\0+$/, '') === 'vaultFactory')]) ? 'credit vault (book-bound)'
        : info.factory ? 'session vault' : 'contract';
    }
    info.records = recs.filter((r) => lc(r.owner) === o).length;
    ownerInfo.push(info);
  }
  s.owners = ownerInfo;
  s.rpcCalls = rpcCalls();

  const body = j(s);
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const file = path.join(out, `${block.number}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...body, digest }, null, 1) + '\n');
  return { file, digest, snapshot: body };
}
function EXTRA_FROM() { return LEDGER_FIRST_BLOCK; }
