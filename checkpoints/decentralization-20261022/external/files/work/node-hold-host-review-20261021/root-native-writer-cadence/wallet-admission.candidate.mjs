// Local coordination between the host policy reader and its network agent. This file is not a new authority:
// the writer may publish only a decision already verified against the host wallet and catalog, and its deadline
// is bounded by that decision's chain snapshot. The lease and measured guest proof remain mandatory.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

const ID=/^0x[0-9a-f]{64}$/, GEN=/^[0-9a-f]{32}$/;
const MAX_BYTES=262144, MAX_APPS=256, CHANNEL_MS=30000, POLICY_MS=90000;
// A sharing violation of the atomic replace (Windows) is retried here, once per commit, within this exact budget.
export const COMMIT_RETRY=Object.freeze({attempts:6,stepMs:25,budgetMs:375}); // waits 25+50+75+100+125 ms
const SHARING=['EPERM','EACCES','EBUSY'],SLEEP=new Int32Array(new SharedArrayBuffer(4));
const plain=o=>!!o&&typeof o==='object'&&!Array.isArray(o);
const exact=(o,keys)=>plain(o)&&Object.keys(o).length===keys.length&&Object.keys(o).every(k=>keys.includes(k));
const int=n=>Number.isSafeInteger(n)&&n>=0;
const ref=r=>typeof r==='string'&&/^catalog:\/\/0x[0-9a-f]{64}\/(?:0|[1-9][0-9]{0,8})$/.test(r);
function binding(a){return exact(a,['appRef','configCid','validUntil'])&&ref(a.appRef)&&typeof a.configCid==='string'&&a.configCid.length<=8192&&int(a.validUntil);}
function location(file,runner){
  if(typeof file!=='string'||!path.isAbsolute(file)||!ID.test(runner||''))throw Error('wallet admission needs an absolute file and exact runner');
}
function validate(d,runner,now){
  if(!exact(d,['version','runner','generation','revision','issuedAt','expiresAt','allows'])||d.version!==1||d.runner!==runner||!GEN.test(d.generation)||!int(d.revision)||
    !int(d.issuedAt)||!int(d.expiresAt)||d.issuedAt>now+5000||d.expiresAt<=now||d.expiresAt<=d.issuedAt||d.expiresAt>d.issuedAt+CHANNEL_MS||
    !plain(d.allows)||Object.keys(d.allows).length>MAX_APPS)throw Error('invalid or expired wallet admission document');
  for(const [id,a] of Object.entries(d.allows))if(!ID.test(id)||!binding(a)||a.validUntil>d.issuedAt+POLICY_MS)throw Error('invalid wallet admission binding');
  return d;
}

/** Atomic, empty-on-start writer. Constructor failure MUST stop activation; no fallback to an old allow file.
 * allow() accepts an absolute validity deadline from a verified policy decision, never computes a new policy lifetime.
 * heartbeat() extends only the channel lifetime; it cannot extend any policy decision. A hold's returned revision
 * must be acknowledged by the network agent after circuit withdrawal and egress-map persistence before keeping a VM.
 */
