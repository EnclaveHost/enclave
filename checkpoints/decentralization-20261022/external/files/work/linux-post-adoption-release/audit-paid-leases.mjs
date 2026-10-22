// READ-ONLY exact-hash chain audit of the post-adoption Linux activation's two app-paid renewals (prepared by Claude
// 2026-10-21; adapted from work/linux-corrected-release/audit-paid-leases.mjs, which DISCOVERED payments by log scan).
// ROOT REVIEWS BEFORE RUNNING, and before keep.py. No signer, wallet, send method, private state, config, key or journal
// is used: only activation/result.json's public fields, plan.json, preflight-used.json, the reviewed deployment record
// and public JSON-RPC reads.
//   node work/linux-post-adoption-release/audit-paid-leases.mjs            (defaults: the real files, plan's 3 RPCs, q=2)
// It audits EXACTLY the two transaction hashes activate.py recorded in result.json `renewals`, and only while
// result.productionActivated === 'provisional'. Per app, PASS needs ALL of:
//   - the pinned deployment (record digest == plan.leaseGas.digest == the reviewed 1665c218...) verified by a >= 2 RPC
//     quorum at a fresh agreed block (verifiedLeaseAuthority: reserve/executor code hashes and bindings);
//   - the transaction itself, fetched by the same quorum: a canonical lease() call to the Linux operator
//     0xc9d0835c...; kind 2 (renew); id == that app (plan.apps); enclaveId == ZERO32 (contracts/EnclaveLeaseExecutor.sol:
//     enclaveId is claim-only, a renewal calls ledger.renew(id); the client's renew(id) signs ZERO32);
//     sent by, and paying, a CONFIGURED relay's payee (plan.leaseGas.relays -> the enrollment's payee);
//   - verifyLeaseReceipt (the pinned client's, byte-identical to the release's - asserted below) through that quorum:
//     success receipt, LeaseGasPaid from the reserve for this id/operator/kind/payee, reviewed code at the receipt
//     block, executor nonce consumed, ledger shows this operator still the runner, charge <= the signed maximum;
//   - chargedWei > 0 (paid by the app's reserve: the operator's own account sent nothing - the relay sent it);
//   - the ledger row at the receipt block (ledger.get(id) by the quorum, canonical block hash): runner == the preflight
//     runner, runnerOperator == the Linux operator, leaseUntil after the receipt block's time (verifyLeaseReceipt checks
//     the operator for a renewal, not the runner);
//   - the receipt block after the preflight block, its timestamp after the activation started, and at least 2
//     confirmations below the agreed head.
// Outcome per app and overall: PASS | PENDING (a quorum could not be reached or the tx is not yet visible/confirmed -
// temporary; re-run later) | FAIL (a quorum agreed on a definite semantic failure, or the recorded data itself is wrong).
// Partial proof is never accepted: anything but PASS for both apps is not PASS.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeFunctionData, decodeFunctionResult, encodeFunctionData, createPublicClient, http} from '../enclave/node_modules/viem/_esm/index.js';
import {leaseRpcSet, verifiedLeaseAuthority} from '../enclave/client/lease-executor-authority.mjs';
import {verifyLeaseReceipt, EXECUTOR_ABI} from '../enclave/client/lease-executor-client.mjs';
import {ENROLLMENT} from '../lease-enrollment-signing/trust.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const here = new URL('.', import.meta.url).pathname;
const P = {
  result: arg('result', here + 'activation/result.json'), plan: arg('plan', here + 'activation/plan.json'),
  preflight: arg('preflight', here + 'activation/preflight-used.json'),
  record: arg('record', here + '../lease-relay-activation/deployment.json'),
  out: arg('out', here + '../../outputs/decentralization-audit/linux-post-adoption-paid-renewals.json'),
};
const FIXTURE = process.argv.includes('--fixture-loopback');   // the audit's own test: loopback mock RPCs + fixture record
// the reviewed constants; only the audit's own fixture test (--fixture-loopback) may substitute them
const REVIEWED_DIGEST = FIXTURE ? arg('record-digest') : 'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089';
const OPERATOR = (FIXTURE ? arg('operator') : '0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab').toLowerCase();
const RELAY_PAYEE = FIXTURE ? JSON.parse(arg('relay-payees', '{}'))
  : { 'https://134.209.248.172': 'eu-central' };   // reviewed: the EU relay; the retired US relay is not configured
