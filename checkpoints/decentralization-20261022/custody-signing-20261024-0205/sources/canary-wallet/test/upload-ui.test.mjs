// Offline DOM seam: no wallet, browser, network or production state.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
for (const state of ['upload-unknown', 'pinned-unverified', 'uploading']) {
 test(`page never asks for another signature while upload is ${state}`, async () => {
  const nodes = new Map();
  const el = id => {if (!nodes.has(id)) nodes.set(id,{textContent:'',dataset:{},value:''});return nodes.get(id);};
  const cfg = {token:'fixture',state:{status:'ready'},request:{transaction:{from:'0x123',to:'0x456',value:'0x0'}},stages:{upload:{status:state},component:{}}};
  const context = vm.createContext({document:{getElementById:el,body:{dataset:{stage:'fixture'}}},window:{addEventListener(){},dispatchEvent(){}},Event:class {},setTimeout(){},localStorage:{getItem(){return null;}},fetch:async()=>({json:async()=>cfg}),console});
  vm.runInContext(fs.readFileSync(new URL('../app.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext('connected=true;render()',context);
  assert.equal(el('authorize').disabled,true);
  assert.equal(el('sign').disabled,true);
  assert.doesNotMatch(el('status').textContent,/click Sign upload authorization/);
  if(state==='upload-unknown')assert.match(el('status').textContent,/Verify storage again/);
 });
}
