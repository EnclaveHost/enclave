// Independent-host admission: content integrity + the host owner's committed, OPTIONAL moderation. Intended location:
// network/lifecycle-independent-admission.mjs. Imported by lifecycle-host-authority.mjs and by the generated
// independent-profile chain adapter (tools/generate-lifecycle-adapter-candidate.mjs), so the dispatch and the adapter
// apply ONE rule. No environment flag. The legacy hostAdmissionRefusal (mandatory platform moderation) is imported
// nowhere here and is unchanged for every legacy path.
//
// r3 (root goal correction of r2): EnclaveAppCatalog.setActive / yankVersion are the publisher's MUTABLE listing
// preferences. They do not change the pinned version's content commitment, so on an independently owned host they are
// discovery metadata, not a global kill switch for content the deployment owner already selected. r2 treated them as
// mandatory "publisher consent", which kept an Enclave veto over every app Enclave published. They now apply on a host
// only when THAT host's owner elected catalog moderation (requireCatalogApproval: the production catalogAdmissionRefusal,
// which includes delisted/yanked/rejected). The deployment owner's own d.active/ownership stays authoritative in the
// chain adapter (global `enabled`); nothing here can raise it.
import { validateHostAdmissionPolicy } from './host-admission-policy.mjs';
import { catalogAdmissionRefusal } from '../site/js/core/catalog-policy.js';

const ID = /^0x[0-9a-f]{64}$/;
const REF = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/([0-9]{1,9})$/;

/** Production's exact appRef pattern and canonicalisation. Throws on anything else. */
export function canonicalAppRef(appRef) {
  const m = typeof appRef === 'string' && appRef.match(REF);
  if (!m) throw Error('catalog app reference required');
  const appId = m[1].toLowerCase(), index = Number(m[2]);
  return { appId, index, canonical: `catalog://${appId}/${index}` };
}

/** Content integrity only: the referenced version exists and carries a content commitment. -> refusal string or null */
export function catalogIntegrityRefusal({ app, version, appId, index }) {
  if (!app || String(app.appId).toLowerCase() !== appId || !(BigInt(app.versionCount ?? 0) > BigInt(index)))
    return 'the catalog has no such app version';
  if (!version || typeof version.cid !== 'string' || !version.cid.length || !(BigInt(version.createdAt ?? 0) > 0n))
    return 'the catalog version carries no content commitment';
  return null;
}

/** The publisher's listing preferences as METADATA (discovery, consoles). Never a refusal by itself on this path. */
export function publisherListing({ app, version }) {
  return Object.freeze({ delisted: app?.active !== true, yanked: version?.yanked !== false });
}

/**
 * The independent lifecycle path's admission for ONE host: the host owner's deny lists, content integrity, and catalog
 * moderation ONLY when the host owner elected it. A refusal here is scoped to this host (the adapter maps it to
 * hostAdmission/admitted, never to global `enabled`).
 */
export function independentAdmissionRefusal(policy, { hostId, deploymentId, appRef, app, version, forPrivate = false }) {
  const p = validateHostAdmissionPolicy(policy);
  if (p.hostId !== hostId) throw Error('host policy cannot apply to another host');
  if (typeof deploymentId !== 'string' || !ID.test(deploymentId)) throw Error('deployment id required');
  const ref = canonicalAppRef(appRef);
  if (p.denyDeployments.includes(deploymentId) || p.denyAppRefs.includes(ref.canonical)) return 'this host owner declines this deployment';
  const integrity = catalogIntegrityRefusal({ app, version, appId: ref.appId, index: ref.index });
  if (integrity) return integrity;
  if (p.requireCatalogApproval === true) {
    // The production catalog policy, elected by this host's owner: includes the publisher's delist/yank and rejection.
    const moderation = catalogAdmissionRefusal(app, version, { forPrivate: forPrivate === true });
    if (moderation) return `this host owner applies catalog moderation: ${moderation}`;
    if (Number(version.approval) !== 1) return 'this host owner requires current catalog approval';
  }
  return null;
}
