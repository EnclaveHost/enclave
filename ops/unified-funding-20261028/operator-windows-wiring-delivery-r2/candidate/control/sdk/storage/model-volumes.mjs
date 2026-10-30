// Model volumes as PINNED, CHUNKED, DIGEST-ADDRESSED public artifacts.
//
// A model volume (metal/volumes.mjs: ext4 + appended dm-verity tree, reproducible) is one multi-GB file. To reach a
// host cold - no cache, no particular mirror - it is published as a canonical chunk manifest plus its chunks:
//
//   manifest  enclave-model-volume-dist/1, canonical JSON (sorted keys, no whitespace); its sha256 is the volume's PIN
//   chunks    the image cut at chunkBytes, each fetched by its own sha256 (RawArtifacts: raw CIDv1 over sha256)
//
// The pin is what the measured runtime carries (rt/model-volumes.table, tableLine below), next to the dm-verity root
// the GUEST checks every block against. A host fetches from any replica it can reach (RawArtifacts: literal-IP
// gateways, any order, each byte digest-checked before use), so availability never depends on one provider's mirrors
// and a replica can lie only by failing. Nothing here is secret: model weights are public, published data.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {parseUniqueJSON} from '../bootstrap/package.mjs';

export const DIST_FORMAT='enclave-model-volume-dist/1';
export const CHUNK_BYTES=256*1024*1024;            // under RawArtifacts' 512 MiB per-object default
export const MAX_IMAGE_BYTES=512*1024*1024*1024;   // 512 GiB: the largest family the fleet carries is far below
export const VOL_NAME_RE=/^[a-z0-9][a-z0-9._-]{0,63}$/;   // wasm_manager.py _VOL_NAME_RE: the attach name
const HEX=/^[0-9a-f]{64}$/;
const PRELOADS=['ggml','sd','none'];

const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const sha=b=>createHash('sha256').update(b).digest('hex');
const safeGraph=g=>typeof g==='string'&&g.length<=240&&g.split('/').every(s=>s&&s!=='.'&&s!=='..'&&/^[A-Za-z0-9_.+-]+$/.test(s));

// The preload a volume record states, as the shared manager decides it: a stable-diffusion volume preloads through
// sd; a volume with ONE unambiguous GGUF (the explicit --gguf pick, or the only *.gguf, or one complete split family)
// preloads through ggml; anything else is mounted only.
export function preloadOf(vol){
  if(vol.sd)return {preload:'sd',graph:'.'};
  if(vol.gguf)return {preload:'ggml',graph:vol.gguf};
  const ggufs=(vol.files||[]).filter(f=>/\.gguf$/i.test(f));
  if(ggufs.length===1)return {preload:'ggml',graph:ggufs[0]};
  const split=ggufs.filter(f=>/-0*1-of-\d+\.gguf$/i.test(f));
  if(split.length===1&&ggufs.every(f=>f.replace(/-\d+-of-\d+\.gguf$/i,'')===split[0].replace(/-\d+-of-\d+\.gguf$/i,'')))return {preload:'ggml',graph:split[0]};
  return {preload:'none',graph:'-'};
}

// name, verity geometry, image size and preload: the part a guest acts on (shared by manifests and the table)
function validateCore(name,v,imageBytes,preload,graph){
  if(!VOL_NAME_RE.test(name))throw Error('bad volume name');
  if(!exact(v,['alg','root','salt','dataBlockSize','hashBlockSize','dataBlocks','hashStartBlock'])||v.alg!=='sha256'||!HEX.test(v.root)||
     !/^[0-9a-f]{2,256}$/.test(v.salt)||v.salt.length%2||v.dataBlockSize!==4096||v.hashBlockSize!==4096||
     !Number.isSafeInteger(v.dataBlocks)||v.dataBlocks<1||!Number.isSafeInteger(v.hashStartBlock)||v.hashStartBlock<=v.dataBlocks)throw Error('bad verity geometry');
  if(!Number.isSafeInteger(imageBytes)||imageBytes<=v.dataBlocks*4096||imageBytes>MAX_IMAGE_BYTES||imageBytes%4096||
     imageBytes<=(v.hashStartBlock)*4096)throw Error('bad image size');
  if(!PRELOADS.includes(preload)||(preload==='none')!==(graph==='-')||(preload!=='none'&&!safeGraph(graph)))throw Error('bad preload');
}

