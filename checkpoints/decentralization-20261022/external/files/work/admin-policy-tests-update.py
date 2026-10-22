from pathlib import Path
r=Path('work/enclave')
p=r/'test/host-admission-runtime.test.mjs';s=p.read_text().replace('catalog:{active:false,approval:2,yanked:true}','catalog:{active:true,approval:1,yanked:false}')
a=s.index("test('independent owner");b=s.index("test('wallet denial",a)
s=s[:a]+'''test('platform moderation applies even when the wallet does not require approval',async()=>{
 const {state,admission}=setup();assert.equal(await admission.refusal(request),null);
 assert.deepEqual(state.reads.map(q=>q.functionName).sort(),['authority','getApp','getVersion','registry']);
 for(const change of [{active:false},{approval:2},{yanked:true}]){
  state.catalog={active:true,approval:1,yanked:false,...change};
  for(const forPrivate of [false,true])assert.ok(await admission.refusal({...request,forPrivate}));
 }
});
test('pending private development survives; wallet may apply a stricter restriction',async()=>{
 const {state,admission}=setup();state.catalog.approval=0;
 assert.match(await admission.refusal(request),/PRIVATE/);
 assert.equal(await admission.refusal({...request,forPrivate:true}),null);
 assert.match(await admission.refusal({...request,forPrivate:'true'}),/PRIVATE/);
 state.doc={...document,requireCatalogApproval:true};state.hash=hostAdmissionPolicyHash(state.doc);state.now+=15001;
 assert.match(await admission.refusal({...request,forPrivate:true}),/requires current catalog approval/);
 state.catalog.approval=1;assert.equal(await admission.refusal(request),null);
});
''' +s[b:];p.write_text(s)
p=r/'test/host-admission-policy.test.mjs';s=p.read_text();a=s.index("test('independent hosts");b=s.index("test('ownership transfer",a)
s=s[:a]+'''test('no host wallet policy can override platform rejection, delisting or a yank',()=>{
 for(const requireCatalogApproval of [true,false]){
  const p={...policy,requireCatalogApproval,denyDeployments:[]};
  for(const change of [{active:false},{yanked:true},{approval:2}])
   for(const forPrivate of [false,true])assert.ok(hostAdmissionRefusal(p,{hostId:host,deploymentId:other,appRef,forPrivate,version:{active:true,yanked:false,approval:1,...change}}));
 }
});
''' +s[b:];s=s.replace('/catalog approval/);','/catalog status/);');p.write_text(s)
p=r/'test/host-policy-mirrors.test.mjs';s=p.read_text().replace("  throw Error('catalog authority must not be consulted');", "  if(q.functionName==='getApp')return {appId:app,versionCount:2,active:true};\n  if(q.functionName==='getVersion')return {yanked:false,approval:1};\n  throw Error('unexpected read');");p.write_text(s)
p=r/'test/supervisor-wallet-policy.test.mjs';s=p.read_text();a=s.index("test('Linux admission permits");b=s.index("test('Linux admission rejects",a)
s=s[:a]+'''test('Linux forwards authoritative visibility to wallet and platform admission',async()=>{
 const {state,ctx}=fixture();
 for(const forPrivate of [undefined,false,true,'true']){
  const result=await ctx.gateAppReference(ref,{deploymentId:dep,forPrivate});
  assert.equal(result.error,undefined);assert.equal(state.requests.at(-1).forPrivate,forPrivate===true);
 }
 state.reason='This version was rejected by the catalog owner.';
 assert.match((await ctx.gateAppReference(ref,{deploymentId:dep,forPrivate:true})).error.msg,/rejected/);
});
''' + s[b:];a=s.index("test('wallet-mode yank");s=s[:a]+'''test('wallet mode retains the publisher-yank sweep',async()=>{
 const {state,ctx}=fixture();ctx.APP_CATALOG_ADDRESS=catalog;ctx.deployments=new Map();
 await ctx.yankSweep();assert.equal(ctx._yankBusy,false);
});
''';p.write_text(s)
# The real runtime is tested both from source and the installed bundle entry point.
p=r/'test/host-admission-runtime.test.mjs';s=p.read_text().replace("import {createHostAdmission,fileHostPolicyLoader,hostAdmissionFromEnv} from '../network/host-admission-runtime.mjs';", "const {createHostAdmission,fileHostPolicyLoader,hostAdmissionFromEnv}=await import(process.env.ADMISSION_BUNDLE_TEST ? '../windows/node/host-admission.bundle.mjs' : '../network/host-admission-runtime.mjs');");p.write_text(s)
