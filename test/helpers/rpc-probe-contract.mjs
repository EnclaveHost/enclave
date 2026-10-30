// The probe contract the public-rpc tests deploy on the reth dev chain: a stored value, an event (history) and a function
// that always reverts with a reason (revert semantics). Compiled by the locked solc-js (0.8.35) in a short-lived child, so
// the compiler's WebAssembly memory never counts against the test process.
import { execFileSync } from 'node:child_process';
export const PROBE_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;
contract RpcProbe {
  uint256 public value = 42;
  event Poked(address indexed who, uint256 n);
  function poke(uint256 n) external { value = n; emit Poked(msg.sender, n); }
  function fail() external pure { revert("probe: refused"); }
}`;
export function compileProbe() {
  const js = `const solc=require('solc');const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'RpcProbe.sol':{content:${JSON.stringify(PROBE_SOURCE)}}},
    settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
    if((out.errors||[]).some(e=>e.severity==='error'))throw new Error(JSON.stringify(out.errors));const c=out.contracts['RpcProbe.sol'].RpcProbe;
    process.stdout.write(JSON.stringify({abi:c.abi,bytecode:'0x'+c.evm.bytecode.object}));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', js], { cwd: new URL('../..', import.meta.url), maxBuffer: 16 << 20, timeout: 120000 }).toString());
}
