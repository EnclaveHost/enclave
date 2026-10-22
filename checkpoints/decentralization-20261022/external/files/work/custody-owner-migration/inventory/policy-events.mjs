// READ-ONLY, BOUNDED: the original custody vault's public policy/committee EVENT delta since the known snapshot (block
// 52849851, existing-custody-audit/evidence/live-custody.json: one committee, one policy), up to a block pinned by agreement
// of the state endpoints. Then every policy id known from the snapshot or the delta is read AT THAT BLOCK: owner, revisions,
// committee, pause, rules (public JSON), and the stored bundle's committee/revision/length/keccak (the bundle is public
// ciphertext; nothing is decrypted). No transaction, no key, no secret.
//
// Completeness is explicit, never assumed:
//   - every log chunk must be answered by the archive log endpoint; where the second endpoint also answers, both must agree
//     byte for byte (it may lack old ranges: recorded per chunk);
//   - a chunk that cannot be read after bounded retries (rate limits, range limits halve the span down to 250 blocks)
//     marks the WHOLE scan incomplete with the missing range; policies are still read, but the report says "incomplete";
//   - per policy, the number of PolicyUpdated + PolicyClaimed events since the snapshot must equal policyRev(now) -
//     policyRev(snapshot), and BundlePut + BundleCleared must equal the secretRev delta; a mismatch is reported.
//   node work/custody-owner-migration/inventory/policy-events.mjs
import fs from 'node:fs';
import { decodeEventLog, keccak256, parseAbi } from 'viem';
import { pinBlock, readMany, rpc, LIVE, rpcCalls } from '../../ledger17-migration/lib/live.mjs';

const VAULT = '0xe48699b8401564aace7a814ae4569b67a3f7eef5';
const SNAP = JSON.parse(fs.readFileSync(new URL('../../existing-custody-audit/evidence/live-custody.json', import.meta.url), 'utf8'));
const FROM = BigInt(SNAP.block.number) + 1n;
const EVENTS = parseAbi([
  'event CommitteeCreated(bytes32 indexed committeeId, address indexed identity, bytes Y)',
  'event HandoverProposed(bytes32 indexed committeeId, uint32 toEpoch, uint8 t, uint8 W, uint256 machines, uint64 expires)',
  'event DealPosted(bytes32 indexed committeeId, uint32 toEpoch, uint32 dealerIndex, address dealer)',
  'event HandoverAcked(bytes32 indexed committeeId, uint32 toEpoch, address machine, uint256 acks)',
  'event EpochActivated(bytes32 indexed committeeId, uint32 epoch)',
  'event CodeProposed(bytes32 indexed committeeId, bytes32 indexed measurement, uint64 activeAt)',
  'event CodeRemoved(bytes32 indexed committeeId, bytes32 indexed measurement)',
  'event PolicyUpdated(bytes32 indexed id, address indexed owner, uint64 policyRev, bytes32 committeeId, bool paused)',
  'event BundlePut(bytes32 indexed id, uint64 secretRev, bytes32 committeeId, uint256 bundleBytes)',
  'event BundleCleared(bytes32 indexed id, uint64 secretRev)',
  'event PolicyClaimed(bytes32 indexed id, address indexed previousOwner, address indexed newOwner, uint64 policyRev)']);
const VIEWS = parseAbi([
  'function policyOf(bytes32 id) view returns (address owner, uint64 policyRev, uint64 secretRev, bytes32 committeeId, bool paused, bytes rules)',
  'function bundleOf(bytes32 id) view returns (bytes32 committeeId, uint64 secretRev, bytes bundle)',
  'function beneficialOwnerOf(bytes32 id) view returns (address)',
  'function committeeOf(bytes32 cid) view returns (bytes Y, uint32 epoch, uint8 t, uint8 W, uint64 activatedAt)',
  'function codeActiveAt(bytes32 cid, bytes32 measurement) view returns (uint64)']);
const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
const J = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const hex = (n) => '0x' + n.toString(16);

const out = { checkedAt: new Date().toISOString(), vault: VAULT, snapshot: SNAP.block, fromBlock: FROM.toString(), complete: false,
              endpoints: { state: LIVE.state.map((u) => new URL(u).host), logs: LIVE.logs.map((u) => new URL(u).host) }, chunks: [], missing: [] };
