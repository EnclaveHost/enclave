// The contract fragments the owner's signing page reads and encodes.
export const CATALOG_ABI = [
  { type: 'function', name: 'publishVersion', stateMutability: 'nonpayable', inputs: [
    { name: 'slug', type: 'string' }, { name: 'name', type: 'string' }, { name: 'description', type: 'string' },
    { name: 'version', type: 'string' }, { name: 'cid', type: 'string' }, { name: 'res', type: 'uint32[4]' },
    { name: 'ports', type: 'string' }, { name: 'config', type: 'string' }, { name: 'feePerSec6', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }, { type: 'uint256' }] },
  { type: 'function', name: 'numVersions', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getVersion', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'uint256' }], outputs: [{ type: 'tuple', components: [
    { name: 'cid', type: 'string' }, { name: 'version', type: 'string' }, { name: 'vramMb', type: 'uint32' }, { name: 'gpuGflops', type: 'uint32' },
    { name: 'memMb', type: 'uint32' }, { name: 'cpuGflops', type: 'uint32' }, { name: 'createdAt', type: 'uint64' }, { name: 'verified', type: 'bool' },
    { name: 'yanked', type: 'bool' }, { name: 'ports', type: 'string' }, { name: 'approval', type: 'uint8' }, { name: 'config', type: 'string' }] }] },
  { type: 'function', name: 'setApproval', stateMutability: 'nonpayable', inputs: [{ name: 'appId', type: 'bytes32' }, { name: 'index', type: 'uint256' }, { name: 'status', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'getApp', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'appId', type: 'bytes32' }, { name: 'publisher', type: 'address' }, { name: 'slug', type: 'string' }, { name: 'name', type: 'string' },
    { name: 'description', type: 'string' }, { name: 'versionCount', type: 'uint32' }, { name: 'createdAt', type: 'uint64' }, { name: 'updatedAt', type: 'uint64' },
    { name: 'active', type: 'bool' }] }] },
];
export const LEDGER_ABI = [
  { type: 'function', name: 'setAppRef', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'appRef', type: 'string' }], outputs: [] },
  { type: 'function', name: 'setConfig', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'configCid', type: 'string' }], outputs: [] },
  { type: 'function', name: 'setActive', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'active', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'multicall', stateMutability: 'nonpayable', inputs: [{ name: 'calls', type: 'bytes[]' }], outputs: [{ type: 'bytes[]' }] },
  { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'id', type: 'bytes32' }, { name: 'owner', type: 'address' }, { name: 'appRef', type: 'string' }, { name: 'ports', type: 'string' },
    { name: 'configCid', type: 'string' }, { name: 'gpuMilli', type: 'uint16' }, { name: 'cpuMilli', type: 'uint16' }, { name: 'appPort', type: 'uint32' },
    { name: 'isPublic', type: 'bool' }, { name: 'active', type: 'bool' }, { name: 'createdAt', type: 'uint64' }, { name: 'rate', type: 'uint256' },
    { name: 'balance6', type: 'uint256' }, { name: 'spent6', type: 'uint256' }, { name: 'runner', type: 'bytes32' },
    { name: 'runnerOperator', type: 'address' }, { name: 'leaseUntil', type: 'uint64' }] }] },
];
// The owner's session vault (SessionVault.sol): what it holds, and the two calls only its owner can make directly.
export const VAULT_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'held', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ name: 'env', type: 'uint8' }, { name: 'promoted', type: 'bytes32' }, { name: 'createdBy', type: 'bytes32' }] },
  { type: 'function', name: 'ownerCall', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'promote', stateMutability: 'nonpayable', inputs: [
    { name: 'id', type: 'bytes32' }, { name: 'app', type: 'string' }, { name: 'publisher', type: 'address' }, { name: 'appRef', type: 'string' },
    { name: 'configCid', type: 'string' }, { name: 'versionLabel', type: 'string' }, { name: 'isPublic', type: 'bool' }, { name: 'opNonce', type: 'bytes32' },
    { name: 'signBefore', type: 'uint64' }, { name: 'sig', type: 'bytes' }], outputs: [] },
];