const KIND_RENEW = 2, ZERO32 = '0x' + '00'.repeat(32);
// the ledger's get(id), as the pinned client declares it (client/lease-executor-client.mjs LEDGER_ABI, not exported)
const LEDGER_GET = [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
  { name: 'id', type: 'bytes32' }, { name: 'owner', type: 'address' }, { name: 'appRef', type: 'string' }, { name: 'ports', type: 'string' },
  { name: 'configCid', type: 'string' }, { name: 'gpuMilli', type: 'uint16' }, { name: 'cpuMilli', type: 'uint16' }, { name: 'appPort', type: 'uint32' },
  { name: 'isPublic', type: 'bool' }, { name: 'active', type: 'bool' }, { name: 'createdAt', type: 'uint64' }, { name: 'rate', type: 'uint256' },
  { name: 'balance6', type: 'uint256' }, { name: 'spent6', type: 'uint256' }, { name: 'runner', type: 'bytes32' }, { name: 'runnerOperator', type: 'address' },
  { name: 'leaseUntil', type: 'uint64' }] }] }];
const lc = (a) => String(a).toLowerCase();
const big = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const report = { at: new Date().toISOString(), audit: 'linux-post-adoption exact-hash app-paid renewal audit', readOnly: true,
                 inputs: {}, apps: [], status: 'PENDING' };
function write(status, extra = {}) {
  Object.assign(report, { status }, extra);
  fs.writeFileSync(P.out, JSON.stringify(report, big, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, reason: report.reason, apps: report.apps.map((a) => ({ id: a.id, hash: a.hash, status: a.status, reason: a.reason })) }, big));
  process.exit(status === 'PASS' ? 0 : status === 'PENDING' ? 3 : 1);
}
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// --- inputs (definite: a wrong input is FAIL; an activation not yet provisional is PENDING) ---
const result = JSON.parse(fs.readFileSync(P.result)), plan = JSON.parse(fs.readFileSync(P.plan)), preflight = JSON.parse(fs.readFileSync(P.preflight));
report.inputs = { result: P.result, resultSha256: sha(P.result), plan: P.plan, planSha256: sha(P.plan), preflight: P.preflight,
  preflightSha256: sha(P.preflight), record: P.record, activationStartedAt: result.startedAt, measurement: result.measurement,
  productionActivated: result.productionActivated, activationState: result.state };
if (result.productionActivated !== 'provisional')
  write('PENDING', { reason: `the activation is not provisional (productionActivated=${JSON.stringify(result.productionActivated)}; state: ${String(result.state).slice(0, 200)})` });
const ids = Object.keys(plan.apps || {}).map(lc);
if (ids.length !== 2) write('FAIL', { reason: 'plan.apps does not name exactly the two apps' });
const renewals = Object.fromEntries(Object.entries(result.renewals || {}).map(([k, v]) => [lc(k), lc(v)]));
if (Object.keys(renewals).length !== 2 || !ids.every((i) => /^0x[0-9a-f]{64}$/.test(renewals[i] || '')))
  write('FAIL', { reason: 'result.renewals is not exactly one 32-byte transaction hash per plan app', renewals });
