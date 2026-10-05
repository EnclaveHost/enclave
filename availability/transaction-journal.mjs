/** Each adapter owns a nonce-serial transaction queue. Journal BEFORE asking
 * a signer; an unknown submission requires reconciliation, never a blind retry. */
export function transactionJournal({store,publicClient}){
 let queue=Promise.resolve();
 return (job,key,wallet,request)=>{
  const run=async()=>{
   let current=await store.get(job.id),saved=current.transactions?.[key];
   if(!saved){
    await store.transition(job.id,current.state,{transactions:{...current.transactions,[key]:{status:'requested'}}});
    const hash=await wallet.writeContract(request);
    current=await store.get(job.id);saved={hash,status:'submitted'};
    await store.transition(job.id,current.state,{transactions:{...current.transactions,[key]:saved}});
   }
   if(!saved.hash)throw new Error(`${key}: unresolved submission; transaction hash required`);
   const receipt=await publicClient.waitForTransactionReceipt({hash:saved.hash,confirmations:2,timeout:60000});
   if(receipt.status!=='success')throw new Error(`${key}: transaction reverted`);return receipt;
  };
  const result=queue.then(run);queue=result.catch(()=>{});return result;
 };
}
