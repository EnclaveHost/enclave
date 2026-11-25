// Write PLAN.json for owner-sign/server.mjs: one configure() per deployment that moves ONE field of the owner's
// lease-gas policy (EnclaveLeaseGasReserve) and restates every other field as the chain has it now.
//
//   node rpc/snp/owner-sign/reserve-policy-plan.mjs RESERVE OWNER claimCooldown=900 JOURNAL OUT_PLAN.json ID[=label]...
//
// configure() replaces the whole policy, so each step is built from that deployment's reserveOf() at this moment and
// simulated from the owner. Only deployments whose owner of record is OWNER itself are planned: one owned through a
// vault or a Safe needs that contract's own path (network/lease-gas-owner.mjs ownerRequest) and is listed as skipped.
// A deployment already at the value gets no step. server.mjs (kind "reserve-policy") offers a step only while the
// rest of the policy is still what the step restates, so a policy changed in between is not written over.
import fs from 'node:fs';
import { createPublicClient, fallback, getAddress, http } from 'viem';
import { base } from 'viem/chains';
import { LEDGER_ABI, OWNER_ABI, checkPolicy, ownerCall } from '../../../network/lease-gas-owner.mjs';

export const POLICY_FIELDS = ['enabled', 'claimPolicy', 'sponsorRelease', 'maxClaimsPerEpoch', 'maxPerOpWei', 'epochCapWei', 'epochSec',
  'renewWindow', 'minExtension', 'claimCooldown', 'maxGasPrice'];
export const policyOf = (r) => Object.fromEntries(POLICY_FIELDS.map((k) => [k, typeof r[k] === 'bigint' ? r[k].toString() : r[k]]));
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const LEDGER = '0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B';

if (import.meta.url === `file://${process.argv[1]}`) {
  const [reserveArg, ownerArg, change, journal, outPath, ...targets] = process.argv.slice(2);
  const m = /^([A-Za-z]+)=(\d+)$/.exec(change || '');
  if (!m || !POLICY_FIELDS.includes(m[1]) || !outPath || !targets.length) throw new Error('usage: reserve-policy-plan.mjs RESERVE OWNER field=value JOURNAL OUT_PLAN.json ID[=label]...');
  const [field, value] = [m[1], m[2]];
  if (['enabled', 'sponsorRelease'].includes(field)) throw new Error('this planner moves numeric fields only');
  const reserve = getAddress(reserveArg), owner = getAddress(ownerArg);
  const pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { timeout: 15000 }))) });
  const steps = [], status = {}, skipped = [];
  for (const t of targets) {
    const [id, label = t.slice(0, 10)] = t.split('=');
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error('not a deployment id: ' + id);
    const d = await pub.readContract({ address: LEDGER, abi: LEDGER_ABI, functionName: 'get', args: [id] });
    if (getAddress(d.owner) !== owner) { skipped.push({ id, label, why: 'its owner of record is ' + d.owner + ', not this wallet' }); continue; }
    const now = policyOf(await pub.readContract({ address: reserve, abi: OWNER_ABI, functionName: 'reserveOf', args: [id, owner] }));
    if (!now.enabled) { skipped.push({ id, label, why: 'its reserve is not enabled' }); continue; }
    if (String(now[field]) === value) { skipped.push({ id, label, why: `${field} is already ${value}` }); continue; }
    const policy = { ...now, [field]: field.endsWith('Wei') || field === 'maxGasPrice' ? value : Number(value) };
    checkPolicy(policy);
    const call = ownerCall('configure', { id, policy });
    await pub.call({ account: owner, to: reserve, data: call.data });   // the simulation must pass now
    const step = 'p' + id.slice(2, 10);
    steps.push({ id: step, title: `${label}: ${field} ${now[field]} → ${value}`,
      why: `Sets ${field} to ${value} on this deployment's lease-gas policy. Every other field is restated as it is on chain now.`,
      to: reserve, data: call.data, value: '0x0', valueEth: '0',
      show: { Deployment: id, Call: 'configure(deployment, policy)', [field]: `${now[field]} → ${value}`,
        Unchanged: POLICY_FIELDS.filter((k) => k !== field).map((k) => `${k} ${now[k]}`).join(', ') } });
    status[step] = { id, before: now, field, value };
  }
  if (!steps.length) throw new Error('nothing to change: ' + JSON.stringify(skipped));
  fs.writeFileSync(outPath, JSON.stringify({ kind: 'reserve-policy', title: `Lease gas: ${field} ${value} on ${steps.length} deployment${steps.length > 1 ? 's' : ''}`,
    lead: 'Each step is one transaction from your owner wallet on Base to the lease-gas reserve. Check the details on the Trezor screen before confirming. This page never signs or sends anything by itself. Nothing running is touched: the policy is read at the next sponsored claim.',
    chainId: 8453, owner, rpcs: RPCS, journal, status: { reserve, steps: status }, steps, skipped }, null, 1) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ wrote: outPath, steps: steps.map((s) => s.title), skipped }));
}
