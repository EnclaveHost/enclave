// Public RPC pacing: read-only requests; preserve independent verification.
import {createPublicClient,http} from '../enclave/node_modules/viem/_esm/index.js';
export const clientsFor=urls=>urls.map(url=>{
 let tail=Promise.resolve();
 const fetchFn=(...args)=>{const result=tail.then(()=>fetch(...args));tail=result.catch(()=>{}).then(()=>new Promise(r=>setTimeout(r,1100)));return result;};
 return createPublicClient({transport:http(url,{fetchFn,timeout:30000,retryCount:2,retryDelay:1100})});
});
