// Registry prefix shared by host and provider reads. Appended fields are not needed.
export const hostABI=[{type:'function',name:'get',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'tuple',components:
  [['endpoint','string'],['repo','string'],['measurement','bytes32'],['operator','address'],['registeredAt','uint64'],['lastSeen','uint64'],['active','bool'],['cpuPricePerSec6','uint64'],['gpuPricePerSec6','uint64'],['proofKey','address'],['payoutWallet','address']].map(([name,type])=>({name,type}))}]}];
