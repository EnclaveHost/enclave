import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {AutomaticConversion} from './automatic.mjs';
import {DurableState} from '../durable-state.mjs';

// Host configuration is trusted operator input. Pin each local adapter like
// the host's other executable dependencies; never import a URL from a quote.
async function adapter(spec,kind){
 if(!spec||!path.isAbsolute(spec.module)||!/^[0-9a-f]{64}$/.test(spec.sha256||''))throw Error('pinned local conversion '+kind+' adapter required');
 const bytes=await fs.readFile(spec.module);
 if(createHash('sha256').update(bytes).digest('hex')!==spec.sha256)throw Error('conversion '+kind+' adapter hash mismatch');
 const m=await import(pathToFileURL(spec.module).href);
 if(typeof m.create!=='function')throw Error('conversion adapter must export create');
 return m.create(spec.config||{});
}
export async function startAutomaticConversion({config,directory,log=()=>{}}){
 const route=await adapter(config.route,'route'),wallet=await adapter(config.wallet,'wallet');
 for(const method of ['quote','open','lookup','status'])if(typeof route[method]!=='function')throw Error('incomplete conversion route adapter');
 for(const method of ['addresses','balances','validateAddress','prepareTransfer','validatePrepared','fundingStatus','broadcast','verifyTransfer'])if(typeof wallet[method]!=='function')throw Error('incomplete conversion wallet adapter');
 const actual=await wallet.addresses();
 if(actual.USDC!==config.addresses?.USDC||actual.NKN!==config.addresses?.NKN)throw Error('conversion wallets do not match the provider configuration');
 const worker=new AutomaticConversion({directory:path.join(directory,'journal'),policy:config.policy,addresses:actual,route,wallet});
 const status=new DurableState(directory);let pending,closed=false;
 const tick=()=>{
  if(closed||pending)return pending;
  pending=worker.tick().then(value=>status.set('status',{updatedAt:Date.now(),...value}))
   .catch(async e=>{log('provider currency management: '+e.message);await status.set('status',{updatedAt:Date.now(),state:'unavailable'});})
   .finally(()=>{pending=null;});return pending;
 };
 // These wallets and this directory require a single host process. Adapter
 // signers must hold their wallet lock across prepare/reconcile/broadcast.
 const timer=setInterval(()=>void tick(),30000);timer.unref();void tick();
 return {async close(){closed=true;clearInterval(timer);await pending;await wallet.close?.();await route.close?.();}};
}
