import test from 'node:test';
import assert from 'node:assert/strict';
import { isolationOptions, withIsolationBackend, hostIsolationBackend } from '../site/js/core/isolation-options.js';
const SNP = 'snp-guest-per-app', SHIELD = 'hyperv-partition-per-app';

test('backend edits preserve every other option, including off-chain config references', () => {
  const options = { isolation: { require: SNP, futurePolicy: 'keep' }, configCid: 'bafyexample',
    config: { volumes: ['model'] }, network: { relay: 'us-west' }, gpu: { optional: true }, waf: { rps: 10 } };
  const result = JSON.parse(withIsolationBackend(JSON.stringify(options), SHIELD));
  assert.deepEqual(result, { ...options, isolation: { ...options.isolation, require: SHIELD } });
  assert.equal(isolationOptions(JSON.stringify(result)).required, SHIELD);
});

test('unset deployments can explicitly require isolation; unknown requirements remain readable', () => {
  assert.equal(isolationOptions('').required, '');
  assert.deepEqual(JSON.parse(withIsolationBackend('', SNP)), { isolation: { require: SNP } });
  assert.equal(isolationOptions('{"isolation":{"require":"future-backend"}}').required, 'future-backend');
});

test('malformed options and unsupported choices never silently drop protection or configuration', () => {
  for (const raw of ['bafyrawcid', '[]', 'null', '{broken', '{"isolation":[]}', '{"isolation":{"require":42}}'])
    assert.throws(() => withIsolationBackend(raw, SHIELD));
  for (const backend of ['', 'any', '__proto__', null]) assert.throws(() => withIsolationBackend('', backend));
  assert.throws(() => withIsolationBackend('{"config":{"text":"😀😀😀"}}', SNP, 70), /byte limit/);
});

test('host matching uses advertised per-app backend with the existing top-level fallback', () => {
  assert.equal(hostIsolationBackend({ availability: { apps: { isolation: SHIELD }, isolation: SNP } }), SHIELD);
  assert.equal(hostIsolationBackend({ availability: { isolation: SNP } }), SNP);
  assert.equal(hostIsolationBackend({}), '');
});

// Exercise the actual dashboard save callback, with signing replaced by a capture.
const { readFileSync } = await import('node:fs');
const source = readFileSync(new URL('../site/components/deployments/deployments.js', import.meta.url), 'utf8');
const callback = source.match(/isoSave\.addEventListener\("click", async \(\) => \{([^]*?)\n    \}\);/)[1];
const saveHandler = new Function('depGet', 'isolationOptions', 'withIsolationBackend', 'isoSave', 'isoSel', 'go',
  'id', 'd', 'isolation', 'rev', 'box', 'btn', 'isoInfo', 'syncIsolation', 'paintLine', `return async function () {${callback}}`);

test('dashboard saves against fresh options and requires the existing owner and requirement to still match', async () => {
  for (const changed of ['config', 'owner', 'requirement']) {
    const fresh = { owner: changed === 'owner' ? 'bob' : 'alice',
      configCid: JSON.stringify({ isolation: { require: changed === 'requirement' ? SHIELD : SNP }, config: { freshlyEdited: true } }) };
    const saves = [], errors = [];
    const handle = saveHandler(async () => fresh, isolationOptions, withIsolationBackend,
      {}, { value: SHIELD }, {}, 'app', { owner: 'alice' }, { required: SNP }, 5, {}, {}, {}, () => {},
      (_node, _style, message) => errors.push(message));
    await handle.call({ _cfgSubmit: async (...args) => saves.push(args) });
    if (changed === 'config') {
      assert.equal(saves.length, 1);
      assert.deepEqual(JSON.parse(saves[0][3]), { isolation: { require: SHIELD }, config: { freshlyEdited: true } });
    } else {
      assert.equal(saves.length, 0);
      assert.ok(errors.some(s => /changed/.test(s)));
    }
  }
});
