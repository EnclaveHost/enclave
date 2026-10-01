// Relay-side app expectation. Nothing supplied by the node chooses the app,
// runtime or firmware against which its report is checked.
import { randomBytes } from 'node:crypto';
import { CATALOG_REF_RE, derivationRecord, versionRefusal } from './measurement-predict.mjs';
import { derive } from './shield-derive.mjs';

export async function expectedShieldApp(row, { policy, readCatalog, readConfig, fetchVerified, allowPendingOwner = false }) {
  if (!row || row.isPublic !== true) throw new Error('only public apps are supported');
  const ref = CATALOG_REF_RE.exec(String(row.appRef || ''));
  if (!ref) throw new Error('catalog app reference required');
  const catalog = await readCatalog(ref[1].toLowerCase(), Number(ref[2]));
  const refusal = versionRefusal(catalog?.app, catalog?.version, allowPendingOwner === true);
  if (refusal) throw new Error(refusal);
  const version = catalog.version;
  if (!Number.isSafeInteger(version.memMb) || version.memMb < 0) throw new Error('invalid catalog memory');
  const envelope = row.configCid ? JSON.parse(row.configCid) : {};
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).some(k => !['isolation', 'network', 'gpu', 'config', 'configCid', 'waf'].includes(k)))
    throw new Error('unsupported deployment options');
  const iso = ("isolation" in envelope ? envelope.isolation : {});
  if (!iso || typeof iso !== 'object' || Array.isArray(iso) ||
      Object.keys(iso).some(k => !['require', 'cpuTee', 'gpuTee'].includes(k)) ||
      (iso.require !== undefined && iso.require !== 'hyperv-partition-per-app') ||
      ['cpuTee', 'gpuTee'].some(k => iso[k] !== undefined && iso[k] !== false))
    throw new Error('deployment hardware requirements do not permit Shield partition isolation');
  if (envelope.configCid || (envelope.waf && Object.keys(envelope.waf).length))
    throw new Error('configuration CID and protection rules are not supported');
  for (const [key, allowed] of [['network', ['relay']], ['gpu', ['optional']], ['waf', []]]) {
    if (!(key in envelope)) continue;
    const value = envelope[key];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
      throw new Error(`unsupported ${key} options`);
  }
  const relay = envelope.network?.relay;
  if (relay != null && relay !== '' && (typeof relay !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(relay)))
    throw new Error('invalid relay selection');
  if (envelope.gpu?.optional !== undefined && typeof envelope.gpu.optional !== 'boolean')
    throw new Error('invalid optional GPU flag');
  const gpu = Number(row.gpuMilli), cpu = Number(row.cpuMilli);
  if (!Number.isInteger(gpu) || gpu < 0 || gpu > 1000 || !Number.isInteger(cpu) || cpu < 1 || cpu > 1000)
    throw new Error('invalid resource shares');
  const profile = gpu > 0 ? policy?.gpu : policy?.cpu;
  if (!profile?.runtimeId) throw new Error('no admitted runtime for this workload');
  const c = await readConfig(ref[1].toLowerCase(), Number(ref[2]));
  if (!c || c.configCid) throw new Error('catalog configuration must be available inline');
  let config = envelope.config !== undefined ? envelope.config : c.config || {};
  if (typeof config === 'string') config = JSON.parse(config || '{}');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('configuration is not an object');
  const { _media, ...appConfig } = config;
  const record = derivationRecord(row.appRef, version, profile.runtimeId);
  if (gpu) {
    if (profile.model !== 'qwen2.5-0.5b-q8-gguf' || gpu < 500 || cpu < 250 || version.memMb < 8192 || record.http)
      throw new Error('workload is outside the measured Shield inference profile');
    if (Object.keys(appConfig).length !== 1 || !Array.isArray(appConfig.volumes) ||
        appConfig.volumes.length !== 1 || appConfig.volumes[0] !== profile.model)
      throw new Error('inference requires exactly the admitted model volume');
    record.derivation = 'enclave-catalog-bundle/4';
    record.policy = { cpuPercent: 400, vcpus: 4, memMiB: version.memMb };
    record.inference = { model: profile.model, gpuMilli: gpu };
  } else if (Object.keys(appConfig).length) throw new Error('app configuration is not supported by this runtime');
  const component = await fetchVerified(version.cid, 256 << 20);
  if (!component?.ok || !Buffer.isBuffer(component.bytes)) throw new Error('catalog component could not be CID-verified');
  return { appSha256: derive({ record, component: component.bytes }).appId, runtimeId: profile.runtimeId };
}

export function createShieldAppVerifier({ hub, policy, readCatalog, readConfig, fetchVerified }) {
  let active = 0;
  return async function verifyApp(name, row, { csrSpkiSha256, allowPendingOwner = false } = {}) {
    if (active >= 2) return { ok: false, reason: 'Shield verification busy; retry shortly' };
    active++;
    try {
      if (!/^0x[0-9a-f]{64}$/.test(String(row?.id || ''))) throw new Error('exact deployment id required');
      const expected = await expectedShieldApp(row, { policy, readCatalog, readConfig, fetchVerified, allowPendingOwner });
      const nonce = randomBytes(32);
      const proof = await hub.fetchJson(`tunnel://${name}`,
        `/v1/shield/evidence?deployment=${row.id}&nonce=${nonce.toString('hex')}`);
      if (!proof || typeof proof.handshakeSpki !== 'string' || proof.handshakeSpki.length > 5500)
        throw new Error('no bounded app proof from the live node');
      return hub.verifyShieldApp(name, { doc: proof.doc, handshakeSpki: Buffer.from(proof.handshakeSpki, 'base64'),
        nonce, expectedAppSha256: expected.appSha256, expectedRuntimeId: expected.runtimeId,
        ...(csrSpkiSha256 !== undefined ? { expectedCsrSpkiSha256: csrSpkiSha256 } : {}) }, policy);
    } catch (e) { return { ok: false, reason: e.message }; }
    finally { active--; }
  };
}
