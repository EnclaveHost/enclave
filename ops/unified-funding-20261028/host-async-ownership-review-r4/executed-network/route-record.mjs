// App-scoped route records. Transport keys cannot authorize themselves: a
// currently leased runner delegates a bounded key, and clients recheck the lease.
import {createHash, createPublicKey, sign, verify} from 'node:crypto';
import {canonical} from './canonical.mjs';
export {canonical};
import {recoverMessageAddress} from 'viem';
import net from 'node:net';
import {isBlockedHost} from '../relay/net-guard.mjs';
import {verifyQualification} from './provider-qualification.mjs';
import {validateNetworkPolicy} from './network-policy.mjs';

export const recordHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const message = (kind, value) => `enclave-network:${kind}:v2\n${canonical(value)}`;
const appPattern = /^0x[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
function validateDelegation(d, now) {
  if (!d || d.version !== 2 || !appPattern.test(d.deploymentId || '') || !appPattern.test(d.runner || '') ||
      !Number.isSafeInteger(d.chainId) || d.chainId <= 0 || !addressPattern.test(d.deployments || '') ||
      !/^[0-9a-f]{64}$/.test(d.policyHash || '') || !Number.isSafeInteger(d.epoch) || d.epoch < 1 || d.epoch !== d.notBefore ||
      !Number.isSafeInteger(d.notBefore) || !Number.isSafeInteger(d.expiresAt) || d.notBefore > now ||
      d.expiresAt <= now || d.expiresAt - d.notBefore > 86400000 || typeof d.publicKey !== 'string' ||
      d.publicKey.length !== 60 || typeof d.ipns !== 'string' || !/^k51[a-z0-9]{40,100}$/.test(d.ipns)) throw new Error('invalid route delegation');
  const key = createPublicKey({key:Buffer.from(d.publicKey,'base64'), format:'der', type:'spki'});
  if (key.asymmetricKeyType !== 'ed25519' || key.export({format:'der',type:'spki'}).toString('base64') !== d.publicKey) throw new Error('route key must be canonical Ed25519');
  return key;
}
export async function signDelegation(account, delegation, now = Date.now()) {
  validateDelegation(delegation, now);
  return {delegation, signature:await account.signMessage({message:message('delegation',delegation)})};
}
export function signRoute(privateKey, record) {
  return {record, signature:sign(null, Buffer.from(message('route',record)),privateKey).toString('base64')};
}
// A route policy is the owner's v5 Enclave-network policy (docs/design/enclave-network.md). The TUNA-era policies
// (v2 guarded TUNA, v3 on-chain direct, v4 USDC TUNA) are retired and refused.
export function validateRoutePolicy(p) {
  if (p?.version !== 5) throw new Error(`route policy version ${p?.version} is retired: only Enclave-network (v5) policies carry routes`);
  return validateNetworkPolicy(p);
}
// hostAdmission (optional): async (lease) -> { admit, reason } - the platform host policy decision for the lease's runner,
// judged at the lease reader's agreed block (network/host-policy-adapters.mjs leaseHostAdmission). Absent = unchanged.
export async function verifyRoute(bundle, {deploymentId, policy, lease, memory, providerProbeSigners, networkProviders, hostAdmission = null, now = Date.now()}) {
  if (!bundle || Buffer.byteLength(JSON.stringify(bundle)) > 32768) throw new Error('route bundle too large');
  const {delegation:d, signature:delegationSignature} = bundle.authorization || {};
  const key = validateDelegation(d, now);
  const p = validateRoutePolicy(policy), r = bundle.record;
  const maxRoutes = p.mode === 'direct' ? 1 : (p.enclaveNetwork?.routes || 0);
  if (d.deploymentId !== deploymentId || p.deploymentId !== deploymentId || d.policyHash !== recordHash(p)) throw new Error('route policy or app mismatch');
  if (!lease || lease.id !== deploymentId || lease.chainId !== d.chainId || lease.deployments.toLowerCase() !== d.deployments.toLowerCase() ||
      lease.runner !== d.runner || lease.validUntil <= now || !lease.active || !lease.isPublic || lease.leaseUntil <= now) throw new Error('fresh matching lease required');
  if (hostAdmission) {
    const a = await hostAdmission(lease);
    if (!a || a.admit !== true) throw new Error(`route host refused by platform host policy: ${a?.reason || 'no decision'}`);
  }
  const signer = await recoverMessageAddress({message:message('delegation',d), signature:delegationSignature});
  if (signer.toLowerCase() !== lease.runnerOperator.toLowerCase()) throw new Error('route delegation is not signed by current runner');
  if (!r || r.version !== 2 || r.deploymentId !== deploymentId || r.delegationHash !== recordHash(d) ||
      !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !Number.isSafeInteger(r.issuedAt) || r.issuedAt > now + 5000 ||
      !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= now || r.expiresAt > d.expiresAt ||
      r.expiresAt > lease.leaseUntil || r.expiresAt - r.issuedAt > 300000 || !Array.isArray(r.routes) || r.routes.length > maxRoutes) throw new Error('invalid or expired route record');
  // authenticate the whole signed record before any per-route decision (a served subset is never itself signed)
  const sig = Buffer.from(bundle.signature || '', 'base64');
  if (sig.length !== 64 || !verify(null,Buffer.from(message('route',r)),key,sig)) throw new Error('invalid route signature');
  const seen = new Set(), served = [];
  for (const route of r.routes) {
    if (!route || typeof route.circuit !== 'string' || !/^[0-9a-f]{32}$/.test(route.circuit) || seen.has(route.circuit) ||
        !net.isIP(route.address) || isBlockedHost(route.address) || route.port !== 443 || route.transport !== (p.mode==='direct'?'direct':'enclave-network') ||
        Object.keys(route).some(k => !['circuit','address','port','transport'].includes(k))) throw new Error('invalid public route');
    seen.add(route.circuit);
    if(p.mode==='direct'){
      // The host's own public address, qualified for direct hosting by a trusted checker for THIS runner and operator.
      const q=await verifyQualification(r.qualification,{hostId:lease.runner,operator:lease.runnerOperator,address:route.address,probeSigners:providerProbeSigners,now});
      if(r.expiresAt>q.expiresAt)throw new Error('route outlives the host\'s direct-hosting qualification');
      served.push(route);
      continue;
    }
    // Public ingress only through a provider that is qualified for ingress right now, under this policy's price limit.
    // A route through a provider that is not (its qualification lapsed or was revoked) is withheld; the record's other,
    // still-qualified routes are served. One provider's lapse must not withdraw every app routed through it AND another
    // provider (2026-10-21 16:01:51Z: a payload timeout on one provider dropped every app from every directory and DNS).
    const exit=(networkProviders||[]).find(x=>x.address===route.address&&x.eligibleRoles.includes('ingress')&&x.qualifiedUntil>=Math.min(r.expiresAt,now+60000)&&x.pricePerGiB6<=(p.enclaveNetwork?.maxPricePerGiB6??0));
    if(exit)served.push(route);
  }
  if(r.routes.length&&!served.length)throw new Error('route address is not a qualified Enclave-network ingress provider');
  const hash = recordHash(r);
  await memory.update(deploymentId, previous => {
  if (previous && (d.epoch < previous.epoch || (d.epoch === previous.epoch && (d.publicKey !== previous.publicKey ||
      r.sequence < previous.sequence || (r.sequence === previous.sequence && hash !== previous.hash))))) throw new Error('route rollback or equivocation');
  // Persist BEFORE exposing a route, including withdrawal records with no routes.
  return {epoch:d.epoch, publicKey:d.publicKey, sequence:r.sequence, hash};
  });
  // the signed record is the whole of r (signature, hash and replay floor above); only the qualified routes are exposed
  return {...r, routes:served, expiresAt:Math.min(r.expiresAt,lease.validUntil), ipns:d.ipns};
}
