#!/usr/bin/env node
// Register an Enclave-network provider as a registry host, so it can be a community (paid) provider
// (docs/design/enclave-network.md, "Billing (paid providers)"). Runs ON the provider:
//   node provider-register.mjs /etc/enclave-network/provider.json
// Creates the provider's receipt-signing proof key beside its operator key if missing (0600, never printed),
// registers the host "wg-provider://<publicAddress>" with that proof key (operator key pays gas; a prohibitive
// compute price, since this host takes no compute work), and prints {hostId, operator, proofKey}. Then set
// kind "community", hostId, pricePerGiB6 and proofKeyFile in provider.json and restart the provider.
import fs from 'node:fs';
import path from 'node:path';
import {createPublicClient,createWalletClient,http,keccak256,stringToHex,parseAbi} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {base} from 'viem/chains';
import {hostABI} from '../../network/registry-abi.mjs';

const cfg=JSON.parse(fs.readFileSync(process.argv[2]||'/etc/enclave-network/provider.json','utf8'));
const account=privateKeyToAccount(fs.readFileSync(cfg.operatorKeyFile,'utf8').trim());
const proofFile=cfg.proofKeyFile||path.join(path.dirname(cfg.operatorKeyFile),'proof.key');
if(!fs.existsSync(proofFile))fs.writeFileSync(proofFile,generatePrivateKey()+'\n',{mode:0o600,flag:'wx'});
const proof=privateKeyToAccount(fs.readFileSync(proofFile,'utf8').trim());
const client=createPublicClient({chain:base,transport:http(cfg.rpc[0],{timeout:15000})});
const wallet=createWalletClient({account,chain:base,transport:http(cfg.rpc[0],{timeout:15000})});
const registry=await client.readContract({address:cfg.addressBook,abi:parseAbi(['function addr(bytes32) view returns (address)']),functionName:'addr',args:[stringToHex('registry',{size:32})]});
const endpoint=`wg-provider://${cfg.publicAddress}`,hostId=keccak256(stringToHex(endpoint));
const e=await client.readContract({address:registry,abi:hostABI,functionName:'get',args:[hostId]});
if(!(e.active&&e.operator.toLowerCase()===account.address.toLowerCase()&&e.proofKey.toLowerCase()===proof.address.toLowerCase())){
 const hash=await wallet.writeContract({address:registry,functionName:'register',
  abi:parseAbi(['function register(string,string,bytes32,uint64,uint64,address) returns (bytes32)']),
  args:[endpoint,'enclave-network-provider','0x'+'0'.repeat(64),10n**12n,0n,proof.address]});
 const r=await client.waitForTransactionReceipt({hash,timeout:120000});if(r.status!=='success')throw new Error('register reverted');
 console.error(`registered ${endpoint} (tx ${hash})`);
}
console.log(JSON.stringify({hostId,operator:account.address.toLowerCase(),proofKey:proof.address.toLowerCase(),proofKeyFile:proofFile}));
