// Pin a deployment its owner holds directly to one host, or lift the pin. Shared by placement-plan.mjs (writes the
// step) and server.mjs (what is done, what is ready).
//
// The pin is the option's placement.hostId. Every other host refuses a pinned deployment, and the host that runs it
// stops it and releases its lease when it next renews, so the pinned host can claim it.
import { LEDGER_ABI } from './abi.mjs';

// The option with its placement set to `hostId`, or without one for a null `hostId`. Nothing else changes, and the
// other keys keep their order. An option that is not a JSON object is refused: hosts would not read a pin from it.
export function placedOption(option, hostId) {
  let o;
  try { o = String(option).trim() ? JSON.parse(option) : {}; } catch { throw new Error('the deployment’s option is not JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('the deployment’s option is not a JSON object');
  if (hostId === null) { delete o.placement; return JSON.stringify(o); }
  if (!/^0x[0-9a-f]{64}$/.test(hostId || '')) throw new Error('the host id is not 32 bytes of lowercase hex');
  return JSON.stringify({ ...o, placement: { hostId } });
}

// One transaction. It is done once the ledger holds the new option, and ready only while the ledger still holds the
// option the plan was written against and the call simulates from the owner's address.
export async function placementStatus(plan, pub, { journal = [] } = {}) {
  const s = plan.status, step = plan.steps[0], now = BigInt(Math.floor(Date.now() / 1000));
  const d = await pub.readContract({ address: s.ledger, abi: LEDGER_ABI, functionName: 'get', args: [s.deployment] });
  const done = d.configCid === s.newOption;
  let blocked = done || d.configCid === s.oldOption ? null : 'the deployment’s option changed after this page was prepared';
  if (!done && !blocked) {
    try { await pub.call({ account: plan.owner, to: step.to, data: step.data }); }
    catch (e) { blocked = 'it would revert: ' + String(e.shortMessage || e.message).slice(0, 160); }
  }
  const leased = !/^0x0+$/.test(d.runner) && d.leaseUntil > now, until = new Date(Number(d.leaseUntil) * 1000).toISOString().slice(11, 19) + 'Z';
  const note = !leased ? 'No host holds its lease now.'
    : s.hostId && d.runner.toLowerCase() === s.hostId ? `The pinned host runs it now (lease until ${until}).`
    : `Host ${d.runner.slice(0, 10)}… runs it now (lease until ${until})${done && s.hostId ? '; it stops it and releases the lease before that time' : ''}.`;
  return { [step.id]: done, ready: { [step.id]: !done && !blocked }, blocked: { [step.id]: blocked }, note: { [step.id]: note },
    runner: d.runner, leaseUntil: String(d.leaseUntil), journal };
}
