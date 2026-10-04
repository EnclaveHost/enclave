import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createPublicClient,createWalletClient,http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {base} from 'viem/chains';
import {LeaseReader} from './lease-reader.mjs';
import {TunaUSDCSettlement} from './tuna-usdc-settlement.mjs';
import {TunaTransportController} from './tuna-transport-control.mjs';
import {startTunaControlServer} from './tuna-control-server.mjs';

export async function startTunaUSDCControl({config,directory,leaseReader,log=()=>{}}){
 if(!path.isAbsolute(directory)||!path.isAbsolute(config.proofKeyFile)||!path.isAbsolute(config.tokenFile))throw Error('absolute USDC controller paths required');
 const secret=async file=>{const st=await fs.stat(file);if(!st.isFile()||process.platform!=='win32'&&(st.mode&0o077))throw Error('private USDC controller key permissions required');return (await fs.readFile(file,'utf8')).trim();};
 const proofAccount=privateKeyToAccount(await secret(config.proofKeyFile)),token=await secret(config.tokenFile);
 const reader=leaseReader||new LeaseReader({rpc:config.rpc,addressBook:config.addressBook,includeConnectivity:true,includeHostPayout:true});
 if(reader.chainId!==8453)throw Error('production USDC settlement requires Base');
 let wallet,client;
 if(config.role==='runner'){
  if(!path.isAbsolute(config.gasKeyFile)||!path.isAbsolute(config.transactionDirectory))throw Error('dedicated gas key and shared transaction directory required');
  const account=privateKeyToAccount(await secret(config.gasKeyFile));
  if(!config.settlementRpc?.startsWith('https://'))throw Error('HTTPS settlement RPC required');
  client=createPublicClient({chain:base,transport:http(config.settlementRpc,{timeout:15000})});wallet=createWalletClient({chain:base,account,transport:http(config.settlementRpc,{timeout:15000})});
 }
 // One controller owns the durable transport meters. Never replace a live
 // socket or ignore a crash lock without reconciling its state first.
 await fs.mkdir(directory,{recursive:true,mode:0o700});const lock=path.join(directory,'controller-lock');await fs.mkdir(lock,{mode:0o700});
 let controller,server;
 try{
  controller=new TunaTransportController({role:config.role,hostId:config.hostId,proofAccount,leaseReader:reader,directory,maxPending6:config.maxPending6,
   settlementFactory:async(providerId,cosign)=>new TunaUSDCSettlement({providerId,cosign,directory:path.join(directory,'settlement',providerId),transactionDirectory:config.transactionDirectory,leaseReader:reader,proofAccount,wallet,client,maxPending6:config.maxPending6,log}).start()});
  server=await startTunaControlServer({controller,token,socketPath:config.socketPath,port:config.port,log});
  const scopes=new Set();let closing;
  return {...server,controller,async scope({deploymentId,providerId,socketPath}){
   if(closing||config.role!=='runner')throw Error('runner control scopes unavailable');
   const token=randomBytes(32).toString('hex');
   const child=await startTunaControlServer({controller,token,socketPath,scope:{deploymentId,providerId},ownsController:false,intervalMs:0,log});
   scopes.add(child);let closed=false;
   return {...child,token,async close(){if(closed)return;closed=true;scopes.delete(child);await child.close();}};
  },async close(){if(!closing)closing=(async()=>{await Promise.all([...scopes].map(s=>s.close()));await server.close();})().finally(()=>fs.rmdir(lock));await closing;}};
 }catch(e){await controller?.close();await fs.rmdir(lock);throw e;}
}