export function validateManifest(m){
  if(!exact(m,['format','name','verity','imageBytes','imageSha256','chunkBytes','chunks','preload','graph'])||m.format!==DIST_FORMAT)throw Error('not an '+DIST_FORMAT+' manifest');
  validateCore(m.name,m.verity,m.imageBytes,m.preload,m.graph);
  if(!HEX.test(m.imageSha256))throw Error('bad image digest');
  if(!Number.isSafeInteger(m.chunkBytes)||m.chunkBytes<4096||m.chunkBytes>512*1024*1024||m.chunkBytes%4096)throw Error('bad chunk size');
  if(!Array.isArray(m.chunks)||m.chunks.length!==Math.ceil(m.imageBytes/m.chunkBytes))throw Error('chunk count does not cover the image');
  m.chunks.forEach((c,i)=>{const want=i<m.chunks.length-1?m.chunkBytes:m.imageBytes-m.chunkBytes*(m.chunks.length-1);
    if(!exact(c,['sha256','size'])||!HEX.test(c.sha256)||c.size!==want)throw Error('bad chunk '+i);});
  return m;
}

// manifest object -> {bytes, pin}; refuses anything validateManifest refuses.
export function encodeManifest(m){const bytes=Buffer.from(canonical(validateManifest(m)));return {bytes,pin:sha(bytes)};}

// bytes + the pin they must hash to -> the manifest (canonical form required: one manifest, one pin).
export function decodeManifest(bytes,pin){
  if(!HEX.test(pin)||bytes.length>2*1024*1024||sha(bytes)!==pin)throw Error('model volume manifest does not match its pin');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),m=parseUniqueJSON(text);
  if(canonical(m)!==text)throw Error('model volume manifest is not canonical');
  return validateManifest(m);
}

// The measured table line (rt/model-volumes.table): what a guest needs to mount a volume against its pinned root, and
// what a host needs to fetch it. Space-separated, one line per volume, names sorted (tableText).
export function tableLine(m,pin){
  validateManifest(m);if(!HEX.test(pin))throw Error('bad pin');
  const v=m.verity;
  return [m.name,v.root,v.salt,v.dataBlockSize,v.hashBlockSize,v.dataBlocks,v.hashStartBlock,m.imageBytes,m.preload,m.graph,pin].join(' ');
}
export function tableText(rows){
  const lines=rows.map(({manifest,pin})=>tableLine(manifest,pin)).sort();
  const names=lines.map(l=>l.split(' ')[0]);
  if(new Set(names).size!==names.length)throw Error('duplicate volume name in the table');
  if(lines.length>256)throw Error('too many model volumes');
  return lines.length?lines.join('\n')+'\n':'';
}
export function parseTable(text){
  if(typeof text!=='string'||(text&&!text.endsWith('\n')))throw Error('malformed model volume table');
  const out=new Map();
  for(const line of text.split('\n').slice(0,-1)){
    const f=line.split(' ');
    if(f.length!==11)throw Error('malformed model volume table line');
    const [name,root,salt,dbs,hbs,db,hs,ib,preload,graph,pin]=f;
    const num=s=>/^[1-9][0-9]{0,15}$/.test(s)?Number(s):NaN;
    const verity={alg:'sha256',root,salt,dataBlockSize:num(dbs),hashBlockSize:num(hbs),dataBlocks:num(db),hashStartBlock:num(hs)};
    try{validateCore(name,verity,num(ib),preload,graph);}catch(e){throw Error('model volume table: '+name+': '+e.message);}
    if(!HEX.test(pin)||out.has(name))throw Error('model volume table: bad pin or duplicate '+name);
    out.set(name,{name,verity,imageBytes:num(ib),preload,graph,pin});
  }
  return out;
}

// ---- publisher: a built volume -> manifest + chunks -----------------------------------------------------------------