if (new Set(Object.values(renewals)).size !== 2) write('FAIL', { reason: 'both apps name the same transaction', renewals });
const recordRaw = fs.readFileSync(P.record), recordDigest = 'sha256:' + createHash('sha256').update(recordRaw).digest('hex');
if (recordDigest !== REVIEWED_DIGEST || plan.leaseGas?.digest !== REVIEWED_DIGEST)
  write('FAIL', { reason: `deployment record ${recordDigest} / plan ${plan.leaseGas?.digest} is not the reviewed ${REVIEWED_DIGEST}` });
const deployment = JSON.parse(recordRaw);
const payees = [];
for (const url of plan.leaseGas.relays) {
  const label = RELAY_PAYEE[url], hit = FIXTURE ? label && [label, label] : ENROLLMENT.relays.find(([l]) => l === label);
  if (!hit) write('FAIL', { reason: `configured relay ${url} has no reviewed payee` });
  payees.push(lc(hit[1]));
}
const preRows = Object.fromEntries((preflight.rows || []).map((r) => [lc(r.id), r]));
const preBlock = BigInt(preflight.block.number), startedSec = Math.floor(Date.parse(result.startedAt) / 1000);
if (!Number.isFinite(startedSec)) write('FAIL', { reason: 'result.startedAt is not a time' });
// the pinned verifier: the release's own verifyLeaseReceipt (main's copy imported here must be byte-identical)
const fnText = (p) => { const s = fs.readFileSync(p, 'utf8'), i = s.indexOf('export async function verifyLeaseReceipt'); return s.slice(i, s.indexOf('\n}\n', i) + 2); };
const relClient = here + 'tree/client/lease-executor-client.mjs', usedClient = here + '../enclave/client/lease-executor-client.mjs';
report.inputs.verifierSha256 = createHash('sha256').update(fnText(usedClient)).digest('hex');
if (fnText(relClient) !== fnText(usedClient)) write('FAIL', { reason: 'the imported verifyLeaseReceipt differs from the release\'s' });
if (sha(here + 'tree/client/lease-executor-authority.mjs') !== sha(here + '../enclave/client/lease-executor-authority.mjs'))
  write('FAIL', { reason: 'the imported lease authority differs from the release\'s' });
report.inputs = { ...report.inputs, recordDigest, operator: OPERATOR, payees, preflightBlock: preBlock, renewals };

// --- the independent quorum ---
const rpcs = FIXTURE ? JSON.parse(arg('rpcs')) : plan.leaseGas.rpcs;
const clients = rpcs.map((url) => createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 1 }) }));
const inner = leaseRpcSet(clients, { quorum: 2, allowLoopbackHttp: FIXTURE, timeoutMs: 30_000 });
if (inner.required < 2 && !FIXTURE) write('FAIL', { reason: 'quorum below 2' });
const name = new Map(inner.peers.map((p, i) => [p, rpcs[i]]));
let outcomes = [];
// the pinned agree() decides; this wrapper only RECORDS each provider's outcome, to tell unavailable from definite
const rpc = { ...inner, agree: (members, read, what) => inner.agree(members, async (m) => {
  try { const v = await read(m); outcomes.push({ what, rpc: name.get(m), ok: true }); return v; }
  catch (e) { outcomes.push({ what, rpc: name.get(m), ok: false, error: String(e?.shortMessage || e?.message || e).slice(0, 200), name: e?.name }); throw e; }
}, what) };
// verifyLeaseReceipt's own definite verdicts (client/lease-executor-client.mjs) and this audit's: a quorum agreeing on
// one of these is FAIL; anything else (timeouts, HTTP, not found yet, disagreement) is PENDING
const DEFINITE = [/do not identify the same block/, /does not call this operator/, /wrong lease chain or value/, /not a canonical lease call/,
  /another lease than the one signed/, /deadline or maximum charge differs/, /a payee this host never signed/, /reverted/,
  /no LeaseGasPaid from the reserve/, /unreviewed lease code/, /did not consume this lease nonce/, /charge exceeds the signed maximum/,
  /ledger does not show/, /^AUDIT: /];
