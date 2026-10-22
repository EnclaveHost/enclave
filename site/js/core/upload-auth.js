// The adapter verifies this deployment-bound EIP-191 message inside the guest.
export function uploadMessage({audience,path,address,hash,size,expiry}) {
  if(!/^0x[0-9a-f]{64}$/.test(audience)||!/^0x[0-9a-f]{40}$/.test(address)||! /^[0-9a-f]{64}$/.test(hash)||
     !['/add-wasm','/add-json','/add-image','/add-file'].includes(path)||!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(expiry)||expiry<0)
    throw Error('Invalid direct upload scope');
  return `enclave-storage-upload:v1\nchainId:8453\nservice:${audience}\nmethod:POST\npath:${path}\naddress:${address}\nsha256:${hash}\nbytes:${size}\nexpiry:${expiry}`;
}
// A caller that streams a large file can compute its digest without buffering
// a second copy. The adapter still verifies the actual request body against it.
export async function directUploadDigestHeaders({audience,url,address,hash,size,signMessage,now=Date.now}) {
  const target=new URL(url);
  if(target.username||target.password||target.search||target.hash||target.protocol!=='https:')throw Error('Direct upload requires an HTTPS endpoint without credentials or query');
  address=address.toLowerCase();audience=audience.toLowerCase();
  const expiry=Math.floor(now()/1000)+300;
  const message=uploadMessage({audience,path:target.pathname,address,hash,size,expiry});
  const signature=await signMessage({message});
  return {'x-upload-address':address,'x-upload-expiry':String(expiry),'x-upload-sha256':hash,'x-upload-signature':signature};
}
export async function directUploadHeaders({bytes,...args}) {
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return directUploadDigestHeaders({...args,hash,size:bytes.byteLength});
}

// ---- smart-account uploads (x-upload-scheme: erc1271-v2) ---------------------------------------------------------
// An account with no private key - a Safe whose owners are passkeys - signs through its own contract (ERC-1271): the
// adapter asks isValidSignature(eip191(message), signature) through the chain readers ITS OPERATOR pinned, and accepts
// only a deployed account (s3-ipfs-adapter src/account_upload.rs). Additive; the v1 wallet message above is unchanged.
export const ACCOUNT_UPLOAD_SCHEME='erc1271-v2';
export function accountUploadMessage({chainId,audience,path,account,hash,size,nonce,expiry}) {
  if(!Number.isSafeInteger(chainId)||chainId<=0||!/^0x[0-9a-f]{64}$/.test(audience)||!/^0x[0-9a-f]{40}$/.test(account)||!/^[0-9a-f]{64}$/.test(hash)||
     !['/add-wasm','/add-json','/add-image','/add-file'].includes(path)||!Number.isSafeInteger(size)||size<0||!/^[0-9a-f]{32}$/.test(nonce)||!Number.isSafeInteger(expiry)||expiry<0)
    throw Error('Invalid smart-account upload scope');
  return `enclave-storage-upload:v2\nscheme:erc1271\nchainId:${chainId}\nservice:${audience}\nmethod:POST\npath:${path}\naccount:${account}\nsha256:${hash}\nbytes:${size}\nnonce:${nonce}\nexpiry:${expiry}`;
}
// `sign(message) -> 0x ERC-1271 signature bytes` is the ACCOUNT's own signer (never a gas payer's key).
export async function accountUploadDigestHeaders({audience,url,account,chainId,hash,size,sign,now=Date.now,nonce}) {
  const target=new URL(url);
  if(target.username||target.password||target.search||target.hash||target.protocol!=='https:')throw Error('Direct upload requires an HTTPS endpoint without credentials or query');
  account=account.toLowerCase();audience=audience.toLowerCase();
  nonce=nonce||[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const expiry=Math.floor(now()/1000)+300;
  const message=accountUploadMessage({chainId,audience,path:target.pathname,account,hash,size,nonce,expiry});
  const signature=await sign(message);
  if(!/^0x([0-9a-fA-F]{2})+$/.test(signature||''))throw Error('the account produced no signature');
  return {'x-upload-scheme':ACCOUNT_UPLOAD_SCHEME,'x-upload-address':account,'x-upload-expiry':String(expiry),'x-upload-sha256':hash,'x-upload-nonce':nonce,'x-upload-signature':signature.toLowerCase()};
}