// volDir holds metal/volumes.mjs output (volume.json + volume.img). Writes <outDir>/<sha256> for every chunk and the
// manifest, and returns {pin, manifest}. Chunk files are content-named, so publishing is copying the directory to any
// replica (a raw-artifact gateway serving GET /<CIDv1 of sha256>).
export async function buildDistribution(volDir,outDir,{chunkBytes=CHUNK_BYTES}={}){
  const vol=JSON.parse(await fs.readFile(path.join(volDir,'volume.json'),'utf8'));
  const img=path.join(volDir,vol.image||'volume.img');
  const st=await fs.stat(img);
  if(st.size!==vol.imageBytes)throw Error('volume.img is not the size volume.json states');
  await fs.mkdir(outDir,{recursive:true});
  const whole=createHash('sha256'),chunks=[];
  const fh=await fs.open(img,'r');
  try{
    for(let off=0;off<st.size;off+=chunkBytes){
      const n=Math.min(chunkBytes,st.size-off),buf=Buffer.allocUnsafe(n);
      let got=0;while(got<n){const {bytesRead}=await fh.read(buf,got,n-got,off+got);if(!bytesRead)throw Error('short read');got+=bytesRead;}
      whole.update(buf);const d=sha(buf);chunks.push({sha256:d,size:n});
      const p=path.join(outDir,d);
      try{await fs.writeFile(p,buf,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
    }
  }finally{await fh.close();}
  const {preload,graph}=preloadOf(vol);
  const v=vol.verity;
  const manifest={format:DIST_FORMAT,name:vol.name,verity:{alg:v.alg,root:v.root,salt:v.salt,dataBlockSize:v.dataBlockSize,
    hashBlockSize:v.hashBlockSize,dataBlocks:v.dataBlocks,hashStartBlock:v.hashStartBlock},imageBytes:st.size,
    imageSha256:whole.digest('hex'),chunkBytes,chunks,preload,graph};
  const {bytes,pin}=encodeManifest(manifest);
  try{await fs.writeFile(path.join(outDir,pin),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  return {pin,manifest};
}

// ---- host: cold fetch from replicas ---------------------------------------------------------------------------------

// Fetch a pinned volume into store/<name>/ (volume.img + volume.json, metal/volumes.mjs layout) through `artifacts`
// (a RawArtifacts: any of its replicas, each object digest-checked). Never merges into an existing volume; a failure
// leaves nothing behind. The table entry (parseTable) is the authority: the manifest must state the same name, root
// and geometry, so a replica cannot swap the model even with a self-consistent manifest of its own.
export async function fetchVolume({artifacts,entry,store,concurrency=2}){
  const final=path.join(store,entry.name);
  try{await fs.access(final);throw Object.assign(Error('volume '+entry.name+' is already in the store'),{code:'EEXIST'});}catch(e){if(e.code!=='ENOENT')throw e;}
  const work=path.join(store,'.fetch-'+entry.name+'-'+randomBytes(6).toString('hex'));
  await fs.mkdir(work,{mode:0o700,recursive:false});
  try{
    const mfile=path.join(work,'manifest.json');
    await artifacts.get(entry.pin,mfile,{maxBytes:2*1024*1024});
    const m=decodeManifest(await fs.readFile(mfile),entry.pin);
    if(m.name!==entry.name||canonical(m.verity)!==canonical(entry.verity)||m.imageBytes!==entry.imageBytes||m.preload!==entry.preload||m.graph!==entry.graph)
      throw Error('the manifest behind the pin is not the table\'s volume');
    // chunks land as their own files first (each verified by RawArtifacts), then are appended in order
    const parts=m.chunks.map((c,i)=>path.join(work,'chunk.'+i));
    let next=0,failure;
    await Promise.allSettled(Array.from({length:Math.min(concurrency,m.chunks.length)},async()=>{
      while(!failure&&next<m.chunks.length){const i=next++;
        try{await artifacts.get(m.chunks[i].sha256,parts[i],{size:m.chunks[i].size,maxBytes:Math.max(m.chunks[i].size,1)});}catch(e){failure=e;throw e;}}
    }));
    if(failure)throw failure;
    const img=path.join(work,'volume.img'),whole=createHash('sha256');
    const out=await fs.open(img,'wx',0o644);
    try{
      for(const p of parts){
        for await(const b of createReadStream(p)){whole.update(b);await out.write(b);}
        await fs.rm(p);
      }
      await out.sync();
    }finally{await out.close();}
    if(whole.digest('hex')!==m.imageSha256)throw Error('assembled image digest mismatch');
    const vol={name:m.name,fs:'ext4',builtBy:'sdk/storage/model-volumes.mjs fetch',image:'volume.img',imageBytes:m.imageBytes,
      verity:{...m.verity,hashOffset:m.verity.dataBlocks*m.verity.dataBlockSize},preload:m.preload,graph:m.graph,distPin:entry.pin,
      sd:m.preload==='sd',gguf:m.preload==='ggml'?m.graph:null,
      receipts:artifacts.receipts?.map(r=>({sha256:r.sha256,origin:r.origin}))};
    await fs.writeFile(path.join(work,'volume.json'),JSON.stringify(vol,null,2)+'\n',{flag:'wx'});
    await fs.rm(mfile);
    await fs.rename(work,final);
    return vol;
  }catch(e){await fs.rm(work,{recursive:true,force:true});throw e;}
}

// ---- Windows partitions: the same image as a FIXED VHD -----------------------------------------------------------
// Hyper-V attaches disks as VHD/VHDX files. A fixed VHD is the raw disk followed by one 512-byte footer (Microsoft's
// "Virtual Hard Disk Image Format Specification", footer and CHS rules), so the guest sees exactly the volume's bytes
// and its dm-verity tree; the footer is not part of what the guest reads or verifies. It is written reproducibly: time
// stamp 0, creator "encl", and the unique id taken from the volume's root, so one volume always gives the same file.
export const VHD_FOOTER_BYTES=512;
function vhdGeometry(size){
  let total=Math.floor(size/512);
  if(total>65535*16*255)total=65535*16*255;
  let spt,heads,cth;
  if(total>=65535*16*63){spt=255;heads=16;cth=Math.floor(total/spt);}
  else{
    spt=17;cth=Math.floor(total/spt);heads=Math.max(4,Math.floor((cth+1023)/1024));
    if(cth>=heads*1024||heads>16){spt=31;heads=16;cth=Math.floor(total/spt);}
    if(cth>=heads*1024){spt=63;heads=16;cth=Math.floor(total/spt);}
  }
  return {cylinders:Math.floor(cth/heads),heads,spt};
}
export function vhdFooter(size,uniqueId){
  if(!Number.isSafeInteger(size)||size<=0||size%512)throw Error('a VHD disk size must be a positive multiple of 512');
  if(!Buffer.isBuffer(uniqueId)||uniqueId.length!==16)throw Error('a VHD unique id is 16 bytes');
  const f=Buffer.alloc(VHD_FOOTER_BYTES);
  f.write('conectix',0,'ascii');
  f.writeUInt32BE(2,8);                        // features: the reserved bit, always set
  f.writeUInt32BE(0x00010000,12);              // format version 1.0
  f.writeBigUInt64BE(0xFFFFFFFFFFFFFFFFn,16);  // data offset: none, a fixed disk
  f.writeUInt32BE(0,24);                       // time stamp
  f.write('encl',28,'ascii');                  // creator application
  f.writeUInt32BE(0x00010000,32);              // creator version
  f.write('Wi2k',36,'ascii');                  // creator host OS
  f.writeBigUInt64BE(BigInt(size),40);         // original size
  f.writeBigUInt64BE(BigInt(size),48);         // current size
  const g=vhdGeometry(size);
  f.writeUInt16BE(g.cylinders,56);f.writeUInt8(g.heads,58);f.writeUInt8(g.spt,59);
  f.writeUInt32BE(2,60);                       // disk type: fixed
  uniqueId.copy(f,68);
  let sum=0;for(const b of f)sum+=b;
  f.writeUInt32BE((~sum)>>>0,64);
  return f;
}
// -> {size, fixed} for a footer this module would accept, or throws
export function readVhdFooter(f){
  if(!Buffer.isBuffer(f)||f.length!==VHD_FOOTER_BYTES||f.toString('ascii',0,8)!=='conectix')throw Error('not a VHD footer');
  const c=Buffer.from(f);c.writeUInt32BE(0,64);let sum=0;for(const b of c)sum+=b;
  if(((~sum)>>>0)!==f.readUInt32BE(64))throw Error('VHD footer checksum mismatch');
  const size=Number(f.readBigUInt64BE(48));
  if(f.readUInt32BE(60)!==2||f.readBigUInt64BE(16)!==0xFFFFFFFFFFFFFFFFn)throw Error('not a fixed VHD');
  return {size,fixed:true};
}
// store/<name>/volume.vhd from volume.img: the image's bytes, then the footer; written beside and renamed into place
export async function writeFixedVhd(volDir){
  const vol=JSON.parse(await fs.readFile(path.join(volDir,'volume.json'),'utf8'));
  const img=path.join(volDir,vol.image||'volume.img'),out=path.join(volDir,'volume.vhd'),tmp=out+'.tmp-'+randomBytes(4).toString('hex');
  const st=await fs.stat(img);
  if(st.size!==vol.imageBytes)throw Error('the image is not its record\'s size');
  const fh=await fs.open(tmp,'wx',0o644);
  try{
    for await(const b of createReadStream(img))await fh.write(b);
    await fh.write(vhdFooter(st.size,Buffer.from(vol.verity.root.slice(0,32),'hex')));
    await fh.sync();
  }catch(e){await fh.close();await fs.rm(tmp,{force:true});throw e;}
  await fh.close();
  await fs.rename(tmp,out);
  return {path:out,bytes:st.size+VHD_FOOTER_BYTES};
}
