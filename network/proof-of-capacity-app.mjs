// A capacity check's look at THE APP a host serves, as a further check for createCapacityChecker's `also`
// (proof-of-capacity-host.mjs). The work proves processors and memory; this proves that one of the apps the host is
// paid for runs where the host says it does: in its own guest, on that host's hardware, on the key its public
// certificate carries.
//
// It is the check a customer's own page runs, with the same code: the independent browser verifier
// (verifier/web/dist/enclave-verifier-web.js, one file with no dependencies, which also runs under Node), handed in as
// `verifier`. Per target and round:
//   1. the public apps the relay lists for the host's box (GET /v1/enclaves/<box>/apps), and of those only the ones THE
//      LEDGER says are leased to this host now (`leaseOf`, the checker's own chain read);
//   2. one of them, chosen from the epoch's seed and the checker's id (the host cannot know which before the seed is
//      fixed, and two checkers usually look at different apps);
//   3. that app's guest, verified whole: the host first (a confidential server's AMD report, an Enclave Shield box's TPM
//      session, a phone's protected-VM chain, each over this checker's own nonce), then the app guest's report over a
//      second nonce: the vendor's signature chain, the binding of the TLS key, the app and the deployment, the
//      measurement against what the relay predicts or admits for it.
//
// WHAT COUNTS AGAINST THE HOST: only evidence that was read and refused (the verifier's "rejected" with a check that
// came out false: a report that does not verify, another app, another key, another chip, a measurement nobody admits).
// Everything else is NOT JUDGED and leaves the verdict to the work: no app leased, a relay that is busy, slow or absent,
// a guest still starting, an answer the verifier could not use, a tier the verifier does not know. A checker must
// never fail a host for what the checker or the relay could not do.
//
// WHAT IT LEANS ON, and says in the record: which box is the host's, which measurements are admitted and which app a
// deployment names are the relay's statements (the verifier's "limited" and its omissions). The relay cannot forge a
// report; it can withhold one (then nothing is judged) and it can state a wrong expectation (then an honest host is
// refused, by every checker alike). `enforce: false` records the result without letting it fail anybody.
//
// No package import here (see proof-of-capacity.mjs).
import {createHash} from 'node:crypto';

export const APP_CHECK = 'served-app';
const HEX32 = /^0x[0-9a-f]{64}$/, NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VERIFY = Object.freeze({snp: 'verifySnpAppWeb', 'hv-node': 'verifyShieldAppWeb', avf: 'verifyPvmAppWeb'});

/** Which of `ids` this checker looks at in this epoch: the one whose hash under the seed and the checker is smallest. */
export function pickApp(ids, seed, checker) {
  const score = id => createHash('sha256').update(Buffer.from(String(seed).slice(2) + String(checker).slice(2) + String(id).slice(2), 'hex')).digest('hex');
  return [...ids].sort((a, b) => (score(a) < score(b) ? -1 : 1))[0] ?? null;
}

/**
 * -> an `also` check: async (target, row, {epoch, seed}) -> {name, ok: true|false|null, why, evidence?}
 *   host: the checker's id; apiBase: the relay (https)
 *   verifier: the independent verifier's module ({verifySnpAppWeb, verifyShieldAppWeb, verifyPvmAppWeb}), or a function
 *     returning it (loaded on first use)
 *   leaseOf(id) -> {runner, leaseUntil (unix s), active, isPublic} | null: the ledger's record, read by the checker
 *   boxOf(target, row) -> {name} | null: the relay's box name for the host (default: the endpoint's /t/<name>, else the
 *     relay's /enclaves row with this id)
 *   enforce: false records a refusal as not judged
 */