export class WalletAllowWriter {
  constructor({file,runner,now=Date.now}){
    location(file,runner);Object.assign(this,{file,runner,now});this.generation=randomBytes(16).toString('hex');this.revision=0;this.allows={};
    this.commit();
  }
  commit(){
    const issuedAt=this.now();
    for(const [id,a] of Object.entries(this.allows))if(a.validUntil<=issuedAt)delete this.allows[id];
    const next=this.revision+1,d={version:1,runner:this.runner,generation:this.generation,revision:next,issuedAt,expiresAt:issuedAt+CHANNEL_MS,allows:this.allows};
    validate(d,this.runner,issuedAt);const raw=JSON.stringify(d);if(Buffer.byteLength(raw)>MAX_BYTES)throw Error('wallet admission document too large');
    const tmp=this.file+'.'+this.generation+'.'+next+'.tmp';let fd;
    try{
      fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,raw);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      // The replace MAY meet a Windows sharing violation (EPERM/EACCES/EBUSY) when another process holds the file without
      // FILE_SHARE_DELETE (an antivirus or indexer scan, a non-Node reader); a Node reader opens with share-delete. The SAME
      // complete temp file is renamed again, at most COMMIT_RETRY.attempts times (<= COMMIT_RETRY.budgetMs of waiting);
      // never a torn in-place write. The document (issuedAt, expiresAt, every validUntil) is fixed BEFORE the first try, so
      // a retry can only shorten what it grants, never extend it. This is the ONLY retry layer: callers do not retry.
      for(let attempt=1;;attempt++){
        try{fs.renameSync(tmp,this.file);break;}
        catch(e){if(!SHARING.includes(e.code)||attempt>=COMMIT_RETRY.attempts)throw e;Atomics.wait(SLEEP,0,0,COMMIT_RETRY.stepMs*attempt);}
      }
      if(process.platform!=='win32'){const dir=fs.openSync(path.dirname(this.file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
      this.revision=next;return {generation:this.generation,revision:next};
    }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  allow(id,a){if(!ID.test(id)||!binding(a)||a.validUntil<=this.now()||a.validUntil>this.now()+POLICY_MS)throw Error('fresh verified wallet decision required');this.allows[id]={...a};return this.commit();}
  hold(id){if(!ID.test(id))throw Error('exact deployment required');delete this.allows[id];return this.commit();}
  heartbeat(){return this.commit();}
}

export class WalletAllowFile {
  constructor({file,runner,now=Date.now,log=()=>{}}){location(file,runner);Object.assign(this,{file,runner,now,log});this.document=null;this.floor=null;this.retired=new Set();this.error='not read';}
  refresh(){
    try{
      const fd=fs.openSync(this.file,'r');let raw;
      try{if(fs.fstatSync(fd).size>MAX_BYTES)throw Error('wallet admission document too large');const b=Buffer.alloc(MAX_BYTES+1);const n=fs.readSync(fd,b,0,b.length,0);if(n>MAX_BYTES)throw Error('wallet admission document too large');raw=b.subarray(0,n).toString('utf8');}finally{fs.closeSync(fd);}
      const d=validate(JSON.parse(raw),this.runner,this.now());
      if(this.retired.has(d.generation))throw Error('retired wallet generation');
      if(this.floor?.generation===d.generation){
        if(d.revision<this.floor.revision||(d.revision===this.floor.revision&&raw!==this.floor.raw))throw Error('wallet admission rollback or equivocation');
      }else if(this.floor){
        if(this.retired.size>=256)throw Error('wallet generation capacity reached');
        this.retired.add(this.floor.generation);
      }
      this.floor={generation:d.generation,revision:d.revision,raw};this.document=d;this.error=null;
    }catch(e){this.document=null;const message=e.code||e.message;if(this.error!==message)this.log('wallet admission withheld: '+message);this.error=message;}
    return this.status();
  }
  until(id,lease){
    const d=this.document,a=d?.allows[id],now=this.now();
    if(!d||d.expiresAt<=now||!a||!lease||lease.runner!==this.runner||a.appRef!==lease.appRef||a.configCid!==lease.configCid)return 0;
    const until=Math.min(d.expiresAt,a.validUntil);return until>now?until:0;
  }
  status(){const d=this.document,fresh=!!d&&d.expiresAt>this.now();return {runner:this.runner,generation:d?.generation??null,revision:d?.revision??null,expiresAt:d?.expiresAt??0,fresh,error:this.error,allows:fresh?Object.keys(d.allows).filter(id=>d.allows[id].validUntil>this.now()):[]};}
}

// A host may preserve a held VM only after the cooperating network agent confirms the exact writer generation and
// at least the hold revision. Old runtimes (no applied flag), stale status, another runner and an intervening allow
// cannot serve as proof of withdrawal. This proves the local network hold; it does not authorize compute or renewal.
export function walletHoldAcknowledged({status,runner,id,hold,now=Date.now()}){
  const a=status?.walletAdmission;
  return !!(ID.test(runner)&&ID.test(id)&&hold&&/^[a-f0-9]{32}$/.test(hold.generation)&&Number.isSafeInteger(hold.revision)&&hold.revision>0&&
    status?.version===2&&Number.isSafeInteger(status.updatedAt)&&status.updatedAt<=now+1000&&status.updatedAt>now-5000&&
    a?.runner===runner&&a.generation===hold.generation&&Number.isSafeInteger(a.revision)&&a.revision>=hold.revision&&
    a.fresh===true&&a.applied===true&&a.error===null&&Number.isSafeInteger(a.expiresAt)&&a.expiresAt>now&&a.expiresAt<=now+CHANNEL_MS+1000&&
    Array.isArray(a.allows)&&a.allows.length<=256&&a.allows.every(v=>ID.test(v))&&!a.allows.includes(id));
}

/** Preserve the gate's real lease/proof methods and maps. Optional only for legacy configurations without wallet policy;
 * production wallet-controlled hosts must explicitly configure the file before enabling non-destructive holds.
 */
export function withWalletAdmission(gate,wallet){
  const proven=gate.allows.bind(gate);gate.proven=proven;gate.wallet=wallet;
  gate.walletUntil=id=>wallet?wallet.until(id,gate.leases.get(id)):Infinity;
  gate.allows=id=>proven(id)&&gate.walletUntil(id)>gate.now();
  return gate;
}
