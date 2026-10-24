// Consumption evidence is accepted only from the transport key in a fresh verified recipient quote.
import https from 'node:https';
import {canonical,sha256hex} from './canonical.mjs';
import {verifyLiveRecipient,RECIPIENT_QUOTE_MAX_MS} from './recipient-attestation.mjs';
import {proveConsumption} from './proof.mjs';
const need=(ok)=>{if(!ok)throw Error('recipient proof refused: pinned live transport unavailable or inconsistent');};
export function fetchPinnedProof({id,keyHash,url,requestImpl=https.request}) {
  need(/^0x[a-f0-9]{64}$/.test(id)&&/^[a-f0-9]{64}$/.test(keyHash));
  const prefix=`https://${id.slice(2,10)}.app.enclave.host/canary/proof?c=`;
  need(typeof url==='string'&&url.startsWith(prefix)&&/^[a-f0-9]{64}$/.test(url.slice(prefix.length)));
  const u=new URL(url);
  return new Promise((resolve,reject)=>{
    let req,done=false,approved=false,size=0;const chunks=[];
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){req?.destroy();reject(Error('recipient proof transport failed'));}else resolve(value);};
    const timer=setTimeout(()=>finish(true),20000);
    try {
      req=requestImpl({hostname:u.hostname,port:443,servername:u.hostname,path:u.pathname+u.search,method:'GET',agent:false,rejectUnauthorized:false,minVersion:'TLSv1.3',headers:{'Cache-Control':'no-store'}},res=>{
        if(!approved||res.statusCode!==200)return finish(true);
        const length=res.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>4096))return finish(true);
        res.on('data',b=>{size+=b.length;if(size>4096)return finish(true);chunks.push(Buffer.from(b));});
        res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));
        res.on('end',()=>{if(done)return;try {finish(null,new Response(Buffer.concat(chunks),{status:200,headers:res.headers}));}catch{finish(true);}});
      });
      req.on('socket',socket=>socket.once('secureConnect',()=>{
        try {
          const spki=socket.getPeerX509Certificate()?.publicKey.export({type:'spki',format:'der'});
          need(!socket.isSessionReused()&&Buffer.isBuffer(spki)&&sha256hex(spki)===keyHash);
          approved=true;req.end();
        }catch{finish(true);}
      }));
      req.on('error',()=>finish(true));
    }catch{finish(true);}
  });
}
export async function proveLiveRecipient({id,pins,required,rejected=[],observeRecipient,attest,now=()=>Date.now(),fetchProof=fetchPinnedProof}) {
  const verified=await verifyLiveRecipient({id,pins,observeRecipient,attest,now});
  const proof=await proveConsumption({id,required,rejected,fetchImpl:url=>fetchProof({id,keyHash:verified.attestation.transportKeySha256,url})});
  const after=await observeRecipient();
  need(after.status==='recipient-observed'&&['attemptDigest','custodianWindowDigest','identity','instance','process'].every(k=>sha256hex(canonical(after[k]))===sha256hex(canonical(verified.observation[k]))));
  const at=now();need(at>=verified.attestation.verifiedAt&&at-verified.attestation.requestedAt<=RECIPIENT_QUOTE_MAX_MS);
  return {...proof,evidence:{...proof.evidence,recipient:after,attestation:verified.attestation,transportPinned:true,
    scope:'Fresh HMAC consumption from the transport key bound to a freshly verified SNP recipient; not proof of relay plaintext exclusion, rollback protection or decentralized custody.'}};
}