export function createAppCheck({host, apiBase, verifier, leaseOf, boxOf = null, fetch = globalThis.fetch, enforce = true,
  timeoutMs = 60000, listTimeoutMs = 15000, now = Date.now}) {
  if (!HEX32.test(String(host)) || !/^https:\/\//.test(String(apiBase || '')) || typeof leaseOf !== 'function') throw new Error('app check: host id, the relay\'s https base and a ledger reader');
  const base = String(apiBase).replace(/\/+$/, '');
  const getJson = async url => {
    const r = await fetch(url, {redirect: 'error', headers: {accept: 'application/json'}, signal: AbortSignal.timeout(listTimeoutMs)});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const defaultBox = async (target, row) => {
    const m = /\/t\/([A-Za-z0-9_-]{1,64})\/?$/.exec(String(row?.endpoint || ''));
    if (m) return {name: m[1]};
    const list = await getJson(base + '/enclaves'), rows = Array.isArray(list) ? list : list?.enclaves;
    const e = (rows || []).find(x => String(x?.id || '').toLowerCase() === target && NAME.test(String(x?.name || '')));
    return e ? {name: e.name} : null;
  };
  let mod = null;
  const unjudged = why => ({name: APP_CHECK, ok: null, why: String(why).slice(0, 240)});
  return async function appCheck(target, row, {epoch, seed}) {
    let box, listed;
    try {
      box = await (boxOf || defaultBox)(target, row);
      if (!box || !NAME.test(String(box.name || ''))) return unjudged('the relay lists no box for this host');
      listed = await getJson(`${base}/v1/enclaves/${box.name}/apps`);
    } catch (e) { return unjudged(`the relay's list of the host's apps: ${e?.message || e}`); }
    const fn = VERIFY[listed?.mode];
    if (!fn) return unjudged(`no app verifier for a host of mode ${JSON.stringify(listed?.mode ?? null)}`);
    // only what the ledger says this host is paid for now
    const leased = [];
    for (const a of (Array.isArray(listed.apps) ? listed.apps : []).slice(0, 64)) {
      const id = String(a?.id || '').toLowerCase();
      if (!HEX32.test(id)) continue;
      let d = null; try { d = await leaseOf(id); } catch (e) { return unjudged(`the ledger's record of ${id.slice(0, 10)}: ${e?.shortMessage || e?.message || e}`); }
      if (d && d.active === true && d.isPublic === true && String(d.runner || '').toLowerCase() === target && Number(d.leaseUntil) * 1000 > now() + timeoutMs) leased.push(id);
    }
    const deployment = pickApp(leased, seed, host);
    if (!deployment) return unjudged('no public app is leased to this host now');
    let v;
    try {
      mod = mod || (typeof verifier === 'function' ? await verifier() : verifier);
      if (typeof mod?.[fn] !== 'function') return unjudged(`this checker has no ${fn}`);
      v = await mod[fn]({apiBase: base, name: box.name, deployment, fetchImpl: fetch, timeoutMs});
    } catch (e) { return unjudged(`the verifier: ${e?.message || e}`); }
    const failed = Object.entries(v?.checks || {}).filter(([, ok]) => ok === false).map(([k]) => k);
    const why = String((v?.reasons || []).filter(r => !/^(OMITTED|WARNING)/.test(r)).at(-1) || v?.summary || v?.status || 'no verdict').slice(0, 240);
    const evidence = {epoch, box: box.name, mode: listed.mode, deployment, of: leased.length, status: v?.status ?? null,
      ...(failed.length ? {failed} : {}), ...(v?.omissions?.length ? {omissions: v.omissions.slice(0, 16)} : {})};
    if (v?.status === 'verified' || v?.status === 'limited') return {name: APP_CHECK, ok: true, why: `${deployment.slice(0, 10)} ${v.status}`, evidence};
    // refused evidence: a check that was made and came out false. A refusal with no failed check (the relay answered
    // for something else) and every "error" say nothing about the host.
    if (v?.status === 'rejected' && failed.length) return enforce ? {name: APP_CHECK, ok: false, why: `${deployment.slice(0, 10)}: ${why}`, evidence}
      : {name: APP_CHECK, ok: null, why: `recorded, not enforced: ${deployment.slice(0, 10)}: ${why}`.slice(0, 240), evidence};
    return {...unjudged(`${deployment.slice(0, 10)}: ${why}`), evidence};
  };
}
