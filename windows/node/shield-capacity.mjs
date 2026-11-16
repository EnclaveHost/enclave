// The host's capacity partition: a host-owned Shield partition, like the readiness witness and never entered into
// customer deployment records, whose front holds this box's proof key and answers capacity checks
// (network/proof-of-capacity-partition.mjs; isolation/m2/front/capacity.go). With it the proof key is made in the
// partition's memory at each start and every answer is the partition's work; without it (no SHIELD_CAPACITY_CONFIG)
// the proof key is this process's file and the box says so.
//
// The pinned config is the witness's shape: {appId, derive: {derivation, catalog, cid, runtimeId, policy}}. Its policy
// sizes the partition: a capacity check asks for as many lanes at once as this box advertises free vCPUs (16 at most),
// so a partition with fewer processors than that answers late.
import {IsolationManagerClient} from './isolation-client.mjs';
import {viewTransport} from './hvcert.mjs';
import {readGuestAttestation, guestRequest} from '../../isolation/m4/guestd/supervisor-guestcert.mjs';
import {createPartitionProofKey} from '../../network/proof-of-capacity-partition.mjs';

export const CAPACITY_NAME = 'host-capacity-v1', CAPACITY_SERVER_NAME = 'host-capacity.invalid';
export function createShieldCapacity({config, base, dataAddr, client = new IsolationManagerClient({base}), read = readGuestAttestation,
  request = guestRequest, now = Date.now}) {
  const p = config?.derive?.policy;
  if (!config || !/^[0-9a-f]{64}$/.test(config.appId || '') || !/^[0-9a-f]{64}$/.test(config.derive?.runtimeId || '') ||
      config.derive?.derivation !== 'enclave-catalog-bundle/1' || !Number.isSafeInteger(p?.vcpus) || p.vcpus < 1 || p.vcpus > 64 ||
      !Number.isSafeInteger(p?.memMiB) || p.memMiB < 256 || p.cpuPercent !== 100 * p.vcpus) throw Error('invalid pinned capacity partition');
  let pending, retryAt = 0;
  const body = {name: CAPACITY_NAME, image: config.derive.cid, derive: config.derive, cpuShare: 0, gpuShare: 0, config: '', isPublic: true, hasSecrets: false};
  const ours = v => v.appId === config.appId && v.runtimeId === config.derive.runtimeId;
  async function ensure() {
    if (pending) return pending;
    pending = (async () => {
      let v = await client.findByName(CAPACITY_NAME);
      // (as the witness: a manager restart leaves it RECOVERED, running and never serving again; ours by name and app,
      // it is replaced, and the new one has a new proof key)
      if (v && v.recovered === true && v.appId === config.appId) {
        if (now() < retryAt) throw Error('capacity partition recovery cooling down');
        await client.remove(v.id); v = null;
      }
      if (v && !ours(v)) throw Error('capacity partition identity mismatch; operator intervention required');
      if (v && !['running', 'starting'].includes(v.status)) {
        if (now() < retryAt) throw Error('capacity partition recovery cooling down');
        await client.remove(v.id); v = null;
      }
      if (!v) {
        if (now() < retryAt) throw Error('capacity partition recovery cooling down');
        retryAt = now() + 60000;
        v = (await client.spawn(body)).view;
      }
      return v;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function stop() {
    const v = await client.findByName(CAPACITY_NAME);
    if (!v) return false;
    await client.remove(v.id); retryAt = 0;
    return true;
  }
  const running = async () => { const v = await ensure(); if (v.status !== 'running' || !ours(v)) throw Error('the capacity partition is not running'); return v; };
  // one request to the partition's front, on the key the manager verified for this instance
  async function call(method, path, payload, {timeoutMs = 15000} = {}) {
    const v = await running();
    const r = await request({transport: viewTransport(client), dataAddr, instanceId: v.id, expectAppId: config.appId, name: CAPACITY_SERVER_NAME,
      method, path, body: payload ? JSON.stringify(payload) : null, timeoutMs});
    let parsed = null; try { parsed = JSON.parse(Buffer.from(r.body).toString('utf8')); } catch {}
    return {status: r.status, body: parsed, instance: v.id};
  }
  const key = createPartitionProofKey({call});
  return {ensure, stop, call, key,
    /** What a checker asks for (GET /v1/host/capacity-key?nonce=): the partition's attestation over its nonce, and the key statement. */
    async evidence(nonce) {
      if (!/^[0-9a-f]{64}$/.test(nonce || '')) throw Error('32-byte nonce required');
      const v = await running();
      const a = await read({transport: viewTransport(client), dataAddr, instanceId: v.id, expectAppId: config.appId, name: CAPACITY_SERVER_NAME, nonce: Buffer.from(nonce, 'hex')});
      const s = await key.statement();
      return {document: a.doc, handshakeSpki: a.handshakeSpki, key: {address: s.address, tlsSignature: s.tlsSignature}};
    }};
}
