// Create an unfunded service identity. Never read or print a private key.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const dir='/var/lib/enclave-lease-relay';
try{fs.mkdirSync(dir,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e;}
const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw Error('identity directory is not protected');
const keyPath=path.join(dir,'relay.key'),metaPath=path.join(dir,'identity.json');
if(fs.existsSync(keyPath)||fs.existsSync(metaPath))throw Error('identity already exists; inspect public metadata, never overwrite');
const lockPath=path.join(dir,'.create.lock');const lock=fs.openSync(lockPath,'wx',0o600);
try{
 const key=crypto.createECDH('secp256k1');key.generateKeys();
 const publicKey='0x'+key.getPublicKey('hex','uncompressed');
 const meta={format:'enclave-lease-relay-identity/v1',createdAt:new Date().toISOString(),publicKey,privateKeyPath:keyPath,chainId:8453,status:'unfunded; no service activated'};
 const privateBytes=key.getPrivateKey();
 const fd=fs.openSync(keyPath,'wx',0o600);try{fs.writeFileSync(fd,'0x'+privateBytes.toString('hex')+'\n');fs.fsyncSync(fd);}finally{privateBytes.fill(0);fs.closeSync(fd);}
 const md=fs.openSync(metaPath,'wx',0o644);try{fs.writeFileSync(md,JSON.stringify(meta,null,2)+'\n');fs.fsyncSync(md);}finally{fs.closeSync(md);}
 const dd=fs.openSync(dir,'r');try{fs.fsyncSync(dd);}finally{fs.closeSync(dd);}
 console.log(JSON.stringify(meta));
}finally{fs.closeSync(lock);fs.unlinkSync(lockPath);}
