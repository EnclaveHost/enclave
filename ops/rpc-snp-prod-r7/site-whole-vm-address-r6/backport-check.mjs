// The backported r5 source behaves as main's test/dashboard-tls-status.test.mjs requires of main:
// node backport-check.mjs DEPLOYMENTS_JS RELEASE_R12_JSON RELEASE_R13_JSON
import assert from 'node:assert/strict'; import fs from 'node:fs';
const [,, file, r12Json, r13Json] = process.argv;
const src = fs.readFileSync(file, 'utf8');
const s = src.indexOf('export function appEndpoint('), e = src.indexOf('// appEndpoint can derive from server-supplied', s);
const withStore = byId => new Function('Enclave', 'APP_DOMAIN', 'STORE', 'parseCatalogRef',
  `${src.slice(s, e).replace(/export function/g, 'function')}; return { appEndpoint, isWholeVm, wholeVmWithoutAddress, WHOLE_VM_NOTE };`)(
  { base: 'https://api.enclave.host/v1' }, 'app.enclave.host', { byId },
  ref => { const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/.exec(String(ref || '')); return m ? { appId: m[1], index: Number(m[2]) } : null; });
const app = '0x0f628585d36c4272ae23c55b4f9ec6d5805f25e26d4744474710e46e4edbb537';
const r12 = JSON.parse(fs.readFileSync(r12Json, 'utf8')).config, r13 = JSON.parse(fs.readFileSync(r13Json, 'utf8')).config;
assert.equal(r12.endpoints.web, undefined); assert.equal(r13.endpoints.web, '/');
const versions = [{ config: '{"runtime":"wasm"}' }, { config: 'not json' }, { config: '' }, { config: JSON.stringify(r12) }, { config: JSON.stringify(r13) },
  { config: JSON.stringify({ ...r13, endpoints: { ...r13.endpoints, web: 'https://elsewhere.example/' } }) }];
const { appEndpoint, isWholeVm, wholeVmWithoutAddress, WHOLE_VM_NOTE } = withStore({ [app]: { versions } });
const rpc = i => ({ id: '0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f', status: 'running', public: true, image: { reference: `catalog://${app}/${i}` } });
const address = 'https://5ff56a4d.app.enclave.host';
// the version that serves today: a whole-VM app with no browser address keeps its note
assert.equal(isWholeVm(rpc(3).image.reference), true); assert.equal(wholeVmWithoutAddress(rpc(3).image.reference), true);
assert.equal(appEndpoint(rpc(3)), ''); assert.equal(appEndpoint({ ...rpc(3), image: undefined, appRef: rpc(3).image.reference }), '');
// the version that declares endpoints.web: an ordinary row
assert.equal(isWholeVm(rpc(4).image.reference), true); assert.equal(wholeVmWithoutAddress(rpc(4).image.reference), false);
assert.equal(appEndpoint(rpc(4)), address); assert.equal(appEndpoint({ ...rpc(4), image: undefined, appRef: rpc(4).image.reference }), address);
// only a path on the app's own name counts as a browser address
assert.equal(appEndpoint(rpc(5)), '');
for (const i of [0, 1, 2, 9]) assert.equal(appEndpoint(rpc(i)), address);
assert.equal(withStore({}).appEndpoint(rpc(3)), address);
assert.match(WHOLE_VM_NOTE, /^<div class="enc-eprow"><span class="enc-epnote" style="[^"<>]+" title="[^"<>]+">[^<>]+<\/span><\/div>$/);
assert.match(src, /: wholeVmWithoutAddress\(\(d\.image && d\.image\.reference\) \|\| d\.appRef\) \? WHOLE_VM_NOTE : ''\)/);
assert.equal(src.split('isWholeVm(').length - 1, 1);   // the definition; nothing else decides on the runtime alone
console.log('backport ok');
