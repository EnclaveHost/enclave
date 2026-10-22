// size.mjs FILE... : runtime bytes of every contract in each file (pinned soljson, live settings). Experiments only.
import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const C = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), REPO = path.resolve(C, '../enclave');
const {loadCompiler} = await import(path.join(REPO, 'scripts/network/verify-deployed-sources.mjs'));
const m = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/deployments/source-verification-base.json'), 'utf8'));
const solc = loadCompiler(m);
for (const f of process.argv.slice(2)) {
  const input = { language: 'Solidity', sources: { 'EnclaveDeployments.sol': { content: fs.readFileSync(f, 'utf8') } },
    settings: { ...m.builds['ledger-rev16d'].settings, outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const err = (out.errors || []).filter((e) => e.severity === 'error');
  if (err.length) { console.log(path.basename(f), 'ERROR', err[0].formattedMessage.slice(0, 300)); continue; }
  console.log(path.basename(f), Object.entries(out.contracts['EnclaveDeployments.sol']).map(([n, c]) => n + '=' + c.evm.deployedBytecode.object.length / 2).join(' '));
}
