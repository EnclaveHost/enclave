import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../site/components/deployments/deployments.js', import.meta.url), 'utf8');
const method = name => {
  const match = source.match(new RegExp('  async ' + name + '\\([^]*?\\n  }\\n'));
  assert.ok(match, name + ' exists');
  return match[0];
};
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture({ available = false, rev = 13, envelope = '', config = {volumes:['qwen-image-2512-sd']}, configCid = '', fetchConfig = async () => null } = {}) {
  const stock = JSON.stringify(config);
  const deps = {
    depSchemaRev: async () => rev,
    depGet: async () => ({configCid:envelope, appRef:'catalog://app/42', leaseUntil:0}),
    loadCatalog: async () => {},
    Enclave: {getAvailability:async () => available === null ? null : {configOverride:available}, getEnclaves:async () => []},
    fetchConfigCid: fetchConfig,
    parseCatalogRef: () => ({appId:'app',index:42}),
    STORE: {byId:{app:{versions:{42:{config:stock,configCid}}}}},
    stripMedia: s => s,
    volumesOf: o => [...new Set(o?.volumes || [])], esc,
    paintLine: (target, cls, text) => { target.textContent = text; }
  };
  const Cls = new Function(...Object.keys(deps), 'return class {' + method('_cfgRead') + method('_models') + '\n_envLearn() {}\n};')(...Object.values(deps));
  const component = new Cls();
  const status = {textContent:''};
  const box = {hidden:true,isConnected:true,innerHTML:'',querySelector:() => status};
  const button = {closest:() => ({querySelector:() => box}),setAttribute:() => {}};
  return {component,box,button,status};
}

test('Models displays the configured selection when the fleet cannot edit it', async () => {
  const {component,box,button} = fixture();
  await component._models('deployment', button);
  assert.match(box.innerHTML, /Selected models/);
  assert.match(box.innerHTML, /qwen-image-2512-sd/);
  assert.match(box.innerHTML, /not on any live enclave/);
  assert.doesNotMatch(box.innerHTML, /<button|<input|c-volume-picker/);
});

test('missing fleet support and old ledgers block writes, not reads', async () => {
  for (const settings of [{available:false}, {available:null}, {rev:4,available:true}]) {
    const {component} = fixture(settings);
    assert.ok((await component._cfgRead('id')).err);
    const view = await component._cfgRead('id',{allowReadOnly:true});
    assert.equal(view.err,undefined);
    assert.ok(view.editBlocked);
    assert.deepEqual(JSON.parse(view.stock).volumes,['qwen-image-2512-sd']);
  }
});

test('supported edits and existing overrides retain their established behavior', async () => {
  for (const settings of [{available:true}, {envelope:'{"config":{"volumes":["custom"]}}'}]) {
    const {component} = fixture(settings);
    const ctx = await component._cfgRead('id');
    assert.equal(ctx.err,undefined);
    assert.equal(ctx.editBlocked,null);
  }
});

test('read-only models resolve the pinned stock config and escape model names', async () => {
  const {component,box,button} = fixture({configCid:'cid',fetchConfig:async () => '{"volumes":["<model>"]}'});
  await component._models('id',button);
  assert.match(box.innerHTML,/&lt;model&gt;/);
  assert.doesNotMatch(box.innerHTML,/<model>/);
});

test('unreadable pinned config is reported instead of claiming no models are selected', async () => {
  const {component,box,button,status} = fixture({configCid:'missing'});
  await component._models('id',button);
  assert.match(status.textContent,/couldn’t read the version/);
  assert.doesNotMatch(box.innerHTML,/No model volumes selected/);
});
