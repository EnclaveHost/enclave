// Strict hash-pinned generator: baseline network/deployment-lifecycle-journal.mjs (b7dcf5af9 tree, SHA-256 below) ->
// the OWNED lifecycle journal candidate with a host-authority section. Insertions only (insertion-patch.mjs self-proof).
//
// What the section holds, per host id: the highest AUTHENTICATED host-owner floor accepted by the dispatch
// ({ revision, owner, policyHash }), the box owner's local holds ({ why, ownerEpoch, at } per deployment) and the
// owner-control epoch. Rules enforced here, durably, before the caller acts:
//  - acceptHostAuthority: monotonic; a lower revision, or another owner/policy at the same revision, throws.
//  - holdHostLocal: records the hold under the CURRENT owner-control epoch.
//  - releaseHostLocal: only a hold recorded under an EARLIER epoch (a later authenticated owner control change).
//  - advanceOwnerControls: +1, only from the host's saved owner caps change (dispatch.ownerControlsChanged).
// Older journals (no section) open unchanged and are never cleared or rewritten except by these methods. No key,
// session authority or chain state is stored here. The baseline journal ignores (and preserves) the section.
//
//   node generate-lifecycle-journal-candidate.mjs /abs/baseline/network/deployment-lifecycle-journal.mjs /abs/out/deployment-lifecycle-journal.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyInsertions, writeInsertions } from './insertion-patch.mjs';

export const BASELINE_JOURNAL_SHA256 = 'c4db54b3509f7a318b938dbfe11abdf565742611ffe6e8898d465b6fa005f601';
const MARKER = 'validateHostAuthority(';

export const JOURNAL_EDITS = Object.freeze([
  { name: 'validate',
    before: '  j.authorityAnchors ??= {};\n',
    after: "  if (!j.authorityAnchors || typeof j.authorityAnchors !== 'object'",
    text: '  validateHostAuthority(j);   // r3: owned host-authority floors and local holds (absent in older journals: empty)\n' },
  { name: 'helper',
    before: '  return j;\n}\n',
    after: 'function validAnchor(a) {',
    text: `// r3 (lifecycle-independent-composition-r3): the OWNED host-authority section. Per host id: the highest authenticated
// host-owner floor, the box owner's local holds and the owner-control epoch they were recorded under.
const HOST_REVISION = /^(0|[1-9][0-9]{0,77})$/, HOST_ADDRESS = /^0x[0-9a-f]{40}$/;
function validateHostAuthority(j) {
  j.hostAuthority ??= {};
  const h = j.hostAuthority;
  if (!h || typeof h !== 'object' || Array.isArray(h) || Object.keys(h).length > 16) throw Error('invalid host authority journal');
  for (const [host, e] of Object.entries(h)) {
    if (!ID.test(host) || !e || typeof e !== 'object' || !int(e.ownerEpoch) || !e.holds || typeof e.holds !== 'object' ||
        Array.isArray(e.holds) || Object.keys(e.holds).length > 4096) throw Error('invalid host authority entry');
    if (e.floor !== null && (!e.floor || typeof e.floor.revision !== 'string' || !HOST_REVISION.test(e.floor.revision) ||
        !HOST_ADDRESS.test(e.floor.owner) || /^0x0{40}$/.test(e.floor.owner) || !ID.test(e.floor.policyHash))) throw Error('invalid host authority floor');
    for (const [id, x] of Object.entries(e.holds))
      if (!ID.test(id) || !x || typeof x.why !== 'string' || !x.why.length || x.why.length > 300 || !int(x.ownerEpoch) ||
          x.ownerEpoch > e.ownerEpoch || !int(x.at)) throw Error('invalid local hold');
  }
}
` },
  { name: 'updateHost',
    before: '    state = next; return structuredClone(changed);\n  }\n',
    after: '  return {\n    read,',
    text: `  // r3: one host-authority entry, committed durably BEFORE the caller acts on it (same write discipline as update()).
  function updateHost(hostId, change) {
    check(); idOf(hostId);
    const next = structuredClone(state);
    next.hostAuthority ??= {};
    const changed = change(structuredClone(next.hostAuthority[hostId] || { floor: null, ownerEpoch: 0, holds: {} }));
    next.hostAuthority[hostId] = changed;
    validate(next);
    try { strictWriteFile(file, JSON.stringify(next), { fsImpl, platform }); }
    catch (e) { failed = \`lifecycle journal write failed: \${e.message}\`; throw e; }
    state = next; return structuredClone(changed);
  }
` },
  { name: 'methods',
    before: '      state = next;\n    },\n',
    after: '    failure(id, args) {',
    text: `    // ---- r3 owned host authority (validateHostAuthority) ----
    readHostAuthority(hostId) { check(); idOf(hostId); return structuredClone(state.hostAuthority?.[hostId] || null); },
    acceptHostAuthority(hostId, { revision, owner, policyHash }) {
      return updateHost(hostId, e => {
        if (typeof revision !== 'string' || !HOST_REVISION.test(revision) || !HOST_ADDRESS.test(owner) || /^0x0{40}$/.test(owner) || !ID.test(policyHash))
          throw Error('invalid host authority');
        const f = e.floor;
        if (f && (BigInt(revision) < BigInt(f.revision) || BigInt(revision) === BigInt(f.revision) && (owner !== f.owner || policyHash !== f.policyHash)))
          throw Error('host authority rollback or equivocation');
        return { ...e, floor: { revision, owner, policyHash } };
      }).floor;
    },
    holdHostLocal(hostId, id, { why, at }) {
      idOf(id);
      return updateHost(hostId, e => ({ ...e, holds: { ...e.holds, [id]: { why: String(why), ownerEpoch: e.ownerEpoch, at } } })).holds[id];
    },
    releaseHostLocal(hostId, id) {
      idOf(id);
      return updateHost(hostId, e => {
        const x = e.holds[id];
        if (!x) throw Error('no such local hold');
        if (!(x.ownerEpoch < e.ownerEpoch)) throw Error('a local hold is released only by a later owner control change');
        const holds = { ...e.holds }; delete holds[id];
        return { ...e, holds };
      });
    },
    advanceOwnerControls(hostId) { return updateHost(hostId, e => ({ ...e, ownerEpoch: e.ownerEpoch + 1 })).ownerEpoch; },
` },
]);

export function generateJournalCandidate(baseline, { expectedSha256 = BASELINE_JOURNAL_SHA256, edits = JOURNAL_EDITS } = {}) {
  return applyInsertions(baseline, { expectedSha256, edits, marker: MARKER, what: 'baseline deployment-lifecycle-journal.mjs' });
}
export const writeJournalCandidate = (input, output) => writeInsertions(input, output, generateJournalCandidate, BASELINE_JOURNAL_SHA256);

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: generate-lifecycle-journal-candidate.mjs <baseline journal> <output file>'); process.exit(2); }
  console.log(JSON.stringify(writeJournalCandidate(input, output), null, 1));
}
