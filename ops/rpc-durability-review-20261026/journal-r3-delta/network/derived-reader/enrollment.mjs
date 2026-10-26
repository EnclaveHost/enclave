// Plans are restrictions, never chain proofs. Only a trusted provider's fresh
// committed scan and authenticated enrollment can authorize a state rebind.
import { journalBytesDigest } from '../journal-commit.mjs';
import { validateAnchor, validateDerivedState } from './journal.mjs';
export const READER_FILE = 'reader/derived-state.json', BRIDGE_FILE = 'bridge/anchor-journal.json';
const HEX = /^[0-9a-f]{64}$/;
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  throw Error('invalid canonical enrollment value');
}
export function derivedEnrollmentFloorDigest(floor) {
  if (floor !== null) checkedFloor(floor);
  return journalBytesDigest(canonicalJson(floor));
}
function checkedFloor(floor) {
  validateAnchor(floor);
  if (floor.tier !== 'l1-finalized-derived') throw Error('enrollment floor must be derived');
  return floor;
}
// Compare both chains, not lexicographically. Equal-height contradictions can
// never be hidden by selecting a larger block number on the other chain.
function dominates(a, b) {
  checkedFloor(a); checkedFloor(b);
  for (const k of ['base', 'l1']) if (a[k].number === b[k].number) {
    const fields = ['hash', 'stateRoot', 'timestamp', ...(k === 'base' ? ['outputRoot', 'messagePasserStorageRoot'] : [])];
    if (fields.some(f => a[k][f] !== b[k][f])) throw Error('same-height enrollment floor contradiction');
  }
  return a.base.number >= b.base.number && a.l1.number >= b.l1.number;
}
export function dominantEnrollmentFloor(...floors) {
  let result = null;
  for (const floor of floors) {
    if (floor === null) continue;
    checkedFloor(floor);
    if (!result) { result = floor; continue; }
    if (dominates(floor, result)) result = floor;
    else if (!dominates(result, floor)) throw Error('incomparable enrollment floors');
  }
  return JSON.parse(canonicalJson(result));
}
export function parseEnrollmentJournals(local) {
  let reader = null, bridge = null;
  if (local[READER_FILE] !== undefined) {
    reader = JSON.parse(local[READER_FILE]);
    if (!HEX.test(reader?.binding || '')) throw Error('invalid saved reader binding');
    validateDerivedState(reader, { binding: reader.binding, requireCommit: true, allowPending: true });
  }
  if (local[BRIDGE_FILE] !== undefined) {
    bridge = JSON.parse(local[BRIDGE_FILE]);
    if (bridge?.version !== 1 || !Array.isArray(bridge.deployments) || bridge.deployments.length ||
        !bridge.authorityAnchors || typeof bridge.authorityAnchors !== 'object' || Array.isArray(bridge.authorityAnchors) ||
        Object.keys(bridge.authorityAnchors).some(k => k !== '8453')) throw Error('invalid dedicated bridge enrollment journal');
    if (bridge.authorityAnchors['8453']) checkedFloor(bridge.authorityAnchors['8453']);
  }
  return { reader, bridge };
}
export function proposedEnrollmentFloor(local, enrollmentFloor = null) {
  const { reader, bridge } = parseEnrollmentJournals(local);
  const old = dominantEnrollmentFloor(reader?.floor ?? null, bridge?.authorityAnchors['8453'] ?? null);
  if (enrollmentFloor === null) return old;
  checkedFloor(enrollmentFloor);
  if (old && !dominates(enrollmentFloor, old)) throw Error('proposed recovery high-water is below a saved floor');
  return JSON.parse(canonicalJson(enrollmentFloor));
}
export function enrollmentManifest(local) {
  return Object.fromEntries(Object.keys(local).sort().map(k => [k, journalBytesDigest(local[k])]));
}
export const enrollmentManifestDigest = manifest => Object.keys(manifest).length ? journalBytesDigest(canonicalJson(manifest)) : null;
function checkedManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      Object.keys(manifest).some(k => ![READER_FILE, BRIDGE_FILE].includes(k) || !HEX.test(manifest[k])))
    throw Error('invalid original committed enrollment manifest');
  return manifest;
}
function bridgeBytes(floor) {
  return JSON.stringify({ version: 1, deployments: [], authorityAnchors: floor ? { '8453': floor } : {} });
}
function readerBytes(binding, floor, enrollment, phase) {
  const bytes = JSON.stringify({ format: 'enclave-derived-root-journal/v1', binding, floor, entries: [], enrollment: { ...enrollment, phase } });
  if (Buffer.byteLength(bytes) > 262144) throw Error('enrollment journal exceeds reader bounds');
  return bytes;
}
export function planEnrollment({ local, binding, verified, enrollmentFloor = null }) {
  if (verified?.format !== 'enclave-derived-enrollment-result/v1' || verified.binding !== binding ||
      !HEX.test(verified.digest || '') || !['genesis', 'rotate', 'recover'].includes(verified.mode))
    throw Error('provider did not verify this enrollment');
  checkedManifest(verified.priorFiles);
  if (canonicalJson(enrollmentManifest(local)) !== canonicalJson(verified.priorFiles))
    throw Error('local enrollment differs from committed scan; role must reconcile');
  const { reader, bridge } = parseEnrollmentJournals(local);
  const floor = proposedEnrollmentFloor(local, enrollmentFloor), floorDigest = derivedEnrollmentFloorDigest(floor);
  if (verified.floorDigest !== floorDigest) throw Error('provider did not verify this floor');
  if (verified.mode === 'genesis') {
    if (floor !== null || verified.highWater !== null || enrollmentFloor !== null) throw Error('provider did not verify a genesis floor');
    const metadata = { digest: verified.digest }, pendingBytes = readerBytes(binding, null, metadata, 'pending');
    const finalBytes = readerBytes(binding, null, metadata, 'committed'), anchorBytes = bridgeBytes(null);
    const r = local[READER_FILE], b = local[BRIDGE_FILE];
    const phase = r === undefined && b === undefined ? 0 : r === pendingBytes && b === undefined ? 1
      : r === pendingBytes && b === anchorBytes ? 2 : r === finalBytes && b === anchorBytes ? 3 : -1;
    if (phase < 0) throw Error('committed state is not this exact genesis prefix; no floor may be reset');
    return { pendingBytes, finalBytes, anchorBytes, phase, floorDigest };
  }
  if (!HEX.test(verified.previousBinding || '') || !HEX.test(verified.previousEnrollmentDigest || '') ||
      verified.previousEnrollmentDigest === verified.digest ||
      !(verified.stateDigest === null || HEX.test(verified.stateDigest))) throw Error('invalid authenticated previous enrollment');
  if (verified.mode === 'rotate') {
    if (enrollmentFloor !== null || verified.highWater !== null) throw Error('rotation cannot inject a recovery floor');
  } else {
    if (enrollmentFloor === null || verified.highWater === null ||
        canonicalJson(verified.highWater) !== canonicalJson(enrollmentFloor) ||
        derivedEnrollmentFloorDigest(verified.highWater) !== floorDigest) throw Error('recovery requires the signed retained high-water');
  }
  const isNew = reader?.binding === binding && reader.enrollment.digest === verified.digest;
  let original;
  if (isNew) {
    const e = reader.enrollment;
    original = JSON.parse(canonicalJson(checkedManifest(e.previousManifest)));
    if (e.mode !== verified.mode || e.previousBinding !== verified.previousBinding ||
        e.previousEnrollmentDigest !== verified.previousEnrollmentDigest || e.stateDigest !== verified.stateDigest ||
        e.floorDigest !== floorDigest || enrollmentManifestDigest(original) !== verified.stateDigest)
      throw Error('pending rebind does not match the authenticated prior state');
  } else {
    if (reader && (reader.binding !== verified.previousBinding || reader.enrollment.digest !== verified.previousEnrollmentDigest ||
        verified.mode === 'rotate' && reader.enrollment.phase !== 'committed')) throw Error('saved reader does not belong to the authenticated previous enrollment');
    if (verified.mode === 'rotate' && (!reader || !bridge)) throw Error('rotation requires both complete prior journals');
    original = enrollmentManifest(local);
    if (enrollmentManifestDigest(original) !== verified.stateDigest) throw Error('signed prior state manifest differs');
  }
  const metadata = { digest: verified.digest, mode: verified.mode, previousBinding: verified.previousBinding,
    previousEnrollmentDigest: verified.previousEnrollmentDigest, previousManifest: original,
    stateDigest: verified.stateDigest, floorDigest };
  const pendingBytes = readerBytes(binding, floor, metadata, 'pending'), finalBytes = readerBytes(binding, floor, metadata, 'committed');
  const anchorBytes = bridgeBytes(floor), r = local[READER_FILE], b = local[BRIDGE_FILE];
  const oldBridge = b === undefined ? original[BRIDGE_FILE] === undefined : journalBytesDigest(b) === original[BRIDGE_FILE];
  const phase = !isNew ? 0 : r === pendingBytes && b === anchorBytes ? 2
    : r === pendingBytes && oldBridge ? 1 : r === finalBytes && b === anchorBytes ? 3 : -1;
  if (phase < 0) throw Error('advanced or divergent rebind state; no floor may be reset');
  return { pendingBytes, finalBytes, anchorBytes, phase, floorDigest };
}
