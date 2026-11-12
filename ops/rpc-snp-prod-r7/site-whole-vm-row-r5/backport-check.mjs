// The backported r4 source behaves as main's test/dashboard-tls-status.test.mjs requires of main.
import assert from 'node:assert/strict'; import fs from 'node:fs';
const [,, file, releaseJson] = process.argv;
const src = fs.readFileSync(file, 'utf8');
const s = src.indexOf('export function appEndpoint('), e = src.indexOf('// appEndpoint can derive from server-supplied', s);
const withStore = byId => new Function('Enclave', 'APP_DOMAIN', 'STORE', 'parseCatalogRef',
  `${src.slice(s, e).replace(/export function/g, 'function')}; return { appEndpoint, isWholeVm, WHOLE_VM_NOTE };`)(
  { base: 'https://api.enclave.host/v1' }, 'app.enclave.host', { byId },
  ref => { const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/.exec(String(ref || '')); return m ? { appId: m[1], index: Number(m[2]) } : null; });
const app = '0x0f628585d36c4272ae23c55b4f9ec6d5805f25e26d4744474710e46e4edbb537';
const release = JSON.parse(fs.readFileSync(releaseJson, 'utf8'));
const versions = [{ config: '{"runtime":"wasm"}' }, { config: 'not json' }, { config: '' }, { config: JSON.stringify(release.config) }];
const { appEndpoint, isWholeVm, WHOLE_VM_NOTE } = withStore({ [app]: { versions } });
const rpc = { id: '0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f', status: 'running', public: true, image: { reference: `catalog://${app}/3` } };
assert.equal(isWholeVm(rpc.image.reference), true);
assert.equal(appEndpoint(rpc), '');
assert.equal(appEndpoint({ ...rpc, image: undefined, appRef: rpc.image.reference }), '');
for (const i of [0, 1, 2, 9]) assert.equal(appEndpoint({ ...rpc, image: { reference: `catalog://${app}/${i}` } }), 'https://5ff56a4d.app.enclave.host');
assert.equal(withStore({}).appEndpoint(rpc), 'https://5ff56a4d.app.enclave.host');
assert.match(WHOLE_VM_NOTE, /^<div class="enc-eprow"><span class="enc-epnote" style="[^"<>]+" title="[^"<>]+">[^<>]+<\/span><\/div>$/);
assert.match(src, /: isWholeVm\(\(d\.image && d\.image\.reference\) \|\| d\.appRef\) \? WHOLE_VM_NOTE : ''\)/);
console.log('backport ok');
