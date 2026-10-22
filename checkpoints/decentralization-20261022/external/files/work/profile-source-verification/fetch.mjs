const E='/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const {rpcClients}=await import(E+'/network/authority-profile.mjs');
const {LeaseReader}=await import(E+'/network/lease-reader.mjs');
const {keccak256}=await import(E+'/node_modules/viem/_esm/index.js');
import fs from 'node:fs';
const A={registry:'0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac',deployments:'0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b',appCatalog:'0x18419ca2b502d423a8de6269aeee171a378626e3',proofOfTime:'0x6f462d77727f10f05a3e660650e7dcc9cc60e6b2',enclavePay:'0x580270e88e5df35dad59e7fe3d907ebea96673a6',verificationFees:'0x87c7266543ff5839b2c20226bd9b3cd511a23641',connectivity:'0x5f8b636e0768e84bd47b736652030b65db615111',paymentRouter:'0xf17157b42ebbd65e33dd592878a8f1769c69d56a',keyAttestations:'0xb49241efe5af6078be6aa84850ae45eed34df61b',legacySessionVaultFactory:'0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c',legacySessionVaultImplementation:'0x66c76a47209f44612343dbeab98b8ef77ad01f65',legacySessionVaultLib:'0x5510ae9fed97577d75c69545384af7d8bad05027',usdc:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'};
const z='0x'+'0'.repeat(40);
const r=new LeaseReader({clients:rpcClients(['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.drpc.org']),addressBook:z,authorityPins:{deployments:A.deployments,registry:A.registry,connectivity:z,sessionVaultFactory:z}});
const f=[];
const o=await r.agreed(async(c,blockNumber)=>{const codes={};for(const [k,a] of Object.entries(A)){codes[k]=await c.getCode({address:a,blockNumber});await new Promise(r=>setTimeout(r,120));}return {codes};},f).catch(e=>{console.error(e.message,f);process.exit(1)});
fs.writeFileSync('live-codes.json',JSON.stringify({blockNumber:o.blockNumber,blockHash:o.hash,timestamp:o.timestamp,addresses:A,codes:o.codes},null,1));
for(const [k,c] of Object.entries(o.codes)){const b=Buffer.from(c.slice(2),'hex');const L=b.readUInt16BE(b.length-2);const cbor=b.subarray(b.length-2-L,b.length-2).toString('hex');console.log(k,b.length,keccak256(c).slice(0,14),'cborLen',L,cbor);}
console.log(o.blockNumber,o.hash);
