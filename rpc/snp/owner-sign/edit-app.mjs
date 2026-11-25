// Change the name and description the catalog shows for an app (EnclaveAppCatalog.editApp). Shared by
// edit-app-plan.mjs (writes the step) and server.mjs (what is done, what is ready).
//
// editApp is display only: it publishes no version, and no deployment's app ref, option or lease changes.
import { CATALOG_ABI } from './abi.mjs';

export const MAX_NAME = 80, MAX_DESC = 500;   // the catalog's limits, in bytes
const bytes = (s) => new TextEncoder().encode(s).length;

// The text as the catalog will take it, or an error naming what it would refuse.
export function checkedText(name, description) {
  if (typeof name !== 'string' || typeof description !== 'string') throw new Error('the name and the description must be text');
  if (!bytes(name) || bytes(name) > MAX_NAME) throw new Error(`the name must be 1 to ${MAX_NAME} bytes`);
  if (bytes(description) > MAX_DESC) throw new Error(`the description is ${bytes(description)} bytes; the catalog takes at most ${MAX_DESC}`);
  return { name, description };
}

// One transaction. It is done once the catalog holds the new text, and ready only while the catalog still holds the
// text the plan was written against and the call simulates from the owner's address.
export async function editAppStatus(plan, pub, { journal = [] } = {}) {
  const s = plan.status, step = plan.steps[0];
  const app = await pub.readContract({ address: s.catalog, abi: CATALOG_ABI, functionName: 'getApp', args: [s.appId] });
  const done = app.name === s.newName && app.description === s.newDescription;
  let blocked = done || (app.name === s.oldName && app.description === s.oldDescription) ? null : 'the app’s name or description changed after this page was prepared';
  if (!done && !blocked) {
    try { await pub.call({ account: plan.owner, to: step.to, data: step.data }); }
    catch (e) { blocked = 'it would revert: ' + String(e.shortMessage || e.message).slice(0, 160); }
  }
  return { [step.id]: done, ready: { [step.id]: !done && !blocked }, blocked: { [step.id]: blocked },
    note: { [step.id]: done ? 'The catalog shows the new text.' : 'The catalog shows the old text.' }, journal };
}
