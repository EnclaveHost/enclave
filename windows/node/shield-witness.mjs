// A host-owned readiness witness. Never entered into customer deployment records.
import {IsolationManagerClient} from './isolation-client.mjs';
import {viewTransport} from './hvcert.mjs';
import {readGuestAttestation} from '../../isolation/m4/guestd/supervisor-guestcert.mjs';
export const WITNESS_NAME = 'shield-readiness-v1';
export function createShieldWitness({config, base, dataAddr, client = new IsolationManagerClient({base}), read = readGuestAttestation, now = Date.now}) {
  if (!config || !/^[0-9a-f]{64}$/.test(config.appId || '') ||
      !/^[0-9a-f]{64}$/.test(config.derive?.runtimeId || '') ||
      config.derive?.derivation !== 'enclave-catalog-bundle/1' ||
      config.derive.policy?.vcpus !== 1 || config.derive.policy?.memMiB !== 256 ||
      config.derive.policy?.cpuPercent !== 100) throw Error('invalid pinned readiness witness');
  let pending, retryAt = 0;
  const body = {name:WITNESS_NAME, image:config.derive.cid, derive:config.derive,
    cpuShare:0, gpuShare:0, config:'', isPublic:true, hasSecrets:false};
  async function ensure() {
    if (pending) return pending;
    pending = (async () => {
      let v = await client.findByName(WITNESS_NAME);
      if (v && (v.appId !== config.appId || v.runtimeId !== config.derive.runtimeId))
        throw Error('witness identity mismatch; operator intervention required');
      if (v && (v.recovered === true || !['running','starting'].includes(v.status))) {
        if (now() < retryAt) throw Error('witness recovery cooling down');
        await client.remove(v.id); v = null;
      }
      if (!v) {
        if (now() < retryAt) throw Error('witness recovery cooling down');
        retryAt = now() + 60000;
        v = (await client.spawn(body)).view;
      }
      return v;
    })().finally(() => { pending = null; });
    return pending;
  }
  return {ensure, async evidence(nonce) {
    if (!/^[0-9a-f]{64}$/.test(nonce || '')) throw Error('32-byte nonce required');
    const v = await ensure();
    if (v.status !== 'running' || v.appId !== config.appId || v.runtimeId !== config.derive.runtimeId)
      throw Error('readiness witness is not running');
    return read({transport:viewTransport(client), dataAddr, instanceId:v.id,
      expectAppId:config.appId, name:'shield-readiness.invalid', nonce:Buffer.from(nonce,'hex')});
  }};
}
