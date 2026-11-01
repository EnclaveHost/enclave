// Only the labelled catalog/token/oracle/closure TEST doubles are compiled.
// The actual schema3 and registry contracts use their reviewed pinned artifacts.
import fs from 'node:fs';
import solc from 'solc';
const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',
 sources:{'D.sol':{content:fs.readFileSync(new URL('./LifecycleR5Doubles.sol',import.meta.url),'utf8')}},
 settings:{evmVersion:'prague',outputSelection:{'*':{'*':['abi','evm.bytecode']}}}})));
if(output.errors?.some(e=>e.severity==='error'))throw Error(JSON.stringify(output.errors));
process.stdout.write(JSON.stringify(output.contracts['D.sol']));
