// network/privacy-agent.mjs: a host runs the Enclave network only. A configuration without enclaveNetwork (a TUNA-era
// host) is refused before anything starts, with a message that says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runPrivacy,PrivacyAgent,NETWORK_REQUIRED,RETIRED_SETTINGS} from '../network/privacy-agent.mjs';

test('a configuration without enclaveNetwork is refused: TUNA is retired', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-config-')); t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'privacy-config.json');
  const tuna = {version: 2, directory: dir, operatorKeyFile: path.join(dir, 'missing.key'), runner: '0x' + '22'.repeat(32), nknRpc: ['http://seed.nkn.org:30003'],
    inventory: {binary: 'enclave-provider-inventory'}, runtime: {binary: 'enclave-tuna'}, defaults: {budgetNkn: '1.5'},
    apps: [{deploymentId: '0x' + '11'.repeat(32), names: ['11111111.app.enclave.host'], expectedFile: path.join(dir, 'expected.json'), walletsFile: path.join(dir, 'wallets.json')}]};
  await fs.writeFile(file, JSON.stringify(tuna));
  await assert.rejects(runPrivacy(file), e => e.message === NETWORK_REQUIRED && /TUNA is retired/.test(e.message));
  await fs.writeFile(file, JSON.stringify({...tuna, enclaveNetwork: 'yes'}));
  await assert.rejects(runPrivacy(file), e => e.message === NETWORK_REQUIRED);
  assert.throws(() => new PrivacyAgent({apps: [], runner: tuna.runner, directory: dir, dns: [{}]}), e => e.message === NETWORK_REQUIRED);
  for (const k of ['nknRpc', 'inventory', 'control', 'runtime', 'defaults', 'tunaUSDC', 'currencyManagement']) assert.ok(RETIRED_SETTINGS.includes(k), k);
});
