// Probe (diagnostic, not a deliverable test): does the shared gate re-admit after an operator ban is lifted?
import { test } from 'node:test';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { platformPolicyWorld } from '../helpers/platform-policy-world.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('probe', { timeout: 200_000 }, async (t) => {
  const op = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const endpoint = 'https://storage-host-a.example', id = keccak256(toBytes(endpoint)).toLowerCase();
  const w = await platformPolicyWorld(t, { hosts: { [id]: { endpoint, operator: op, owner: op, active: true } } });
  await w.publish({ deny: [] });
  const code = `import { createHostServiceGate } from ${JSON.stringify(path.join(ROOT, 'network/host-service-gate.mjs'))};
    const gate = createHostServiceGate({ env: process.env, chainId: 8453, endpoint: ${JSON.stringify(endpoint)}, log: (m) => console.log('LOG', m) });
    for (let i = 0; i < 70; i++) { await gate.check().catch((e) => console.log('ERR', e.message)); console.log(i, JSON.stringify(gate.serviceRefusal())); await new Promise((r) => setTimeout(r, 1000)); }`;
  const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, ...w.env() }, stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((r) => setTimeout(r, 8000));
  console.log('PARENT: ban', await w.publish({ deny: [{ kind: 'operator', value: op, reason: 'abuse' }] }));
  await new Promise((r) => setTimeout(r, 15000));
  console.log('PARENT: unban', await w.publish({ deny: [] }));
  await new Promise((r) => c.on('exit', r));
});
