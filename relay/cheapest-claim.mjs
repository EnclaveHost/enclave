// Exact contract quotes include the deployment's shares, publisher fee and
// owner self-hosting waiver. Never rank by the whole machine's advertised ask.
export const CLAIM_QUOTE_ABI = ['rateFor', 'claimableBy'].map(name => ({
  type:'function', name, stateMutability:'view',
  inputs:[{name:'id',type:'bytes32'},{name:'enclaveId',type:'bytes32'}],
  outputs:[{type:name === 'rateFor' ? 'uint256' : 'bool'}],
}));
export async function claimCheapest({pool, quote, hint, preferred = ''}) {
  const prefers = host => !!preferred && [host.id, host.name, host.endpoint]
    .some(value => String(value || '').toLowerCase() === preferred.toLowerCase());
  let failedQuotes=0;
  const priced=await Promise.all(pool.map(async host=>{
    try {
      const {rate,claimable,selfHosted}=await quote(host);
      if (claimable !== true) return null;
      const price=BigInt(rate);
      if (price < 0n) throw Error('negative quote');
      return {host,price,selfHosted:selfHosted === true};
    } catch { failedQuotes++; return null; }
  }));
  const ranked=priced.filter(Boolean).sort((a,b)=>Number(prefers(b.host))-Number(prefers(a.host)) || Number(b.selfHosted)-Number(a.selfHosted) ||
    (a.price < b.price ? -1 : a.price > b.price ? 1 :
      String(a.host.name || a.host.endpoint).localeCompare(String(b.host.name || b.host.endpoint))));
  let declined;
  for(const {host,price} of ranked) {
    // Serial hints give the cheaper host first refusal. Fan-out would just
    // award the job to whichever host's transaction arrived fastest.
    try {
      const result=await hint(host);
      if(result?.accepted === true) return {...result,enclave:host.name,ratePerSec6:price.toString(),strategy:'cheapest'};
      if(result?.reason) declined=result.reason;
    } catch { declined='A candidate host did not answer.'; }
  }
  return {accepted:false,strategy:'cheapest',reason:declined || (failedQuotes
    ? 'Could not confirm eligible host prices on-chain. The app remains queued.'
    : 'No eligible host can claim within the app’s rate cap and balance right now. The app remains queued.')};
}
