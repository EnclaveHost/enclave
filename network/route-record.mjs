// App-scoped route records. Transport keys cannot authorize themselves: a
// currently leased runner delegates a bounded key, and clients recheck the lease.
import {createHash, createPublicKey, sign, verify} from 'node:crypto';
import {recoverMessageAddress} from 'viem';
import net from 'node:net';
import {isBlockedHost} from '../relay/net-guard.mjs';
import {validateCircuitPolicy} from './circuit-policy.mjs';

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new Error('record must contain only bounded JSON values');
}
export const recordHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const message = (kind, value) => `enclave-network:${kind}:v2\n${canonical(value)}`;
const appPattern = /^0x[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
export async function signOwnerPolicy(account, policy) {
  validateCircuitPolicy(policy);
  return {policy, signature: await account.signMessage({message:message('policy',policy)})};
}
export async function verifyOwnerPolicy(envelope, owner) {
  validateCircuitPolicy(envelope?.policy);
  const recovered = await recoverMessageAddress({message:message('policy',envelope.policy), signature:envelope.signature});
  if (recovered.toLowerCase() !== owner.toLowerCase()) throw new Error('network policy requires deployment owner signature');
  return envelope.policy;
}
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
export async function verifyRoute(bundle, {deploymentId, policy, lease, memory, now = Date.now()}) {
  if (!bundle || Buffer.byteLength(JSON.stringify(bundle)) > 32768) throw new Error('route bundle too large');
  const {delegation:d, signature:delegationSignature} = bundle.authorization || {};
  const key = validateDelegation(d, now);
  const p = validateCircuitPolicy(policy), r = bundle.record;
  if (d.deploymentId !== deploymentId || p.deploymentId !== deploymentId || d.policyHash !== recordHash(p)) throw new Error('route policy or app mismatch');
  if (!lease || lease.id !== deploymentId || lease.chainId !== d.chainId || lease.deployments.toLowerCase() !== d.deployments.toLowerCase() ||
      lease.runner !== d.runner || lease.validUntil <= now || !lease.active || !lease.isPublic || lease.leaseUntil <= now) throw new Error('fresh matching lease required');
  const signer = await recoverMessageAddress({message:message('delegation',d), signature:delegationSignature});
  if (signer.toLowerCase() !== lease.runnerOperator.toLowerCase()) throw new Error('route delegation is not signed by current runner');
  if (!r || r.version !== 2 || r.deploymentId !== deploymentId || r.delegationHash !== recordHash(d) ||
      !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !Number.isSafeInteger(r.issuedAt) || r.issuedAt > now + 5000 ||
      !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= now || r.expiresAt > d.expiresAt ||
      r.expiresAt > lease.leaseUntil || r.expiresAt - r.issuedAt > 300000 || !Array.isArray(r.routes) || r.routes.length > 2) throw new Error('invalid or expired route record');
  const seen = new Set();
  for (const route of r.routes) {
    if (!route || typeof route.circuit !== 'string' || !/^[0-9a-f]{32}$/.test(route.circuit) || seen.has(route.circuit) ||
        !net.isIP(route.address) || isBlockedHost(route.address) || route.port !== 443 || route.transport !== 'tuna-guarded-tcp' ||
        (route.directPort!==undefined&&(!Number.isInteger(route.directPort)||route.directPort<1024||route.directPort>65535)) ||
        (route.fallback!==undefined&&route.fallback!==true) ||
        Object.keys(route).some(k => !['circuit','address','port','transport','directPort','fallback'].includes(k))) throw new Error('invalid public route');
    seen.add(route.circuit);
  }
  const sig = Buffer.from(bundle.signature || '', 'base64');
  if (sig.length !== 64 || !verify(null,Buffer.from(message('route',r)),key,sig)) throw new Error('invalid route signature');
  const hash = recordHash(r);
  await memory.update(deploymentId, previous => {
  if (previous && (d.epoch < previous.epoch || (d.epoch === previous.epoch && (d.publicKey !== previous.publicKey ||
      r.sequence < previous.sequence || (r.sequence === previous.sequence && hash !== previous.hash))))) throw new Error('route rollback or equivocation');
  // Persist BEFORE exposing a route, including withdrawal records with no routes.
  return {epoch:d.epoch, publicKey:d.publicKey, sequence:r.sequence, hash};
  });
  return {...r, expiresAt:Math.min(r.expiresAt,lease.validUntil), ipns:d.ipns};
}