const write = () => fs.writeFileSync(new URL('./policy-inventory.json', import.meta.url), JSON.stringify(J(out), null, 1) + '\n');
try {
  const block = await pinBlock({ depth: 12 });
  Object.assign(out, { pinned: { number: block.number, hash: block.hash, timestamp: block.timestamp } });
  // ---- the event delta, adaptive chunks
  const raw = [];
  let f = FROM, span = 2000n;
  while (f <= block.number) {
    const t = f + span - 1n > block.number ? block.number : f + span - 1n;
    const q = [{ address: VAULT, fromBlock: hex(f), toBlock: hex(t) }];
    let primary = null, err = null;
    try { primary = await rpc(LIVE.logs[0], 'eth_getLogs', q, { tries: 6 }); } catch (e) { err = e; }
    if (!primary) {
      if (span > 250n && /range|limit|too many|exceed|size/i.test(String(err?.message))) { span /= 2n; continue; }
      out.missing.push({ from: f, to: t, reason: String(err?.message).slice(0, 200) }); f = t + 1n; continue;
    }
    let second = 'unavailable';
    try {
      const s = await rpc(LIVE.logs[1], 'eth_getLogs', q, { tries: 3 });
      const norm = (rs) => JSON.stringify(rs.map((x) => [x.blockNumber, x.blockHash, x.transactionHash, x.logIndex, x.topics, x.data]));
      second = norm(s) === norm(primary) ? 'agrees' : 'DISAGREES';
      if (second === 'DISAGREES') throw Object.assign(Error(`log endpoints disagree on ${f}-${t}`), { fatal: true });
    } catch (e) { if (e.fatal) throw e; second = `unavailable (${String(e.message).slice(0, 80)})`; }
    out.chunks.push({ from: f, to: t, logs: primary.length, second });
    raw.push(...primary);
    f = t + 1n;
  }
  out.complete = out.missing.length === 0;
  out.events = raw.map((l) => { let d; try { d = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics }); } catch { d = { eventName: 'UNKNOWN', args: {} }; }
    return { block: BigInt(l.blockNumber), tx: l.transactionHash, logIndex: Number(l.logIndex), event: d.eventName, args: d.args }; });
  out.eventCounts = out.events.reduce((a, e) => ((a[e.event] = (a[e.event] || 0) + 1), a), {});
  // ---- every known policy id at the pinned block
  const ids = [...new Set([...SNAP.policies.map((p) => p.id.toLowerCase()), ...out.events.filter((e) => e.args?.id).map((e) => e.args.id.toLowerCase())])];
  const calls = ids.flatMap((id) => [{ address: VAULT, abi: VIEWS, functionName: 'policyOf', args: [id] }, { address: VAULT, abi: VIEWS, functionName: 'bundleOf', args: [id] },
                                     { address: VAULT, abi: VIEWS, functionName: 'beneficialOwnerOf', args: [id], allowFailure: true }]);
  const r = await readMany(block, calls);
  out.policies = [];
  for (const [i, id] of ids.entries()) {
    const [owner, policyRev, secretRev, committeeId, paused, rules] = r[3 * i].value;
    const [bCid, bRev, bundle] = r[3 * i + 1].value;
    const snap = SNAP.policies.find((p) => p.id.toLowerCase() === id);
    const ev = out.events.filter((e) => e.args?.id?.toLowerCase() === id);
    const policyEvents = ev.filter((e) => e.event === 'PolicyUpdated' || e.event === 'PolicyClaimed').length;
    const bundleEvents = ev.filter((e) => e.event === 'BundlePut' || e.event === 'BundleCleared').length;
    let rulesJson = null; try { rulesJson = JSON.parse(Buffer.from(rules.slice(2), 'hex').toString('utf8')); } catch {}
    const ownerCode = await rpc(LIVE.state[0], 'eth_getCode', [owner, hex(block.number)]);
    out.policies.push({ id, owner, ownerIsContract: ownerCode !== '0x', beneficialOwner: r[3 * i + 2].ok ? r[3 * i + 2].value : 'unreadable',
      policyRev, secretRev, committeeId, paused, rules: rulesJson, rulesKeccak: keccak256(rules),
      bundle: { committeeId: bCid, secretRev: bRev, bytes: (bundle.length - 2) / 2, keccak: bundle === '0x' ? null : keccak256(bundle) },
      sinceSnapshot: { policyEvents, bundleEvents,
        consistent: snap ? (BigInt(policyRev) - BigInt(snap.policyRev) === BigInt(policyEvents) && BigInt(secretRev) - BigInt(snap.secretRev) === BigInt(bundleEvents)) : 'new since snapshot' } });
  }
  // ---- the committees those policies name
  const cids = [...new Set([...out.policies.map((p) => p.committeeId), ...out.events.filter((e) => e.event === 'CommitteeCreated').map((e) => e.args.committeeId)])];
  const cr = await readMany(block, cids.map((cid) => ({ address: VAULT, abi: VIEWS, functionName: 'committeeOf', args: [cid] })));
  out.committees = cids.map((cid, i) => { const [Y, epoch, t, W, activatedAt] = cr[i].value; return { committeeId: cid, Y, epoch, t, W, activatedAt }; });
  out.status = out.complete ? 'complete' : 'INCOMPLETE: see missing[]; policies created in a missing range are unknown';
} catch (e) { out.error = String(e.message).slice(0, 300); out.status = 'FAILED: ' + out.error; }
out.rpcCalls = rpcCalls();
write();
console.log(JSON.stringify(J({ status: out.status, pinned: out.pinned, chunks: out.chunks.length, missing: out.missing, eventCounts: out.eventCounts,
  policies: out.policies?.map((p) => ({ id: p.id, policyRev: p.policyRev, secretRev: p.secretRev, committeeId: p.committeeId, consistent: p.sinceSnapshot.consistent })) }), null, 1));
