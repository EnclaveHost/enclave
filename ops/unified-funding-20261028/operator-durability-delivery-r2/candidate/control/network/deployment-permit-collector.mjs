import { recoverTypedDataAddress, getAddress, hashTypedData } from 'viem';
import { signServingPermit, servingPermitTypedData } from './deployment-serving-permit.mjs';
import { prepareGenerationProposal, verifyGenerationChain } from './deployment-generation-certificate.mjs';
import { transitionTypedData } from './deployment-transition-intent.mjs';

function witnessTransport({ endpoints, fetchImpl = fetch, allowLoopbackHttp = false, timeoutMs = 5000 }, route) {
  if (!Array.isArray(endpoints) || endpoints.length < 3 || endpoints.length > 16 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw Error('invalid witness transport configuration');
  const peers = endpoints.map(peer => {
    const url = new URL(peer.url), address = getAddress(peer.address);
    if (url.username || url.password || url.hash || url.search ||
        (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))))
      throw Error('witness endpoint requires HTTPS or explicit local fixture HTTP');
    return { address, url: new URL(route, url).href };
  });
  if (new Set(peers.map(p => p.address)).size !== peers.length || new Set(peers.map(p => p.url)).size !== peers.length)
    throw Error('duplicate witness transport identity');
  return async (payload, policy, verifyReply) => {
    const configured = new Set(policy.witnesses.map(a => getAddress(a)));
    if (configured.size !== policy.witnesses.length || configured.size < 3 || configured.size > 16 ||
        !Number.isInteger(policy.threshold) || policy.threshold * 3 <= configured.size * 2 || policy.threshold > configured.size)
      throw Error('invalid transport witness policy');
    const selected = peers.filter(p => configured.has(p.address));
    if (selected.length < policy.threshold) throw Error('configured witness endpoints cannot form a quorum');
    const body = JSON.stringify(payload, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    if (Buffer.byteLength(body) > 65536) throw Error('witness request exceeds transport bound');
    const responses = await Promise.allSettled(selected.map(async peer => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(peer.url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body, signal: controller.signal });
        if (!res.ok) throw Error('witness refused');
        const chunks = []; let size = 0;
        for await (const c of res.body) { size += c.length; if (size > 2048) { controller.abort(); throw Error('oversized witness response'); } chunks.push(c); }
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await verifyReply(peer.address, reply);
        return { ...reply, signer: peer.address };
      } finally { clearTimeout(timer); }
    }));
    const votes = responses.filter(r => r.status === 'fulfilled').map(r => r.value)
      .sort((a, b) => a.signer.toLowerCase().localeCompare(b.signer.toLowerCase()));
    if (votes.length < policy.threshold) throw Error('witness quorum unavailable');
    return votes;
  };
}
async function signedAs(address, data, signature) {
  if (getAddress(await recoverTypedDataAddress({ ...data, signature })) !== address)
    throw Error('witness endpoint signed as another identity');
}
export function createPermitCollector(options) {
  const { pins, account } = options;
  const collect = witnessTransport(options, '/lifecycle/permit');
  return async (record, policy) => {
    const data = servingPermitTypedData(pins, record);
    const operatorSignature = await signServingPermit(account, pins, record);
    const votes = await collect({ record, operatorSignature }, policy,
      (address, reply) => signedAs(address, data, reply.signature));
    return { record, signatures: votes.map(v => v.signature) };
  };
}
// Caller persists the exact proposal/outbox BEFORE collection. Retries must
// reuse it: witnesses durably reject a different successor for that parent.
export function createGenerationCollector(options) {
  const { pins, now = Date.now } = options;
  const collect = witnessTransport(options, '/lifecycle/generation');
  return async (proposal, context) => {
    const { record, predecessors, intent, actorSignature } = proposal;
    const data = transitionTypedData(pins, intent);
    if (hashTypedData(data) !== record.transitionIntent) throw Error('generation transition digest mismatch');
    const checked = await prepareGenerationProposal(record, predecessors, { ...context, pins, nowSec: Math.floor(now() / 1000) });
    const votes = await collect({ record, predecessors, intent, actorSignature }, context.policy, async (address, reply) => {
      await signedAs(address, checked.typedData, reply.signature);
      await signedAs(address, data, reply.transitionSignature);
    });
    const certificate = { record, signatures: votes.map(v => v.signature) };
    await verifyGenerationChain([...predecessors, certificate], { ...context, pins, nowSec: Math.floor(now() / 1000) });
    return { certificate, intent, actorSignature, approvals: votes.map(v => v.transitionSignature) };
  };
}
