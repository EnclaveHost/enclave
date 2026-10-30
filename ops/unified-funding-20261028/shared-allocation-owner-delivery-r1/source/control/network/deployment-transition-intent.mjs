import { getAddress } from 'viem';
const TYPES = { Transition: [
  { name: 'id', type: 'bytes32' }, { name: 'generation', type: 'uint64' }, { name: 'revision', type: 'uint64' },
  { name: 'target', type: 'uint8' }, { name: 'host', type: 'bytes32' }, { name: 'deadline', type: 'uint64' },
  { name: 'healthySince', type: 'uint64' }, { name: 'payee', type: 'address' }, { name: 'maxChargeWei', type: 'uint256' },
] };
export function transitionTypedData(pins, x) {
  if (!Number.isSafeInteger(pins.chainId) || pins.chainId <= 0 || !/^0x[0-9a-f]{64}$/.test(x?.id || '') ||
      !/^0x[0-9a-f]{64}$/.test(x?.host || '')) throw Error('invalid transition domain or id');
  for (const name of ['generation', 'revision', 'target', 'deadline', 'healthySince'])
    if (!Number.isSafeInteger(x[name]) || x[name] < 0) throw Error(`invalid transition ${name}`);
  if (![1, 2, 3].includes(x.target) || !/^[1-9][0-9]{0,77}$/.test(String(x.maxChargeWei))) throw Error('invalid transition target or charge');
  const maxChargeWei = BigInt(x.maxChargeWei); if (maxChargeWei >= 2n ** 256n) throw Error('transition charge overflow');
  const message = Object.fromEntries(TYPES.Transition.map(f => [f.name, x[f.name]]));
  message.maxChargeWei = maxChargeWei; message.payee = getAddress(x.payee);
  return { domain: { name: 'EnclaveDeploymentLifecycle', version: '1', chainId: pins.chainId,
    verifyingContract: getAddress(pins.lifecycle) }, types: TYPES, primaryType: 'Transition', message };
}
