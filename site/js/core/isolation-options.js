// Tenant hardware requirements are independent of the host's implementation.
export function isolationOptions(raw = '') {
  const text = String(raw).trim();
  const envelope = text ? JSON.parse(text) : {};
  if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') throw new Error('Deployment options must be a JSON object.');
  const iso = ("isolation" in envelope ? envelope.isolation : {});
  if (!iso || Array.isArray(iso) || typeof iso !== 'object') throw new Error('Invalid isolation options.');
  if (Object.keys(iso).some(k => !['require', 'cpuTee', 'gpuTee'].includes(k))) throw new Error('Unrecognized isolation options; cannot safely replace them.');
  for (const k of ['cpuTee', 'gpuTee']) if (iso[k] !== undefined && typeof iso[k] !== 'boolean') throw new Error(`isolation.${k} must be true or false.`);
  const required = iso.require ?? '';
  if (!['', 'snp-guest-per-app', 'hyperv-partition-per-app'].includes(required)) throw new Error('Unrecognized legacy isolation backend; cannot safely replace it.');
  return { envelope, required, cpuTee: iso.cpuTee === true || required === 'snp-guest-per-app', gpuTee: iso.gpuTee === true };
}
export function withIsolationRequirements(raw, { cpuTee, gpuTee }, cap = 4096) {
  if (typeof cpuTee !== 'boolean' || typeof gpuTee !== 'boolean') throw new Error('CPU and GPU requirements must be true or false.');
  const { envelope } = isolationOptions(raw);
  const next = { ...envelope };
  // An explicit portable envelope makes older runners refuse rather than silently ignore the choice.
  next.isolation = { cpuTee, gpuTee };
  const text = JSON.stringify(next);
  if (new TextEncoder().encode(text).length > cap) throw new Error(`Deployment options exceed this ledger’s ${cap}-byte limit.`);
  return text;
}
export function hostIsolationBackend(row) {
  return row?.availability?.apps?.isolation || row?.availability?.isolation || '';
}
export function hostMeetsTeeRequirements(row, { cpuTee, gpuTee }) {
  // Only the admitted SNP app backend currently supplies confidential CPUs.
  // Neither supported per-app backend currently offers a CC-mode GPU path.
  // Do not promote a masked GPU or a node's unverified marketing flag to a TEE.
  const backend = hostIsolationBackend(row);
  return ['snp-guest-per-app', 'hyperv-partition-per-app'].includes(backend)
    && (!cpuTee || backend === 'snp-guest-per-app') && !gpuTee;
}
// Can the hosts that could claim this deployment take a per-deployment config
// override? key: 'configOverride' (inline) or 'configCidOverride' (pinned).
// The relay's aggregate ANDs the flag over every serving box, and a per-app
// isolation host reports configOverride:false ON PURPOSE: it takes config only
// through the attested release, which delivers it into the guest. With the
// whole fleet on isolation tiers that one deliberate false locks every
// deployment's Config tab (queued ones included), so judge the candidates
// instead, the way the CLI does: the claim-enabled hosts the envelope admits,
// EVERY one of which must take the override. No candidate = false, and the
// caller keeps the aggregate's answer.
export function hostsTakeConfig(rows, raw = '', key = 'configOverride') {
  let iso;
  try { iso = isolationOptions(raw); } catch { return false; }
  const wantsIso = 'isolation' in iso.envelope;
  const hosts = (rows || []).filter(row => row?.availability?.claimEnabled === true && !row.relay)
    .filter(row => !wantsIso || (iso.required ? hostIsolationBackend(row) === iso.required : hostMeetsTeeRequirements(row, iso)));
  const takes = row => {
    const a = row.availability, viaRelease = !!hostIsolationBackend(row) && a.configOverride !== true;
    return key === 'configCidOverride' ? a.configCidOverride === true || viaRelease : a.configOverride === true || viaRelease;
  };
  return hosts.length > 0 && hosts.every(takes);
}
