// The PRODUCTION credit-vault source (contracts/EnclaveCreditVault.sol at d36100ae, which production-factory.json shows
// is byte-identical to the live factory and implementation), compiled with the deploy pipeline's exact settings, as
// the fixture the local tests deploy. Only the constructor arguments (a local origin) differ from production.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
const REPO = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const solc = createRequire(REPO + '/package.json')('solc');
const src = execFileSync('git', ['show', 'd36100ae:contracts/EnclaveCreditVault.sol'], { cwd: REPO, encoding: 'utf8' });
const settings = { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } };
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'EnclaveCreditVault.sol': { content: src } }, settings })));
const errs = (out.errors || []).filter((e) => e.severity === 'error'); if (errs.length) throw new Error(errs[0].formattedMessage);
const c = out.contracts['EnclaveCreditVault.sol'];
const art = { commit: 'd36100ae', sourceSha256: crypto.createHash('sha256').update(src).digest('hex'), compiler: solc.version(), settings: { optimizer: settings.optimizer, viaIR: false },
  factory: { abi: c.EnclaveCreditVaultFactory.abi, bytecode: '0x' + c.EnclaveCreditVaultFactory.evm.bytecode.object },
  vault: { abi: c.EnclaveCreditVault.abi } };
fs.writeFileSync(new URL('./fixtures/credit-vault-d36100ae.json', import.meta.url), JSON.stringify(art) + '\n');
console.log(art.commit, art.sourceSha256, art.compiler, 'factory initcode bytes', (art.factory.bytecode.length - 2) / 2);