function classify(what) {
  const mine = outcomes.filter((o) => o.what === what && !o.ok);
  const byMsg = new Map(); for (const o of mine) if (DEFINITE.some((r) => r.test(o.error))) byMsg.set(o.error, (byMsg.get(o.error) || 0) + 1);
  const definite = [...byMsg].find(([, n]) => n >= inner.required);
  return definite ? { status: 'FAIL', reason: `${inner.required}+ RPCs agree: ${definite[0]}` }
                  : { status: 'PENDING', reason: `no RPC quorum on ${what}: ` + mine.map((o) => `${o.rpc}: ${o.error}`).join(' | ') };
}
let authority;
try { authority = await verifiedLeaseAuthority({ clients, deployment, quorum: 2, allowLoopbackHttp: FIXTURE, timeoutMs: 30_000 }); }
catch (e) { write('PENDING', { reason: 'the pinned deployment could not be verified by an RPC quorum now: ' + String(e.message).slice(0, 200) }); }
const pins = authority.pins, head = BigInt(authority.block.number);
report.inputs.agreedBlock = { number: head, hash: authority.block.hash, agreeing: authority.agreeing };

for (const id of ids) {
  const hash = renewals[id], app = { id, hash, status: 'PENDING' };
  report.apps.push(app); outcomes = []; app.providerOutcomes = outcomes;   // per app: one app's errors never classify another
  try {
    // 1. the transaction, by quorum: what lease it is (this audit's own checks - definite once a quorum shows it)
    let tx;
    try { tx = (await rpc.agree(rpc.peers, async ({ client }) => {
        const t = await client.getTransaction({ hash });
        let call; try { call = decodeFunctionData({ abi: EXECUTOR_ABI, data: t.input }); } catch { throw new Error('AUDIT: not an executor lease() call'); }
        if (call.functionName !== 'lease') throw new Error('AUDIT: not an executor lease() call');
        const l = call.args[0];
        return { from: lc(t.from), to: lc(t.to), blockNumber: t.blockNumber, blockHash: lc(t.blockHash),
                 lease: { id: lc(l.id), kind: Number(l.kind), enclaveId: lc(l.enclaveId), nonce: BigInt(l.nonce), deadline: BigInt(l.deadline), payee: lc(l.payee), maxChargeWei: BigInt(l.maxChargeWei) } };
      }, 'the renewal transaction')).value; }
    catch { Object.assign(app, classify('the renewal transaction')); continue; }
    const L = tx.lease, why = [];
    if (tx.to !== OPERATOR) why.push(`sent to ${tx.to}, not the Linux operator`);
    if (L.id !== id) why.push(`renews ${L.id}, not this app`);
    if (L.kind !== KIND_RENEW) why.push(`kind ${L.kind}, not a renewal (2)`);
    if (L.kind === KIND_RENEW && L.enclaveId !== ZERO32) why.push(`enclaveId ${L.enclaveId} is not the canonical ZERO32 a renewal signs`);
    if (!preRows[id] || !/^0x[0-9a-f]{64}$/.test(lc(preRows[id].runner)) || lc(preRows[id].runner) === ZERO32) why.push(`the preflight names no runner for this app`);
    if (!payees.includes(L.payee) || !payees.includes(tx.from)) why.push(`payee ${L.payee} / sender ${tx.from} is not a configured relay payee`);
    if (tx.blockNumber == null) { Object.assign(app, { status: 'PENDING', reason: 'not mined yet' }); continue; }
    if (BigInt(tx.blockNumber) <= preBlock) why.push(`block ${tx.blockNumber} is not after the preflight block ${preBlock}`);
    if (why.length) { Object.assign(app, { status: 'FAIL', reason: why.join('; '), lease: L }); continue; }
    // 2. confirmations below the agreed head
    if (BigInt(tx.blockNumber) > head) { Object.assign(app, { status: 'PENDING', reason: `block ${tx.blockNumber} above the agreed (2-confirmation) head ${head}`, lease: L }); continue; }
    // 3. the pinned verifier, through the quorum
    let v;
    try { v = await verifyLeaseReceipt({ rpc, pins, operator: OPERATOR, hash, want: { id: L.id, kind: L.kind, enclaveId: L.enclaveId, nonce: L.nonce, deadline: L.deadline, maxChargeWei: L.maxChargeWei }, payees }); }
    catch { Object.assign(app, classify('the landed lease'), { lease: L }); continue; }
    // 4. the block's time, by quorum, at the receipt's block hash
    let blk;
    try { blk = (await rpc.agree(rpc.peers, async ({ client }) => { const b = await client.getBlock({ blockHash: v.blockHash }); return { number: b.number, timestamp: b.timestamp, hash: lc(b.hash) }; }, 'the receipt block')).value; }
    catch { Object.assign(app, classify('the receipt block'), { lease: L }); continue; }
    if (Number(blk.timestamp) < startedSec) { Object.assign(app, { status: 'FAIL', reason: `block time ${blk.timestamp} is before the activation started (${startedSec})` }); continue; }
    // 5. the ledger row at the receipt block, by quorum: still this host's lease (runner AND operator), extended
    let row;
    try { row = (await rpc.agree(rpc.peers, async (p) => {
        const data = await rpc.request(p.client, 'eth_call', [{ to: pins.ledger, data: encodeFunctionData({ abi: LEDGER_GET, functionName: 'get', args: [L.id] }) },
                                                             { blockHash: v.blockHash, requireCanonical: true }]);
        const d = decodeFunctionResult({ abi: LEDGER_GET, functionName: 'get', data });
        return { id: lc(d.id), runner: lc(d.runner), runnerOperator: lc(d.runnerOperator), leaseUntil: BigInt(d.leaseUntil) };
      }, 'the ledger row at the receipt block')).value; }
    catch { Object.assign(app, classify('the ledger row at the receipt block'), { lease: L }); continue; }
    const rowWhy = [];
    if (row.id !== id) rowWhy.push(`ledger row ${row.id} is not this app`);
    if (row.runner !== lc(preRows[id].runner)) rowWhy.push(`ledger runner ${row.runner} is not the preflight runner ${lc(preRows[id].runner)}`);
    if (row.runnerOperator !== OPERATOR) rowWhy.push(`ledger runnerOperator ${row.runnerOperator} is not the Linux operator`);
    if (!(row.leaseUntil > BigInt(blk.timestamp))) rowWhy.push(`ledger leaseUntil ${row.leaseUntil} is not after the receipt block time ${blk.timestamp}`);
    if (rowWhy.length) { Object.assign(app, { status: 'FAIL', reason: rowWhy.join('; '), lease: L, ledgerRow: row }); continue; }
    if (!(v.chargedWei > 0n)) { Object.assign(app, { status: 'FAIL', reason: 'no positive charge to the app reserve' }); continue; }
    Object.assign(app, { status: 'PASS', reason: 'renewal verified', kind: L.kind, operator: OPERATOR, payee: lc(v.payee), relaySender: tx.from,
      blockNumber: v.blockNumber, blockHash: v.blockHash, blockTimestamp: blk.timestamp, chargedWei: v.chargedWei, maxChargeWei: L.maxChargeWei,
      leaseNonce: L.nonce, enclaveId: L.enclaveId, ledgerRow: row });
  } catch (e) { Object.assign(app, { status: 'PENDING', reason: 'audit error: ' + String(e?.message || e).slice(0, 200) }); }
}
const st = report.apps.some((a) => a.status === 'FAIL') ? 'FAIL' : report.apps.every((a) => a.status === 'PASS') ? 'PASS' : 'PENDING';
write(st, { reason: st === 'PASS' ? 'both renewals are app-paid, exact, canonical and confirmed' : st === 'FAIL' ? 'a renewal definitely failed verification' : 'not yet provable; re-run' });
