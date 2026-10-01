// The isolation requirement belongs to the deployment options, not ENCLAVE_CONFIG.
// Never recover malformed input by replacing it: it may contain routing or secrets references.
export const ISOLATION_BACKENDS = [
  { value: 'snp-guest-per-app', label: 'Confidential VM per app (AMD SEV-SNP)' },
  { value: 'hyperv-partition-per-app', label: 'Enclave Shield partition per app' },
];
export function isolationOptions(raw = '') {
  const text = String(raw).trim();
  const envelope = text ? JSON.parse(text) : {};
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object')
    throw new Error('The deployment options are not a JSON object. Nothing was changed.');
  const isolation = envelope.isolation;
  if (isolation !== undefined && (!isolation || Array.isArray(isolation) || typeof isolation !== 'object'))
    throw new Error('The existing isolation options are invalid. Nothing was changed.');
  const required = isolation?.require ?? '';
  if (typeof required !== 'string') throw new Error('The existing isolation requirement is invalid.');
  return { envelope, required };
}
export function withIsolationBackend(raw, backend, cap = 4096) {
  if (!ISOLATION_BACKENDS.some(b => b.value === backend)) throw new Error('Select a supported isolation backend.');
  const { envelope } = isolationOptions(raw);
  const next = JSON.stringify({ ...envelope, isolation: { ...envelope.isolation, require: backend } });
  if (new TextEncoder().encode(next).length > cap) throw new Error(`The deployment options exceed this ledger’s ${cap}-byte limit.`);
  return next;
}
export function hostIsolationBackend(row) {
  return row?.availability?.apps?.isolation || row?.availability?.isolation || '';
}
