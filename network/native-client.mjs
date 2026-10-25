// A client-owned trust profile, signed public records and hardware evidence are
// sufficient to reach an app. No Enclave API, DNS resolution of the app name,
// address-book authority or operator CA participates in this path.
import https from 'node:https';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {PassThrough,Readable,Transform,pipeline} from 'node:stream';
import WebSocket from 'ws';
import {LeaseReader} from './lease-reader.mjs';
import {PublicDirectory} from './public-directory.mjs';
import {DirectoryClient} from './directory-client.mjs';
import {validateNetworkAuthorities} from './network-authorities.mjs';
import {verifyOwnerSignature} from './owner-signature.mjs';
import {recordHash} from './route-record.mjs';
import {probeGuest} from './guest-probe.mjs';
import {DirectHttpsAgent} from './socks-connect.mjs';
import {seedCertChain} from '../relay/snp-verify.mjs';
import {startupExpectation,inlineStartupBytes} from './startup-expectation.mjs';
import {bootstrapIntent} from '../sdk/bootstrap/package.mjs';
import {nativeHostPolicy} from './native-host-policy.mjs';

const ZERO='0x'+'0'.repeat(40);
const identity=l=>recordHash(Object.fromEntries(['id','chainId','deployments','owner','runner','runnerOperator','appRef','configCid'].map(k=>[k,l[k]])));

export class NativeClient {
  // hostAdmission: the platform host policy for the route's lease host (network/host-policy-adapters.mjs leaseHostAdmission)
  constructor(profile,{reader,fetch=globalThis.fetch,probe=probeGuest,now=Date.now,maxConcurrent=4,hostAdmission=null,env=process.env,policyFetch=globalThis.fetch}={}){
    if(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>32)throw Error('native client concurrency must be 1..32');
    // Snapshot all caller inputs: asynchronous proof work must not permit a
    // caller's later mutation to change the expected app or verification policy.
    this.profile=structuredClone(profile);const p=this.profile;
    if(!p||p.version!==1||!/^0x[0-9a-f]{64}$/.test(p.deploymentId||'')||
      !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(p.hostname||'')||
      typeof p.stateDir!=='string'||!path.isAbsolute(p.stateDir)||
      !(p.linux||p.shield&&p.hostSession||p.pvm))throw Error('explicit native client profile required');
    if(p.startup!==undefined){
      if(!p.startup||typeof p.startup!=='object'||Array.isArray(p.startup)||p.expected!==undefined||!p.linux||p.shield||p.pvm||p.hostSession||
        Object.keys(p.startup).some(k=>!['gateways','packageBase64'].includes(k)))throw Error('owner startup requires an unambiguous SNP runtime policy');
      this.startupBytes=inlineStartupBytes(p.startup.packageBase64);this.startupCache=null;
      if(this.startupBytes===undefined&&(!Array.isArray(p.startup.gateways)||!p.startup.gateways.length||p.startup.gateways.length>8))throw Error('explicit startup package sources required');
      // Keep first-use artifact discovery independent of any DNS authority too.
      if(p.startup.gateways?.some(raw=>!isIP(new URL(raw).hostname.replace(/^\[|\]$/g,''))))throw Error('native startup requires literal gateway addresses');
    }else if(!p.expected||typeof p.expected.appRef!=='string'||typeof p.expected.configCid!=='string'||
      !/^[0-9a-f]{64}$/.test(p.expected.appSha256||'')||!/^[0-9a-f]{64}$/.test(p.expected.runtimeId||''))throw Error('explicit app expectations or owner startup required');
    this.pins=validateNetworkAuthorities(p.authorityPins);
    if(p.linux?.vcekBase64)p.linux.vcek=Buffer.from(p.linux.vcekBase64,'base64');
    if(p.linux?.certChainPem)seedCertChain(p.linux.product,p.linux.certChainPem);
    this.reader=reader||new LeaseReader({rpc:p.rpc,chainId:p.chainId,addressBook:ZERO,authorityPins:this.pins,includeHostPayout:true,now});
    this.transport=new DirectoryClient({origins:p.directories,fetch});
    // Literal directory origins make the DNS-independent claim enforceable.
    if(this.transport.origins.some(o=>!isIP(new URL(o).hostname.replace(/^\[|\]$/g,''))))throw Error('native discovery requires literal directory addresses');
    // The platform host policy (network/native-host-policy.mjs) is resolved exactly as the CLI resolves it: from the
    // network this profile is pinned to and the operator's existing ENCLAVE_PLATFORM_HOST_POLICY setting. A caller may
    // pass the CLI's own decision function; omitting it (or null) never turns the policy off.
    if(typeof hostAdmission!=='function'){this.hostPolicy=nativeHostPolicy(p,{env,fetch:policyFetch});hostAdmission=this.hostPolicy.off?null:this.hostPolicy.admission;}
    else this.hostPolicy={off:false,source:'caller'};
    this.hostAdmission=hostAdmission;this.pass=null;
    // One decision per resolve pass, shared by the explicit check and the signed-route hook (same lease identity).
    const passDecision=hostAdmission&&(lease=>this.pass&&this.pass.key===identity(lease)?this.pass.decision:this._decideHost(lease));
    this.now=now;this.probe=probe;this.fetch=fetch;this.operators=new Map();this.tail=Promise.resolve();this.maxConcurrent=maxConcurrent;this.open=0;
    this.directory=new PublicDirectory({directory:path.join(p.stateDir,recordHash({chainId:p.chainId??8453,pins:this.pins,id:p.deploymentId,checkers:p.checkers})),checkers:p.checkers,now,hostAdmission:passDecision,
      leaseOf:async id=>id===p.deploymentId?this.reader.get(id):null,
      hostOperator:async id=>{
        if(!this.operators.has(id))this.operators.set(id,this.reader.registryEntries(this.pins.registry,[id]).then(([h])=>h?.active?h.operator:null));
        return this.operators.get(id);
      },
      verifyOwner:(owner,message,signature)=>verifyOwnerSignature({reader:this.reader,owner,message,signature,sessionVaultFactory:this.pins.sessionVaultFactory})});
  }
  currentLease(){
    const p=this.profile,l=this.reader.get(p.deploymentId);
    if(!l||!l.active||!l.isPublic||l.validUntil<=this.now()||l.leaseUntil<=this.now()||
      l.chainId!==(p.chainId??8453)||l.deployments.toLowerCase()!==this.pins.deployments||
      p.expected&&(l.appRef!==p.expected.appRef||l.configCid!==p.expected.configCid))throw Error('no current lease matching the pinned application');
    return l;
  }
  async resolve(){
    const p=this.profile;
    await this.reader.refresh([p.deploymentId]);const startLease=this.currentLease();this.operators.clear();
    return this._withHostDecision(startLease,'platform host policy refused the route host: ',()=>this._resolveFrom(startLease));
  }
  async _resolveFrom(startLease){
    const p=this.profile;
    let expected=p.expected,provenance={source:'caller-pinned'};
    if(p.startup){
      const intent=bootstrapIntent(startLease.configCid);
      const cached=this.startupCache?.sha256===intent?.sha256?this.startupCache.bytes:undefined;
      const derived=await startupExpectation(startLease,{runtime:p.linux.runtime,gateways:p.startup.gateways,bytes:this.startupBytes??cached,fetchImpl:this.fetch});
      expected=derived.expected;provenance=derived.provenance;this.startupCache={sha256:provenance.sha256,bytes:derived.bytes};
    }
    if(!await this._importRecords())throw Error('no public record snapshot available');
    const routes=(await this.directory.routes()).deployments[p.deploymentId],lease=this.currentLease();
    if(!routes?.httpsRoutes?.length||routes.expiresAt<=this.now())throw Error('no current verified route');
    if(identity(startLease)!==identity(lease))throw Error('deployment changed during expectation verification');
    return {routes,lease,expected,provenance};
  }
  async _importRecords(){
    const p=this.profile,answers=await this.transport.read('/v1/network/records');
    let validSnapshots=0;
    for(const {value} of answers){
      if(value?.version!==1||!['providers','policies','publications'].every(k=>Array.isArray(value[k])&&value[k].length<=4096))continue;
      // Full deployment IDs prevent short-label collisions. Do not import any
      // other deployment's policy, route, owner or application expectation.
      await this.directory.import({...value,
        providers:value.providers.filter(e=>e&&typeof e==='object'&&e.record).map(e=>({record:e.record,qualifications:Array.isArray(e.qualifications)?e.qualifications:[]})),
        policies:value.policies.filter(e=>e?.policy?.deploymentId===p.deploymentId),
        publications:value.publications.filter(e=>e?.bundle?.record?.deploymentId===p.deploymentId)});
      validSnapshots++;
    }
    return validSnapshots;
  }
  // One application request: discovery, fresh proof, revalidation, then ONE send.
  // Buffered; resolves after the whole bounded response (the GET/HEAD result shape).
  request(options={}){
    return this._enqueue(()=>ownRequest(options,false),(input,release)=>this._open(input,release)).then(async handle=>{
      if(!handle.body)return {...handle.result,body:Buffer.alloc(0)};
      const chunks=[];
      try{for await(const chunk of handle.body)chunks.push(chunk);}
      catch(e){throw Error(e.message);}
      return {...handle.result,body:Buffer.concat(chunks)};
    });
  }
  // The same authorization and single send, resolving as soon as response headers
  // arrive. `body` is a Readable delivering bytes as they come (SSE, incremental
  // chat): async-iterate or pipe it; it applies backpressure to the guest.
  stream(options={}){
    return this._enqueue(()=>ownRequest(options,true),(input,release)=>this._open(input,release))
      .then(handle=>({...handle.result,body:handle.body,cancel:handle.cancel,closed:handle.closed}));
  }
  // One WebSocket: the same discovery, proof, revalidation and handshake check, then
  // ONE upgrade request on the verified connection. It never reconnects; a new
  // connection is a new call, with fresh discovery, proof and credentials.
  websocket(options={}){
    return this._enqueue(()=>snapshotSocket(options),(input,release)=>this._openSocket(input,release));
  }
  // Discovery, proof and connection setup are serialized per client, so a second
  // request cannot replace the lease context while the first attests. The queue is
  // released once response headers arrive; open responses are bounded separately.
  // A streamed upload body belongs to the client once passed: it is read only after
  // the guest key is verified, and destroyed unless it was sent to its end.
  _enqueue(snapshot,open){
    let input;
    try{input=snapshot();}catch(e){return Promise.reject(e);}
    if(this.open>=this.maxConcurrent){input.source?.destroy();return Promise.reject(Error('too many open native requests'));}
    this.open++;let released=false;const release=()=>{if(!released){released=true;this.open--;}};
    const run=this.tail.then(()=>open(input,release));
    this.tail=run.then(()=>{},()=>{});
    return run.catch(e=>{release();input.source?.destroy();throw e;});
  }
  async _authorize(signal){
    const cancelled=()=>{if(signal?.aborted)throw Error('native request cancelled before sending');};
    cancelled();
    const p=this.profile,initial=await this.resolve(),fingerprint=identity(initial.lease);
    let chosen,proof,proofStarted;const failures=[];
    for(const route of initial.routes.httpsRoutes){
      cancelled();
      if(!isIP(route.address)||route.port!==443)continue;
      try{
        proofStarted=this.now();
        proof=await this.probe({deploymentId:p.deploymentId,hostname:p.hostname,address:route.address,port:route.port,
          direct:true,attestationBootstrap:true,expected:initial.expected,linux:p.linux,shield:p.shield,hostSession:p.hostSession,pvm:p.pvm});
        if(proof?.verified!==true||proof.ready!==true||proof.deploymentId!==p.deploymentId||proof.appSha256!==initial.expected.appSha256||proof.runtimeId!==initial.expected.runtimeId||
          !/^[0-9a-f]{64}$/.test(proof.spkiSha256||''))throw Error('fresh bound guest proof required');
        chosen=route;break;
      }catch(e){failures.push(String(e.message).slice(0,200));}
    }
    if(!chosen)throw Error('all attestation routes refused: '+failures.join('; '));
    // Attestation may take seconds. Read signed records and chain state again;
    // a withdrawal, reassignment or app change must prevent application bytes.
    const current=await this.resolve();
    if(identity(current.lease)!==fingerprint||!current.routes.httpsRoutes.some(r=>recordHash(r)===recordHash(chosen)))throw Error('deployment changed during attestation');
    cancelled();
    // A deadline for STARTING a send, never a claim about later ownership.
    const validUntil=Math.min(current.routes.expiresAt,current.lease.validUntil,proofStarted+60000);
    // Checked on the handshake, before Node may write the request line, headers,
    // credentials or body: the agent hands over the socket only after this returns.
    const verified=new WeakSet();
    const agent=new DirectHttpsAgent({tlsOptions:{rejectUnauthorized:false},verifyPeer:connection=>{
      if(signal?.aborted)throw Error('native request cancelled before sending');
      if(validUntil<=this.now()||identity(this.currentLease())!==fingerprint)throw Error('native authorization expired');
      const key=connection.getPeerX509Certificate()?.publicKey.export({format:'der',type:'spki'});
      if(!key||createHash('sha256').update(key).digest('hex')!==proof.spkiSha256)throw Error('guest TLS key changed');
      verified.add(connection);
    }});
    return {agent,verified,fingerprint,chosen,result:{route:chosen,proof,expectation:current.provenance,leaseBlock:current.lease.blockNumber,validUntil}};
  }
  // The shared decision never throws; a throwing caller function is a refusal too.
  async _decideHost(lease){
    try{return await this.hostAdmission(lease);}
    catch(e){return {admit:false,status:'unreadable',reason:'platform host policy unreadable: '+String(e?.message).slice(0,200)};}
  }
  // Before records, proofs, upgrades, credentials or bodies: anything but an explicit admit refuses. Callers run in
  // the per-client queue, so one pass decision cannot leak into another pass.
  async _withHostDecision(lease,prefix,work){
    if(!this.hostAdmission)return work();
    const decision=this._decideHost(lease);this.pass={key:identity(lease),decision};
    try{
      const a=await decision;
      if(!a||a.admit!==true)throw Object.assign(Error(prefix+String(a?.reason||'no decision').slice(0,300)),{code:'host_policy_refused',status:a?.status??null});
      return await work();
    }finally{this.pass=null;}
  }
  // Long-lived transfers (streamed responses and uploads, WebSockets) are cut once the
  // chain no longer shows the same current deployment (owner, runner, app,
  // configuration, lease), once the signed records no longer publish the attested
  // route, or once either can no longer be confirmed. A check never extends the send
  // authorization, and runs in the per-client queue so it cannot race a new proof.
  _watch(fingerprint,route,recheckMs,cut){
    let stopped=false,pending=false;
    const timer=setInterval(()=>{
      if(pending)return;pending=true;
      const check=this.tail.then(()=>stopped||this._stillCurrent(fingerprint,route));
      this.tail=check.then(()=>{},()=>{});
      check.then(()=>{pending=false;},e=>{pending=false;if(!stopped)cut(e);});
    },recheckMs);
    return ()=>{stopped=true;clearInterval(timer);};
  }
  async _stillCurrent(fingerprint,route){
    const id=this.profile.deploymentId;
    await this.reader.refresh([id]).catch(()=>{});
    try{if(identity(this.currentLease())!==fingerprint)throw Error();}
    catch{throw Error('native authorization ended: deployment is not confirmed current');}
    // A ban anchored after the proof ends open streams, uploads and sockets at the next check.
    const routes=await this._withHostDecision(this.currentLease(),'native authorization ended: platform host policy refused the host: ',async()=>{
      // An unreachable directory leaves the stored signed records, which expire on their own.
      await this._importRecords().catch(()=>{});
      return (await this.directory.routes()).deployments[id];
    });
    if(!routes||routes.expiresAt<=this.now()||!routes.httpsRoutes?.some(r=>recordHash(r)===recordHash(route)))
      throw Error('native authorization ended: the attested route is no longer published');
  }
  async _open({path:requestPath,method,headers,body,source,bodyLength,maxRequestBytes,signal,maxBytes,timeoutMs,idleTimeoutMs,maxDurationMs,recheckMs,streaming},release){
    const p=this.profile,{agent,verified,fingerprint,chosen,result}=await this._authorize(signal);
    return new Promise((resolve,reject)=>{
      let settled=false,out=null,idle=null,unwatch=null,finished=false,uploaded=!source,uploadIdle=null,headerTimer=null,closedResolve;
      const closed=new Promise(r=>closedResolve=r),timers=[];
      const finish=error=>{
        if(finished)return;finished=true;
        for(const t of timers)clearTimeout(t);clearTimeout(idle);clearTimeout(uploadIdle);clearTimeout(headerTimer);unwatch?.();
        signal?.removeEventListener('abort',onAbort);req.destroy();agent.destroy();release();
        if(!uploaded)source.destroy();
        closedResolve({bytes:size,error:error?error.message:null});
      };
      const fail=error=>{
        if(!settled){settled=true;finish(error);reject(error);}
        else if(out&&!out.destroyed)out.destroy(error);
        else finish(error);
      };
      const onAbort=()=>fail(Error(settled?'native stream cancelled':'native request cancelled'));
      let size=0,deadline=Date.now()+timeoutMs;
      const armHeaders=()=>{clearTimeout(headerTimer);deadline=Date.now()+timeoutMs;headerTimer=setTimeout(()=>fail(Error('native request timeout')),timeoutMs);};
      // host is a literal address. servername/Host only select a virtual app;
      // they are never resolved and are never accepted as proof of identity.
      const req=https.request({host:chosen.address,port:chosen.port,servername:p.hostname,path:requestPath,method,
        headers:{...headers,host:p.hostname,...(body?{'content-length':String(body.length)}:bodyLength!==undefined?{'content-length':String(bodyLength)}:{})},agent},res=>{
        clearTimeout(headerTimer);
        // A guest may answer before a streamed upload ends; a buffered answer then
        // gets its own full timeout.
        if(!uploaded)deadline=Date.now()+timeoutMs;
        if(!streaming)timers.push(setTimeout(()=>fail(Error('native request timeout')),Math.max(0,deadline-Date.now())));
        const empty=method==='HEAD'||res.statusCode===204||res.statusCode===304;
        const limiter=new Transform({transform(chunk,_encoding,callback){
          size+=chunk.length;if(size>maxBytes)return callback(Error('native response too large'));
          if(streaming)armIdle();callback(null,chunk);
        }});
        out=new PassThrough({highWaterMark:64*1024});
        // A consumer that never listens for errors must not crash the process;
        // iterators and pipes still receive the error.
        out.on('error',()=>{});
        const armIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>out.destroy(Error('native stream idle timeout')),idleTimeoutMs);};
        if(streaming){
          armIdle();timers.push(setTimeout(()=>out.destroy(Error('native stream duration limit')),maxDurationMs));
          unwatch??=this._watch(fingerprint,chosen,recheckMs,fail);
        }
        pipeline(res,limiter,out,error=>finish(error));
        if(empty&&!streaming)out.resume();
        settled=true;
        resolve({result:{...result,status:res.statusCode,headers:res.headers},body:empty&&!streaming?null:out,
          cancel:reason=>{if(!out.destroyed)out.destroy(Error(typeof reason==='string'?reason.slice(0,200):'native stream cancelled'));},closed});
      });
      armHeaders();
      req.once('error',error=>fail(error));
      signal?.addEventListener('abort',onAbort,{once:true});
      // One send. A transport failure after this point is reported, never retried:
      // the guest may already have acted on the request.
      if(!source)return req.end(body||undefined);
      // A streamed body is pulled only once the agent hands over the verified
      // socket, one chunk at a time: a chunk is read after the previous one drained.
      req.once('socket',socket=>{
        if(!verified.has(socket))return fail(Error('native transport not verified'));
        clearTimeout(headerTimer);
        timers.push(setTimeout(()=>fail(Error('native upload duration limit')),maxDurationMs));
        unwatch=this._watch(fingerprint,chosen,recheckMs,fail);
        pump().catch(e=>{if(!finished)fail(/^native /.test(e?.message)?e:Error('native upload source failed: '+String(e?.message).slice(0,200)));});
      });
      const armUpload=()=>{clearTimeout(uploadIdle);uploadIdle=setTimeout(()=>fail(Error('native upload idle timeout')),idleTimeoutMs);};
      const drained=()=>new Promise(r=>{const done=()=>{req.off('drain',done);req.off('close',done);r();};req.on('drain',done);req.on('close',done);});
      const pump=async()=>{
        let sent=0;armUpload();
        for await(const chunk of source){
          if(finished)return;
          const bytes=bytesOf(chunk,'native upload chunks must be bytes or strings');
          sent+=bytes.length;
          if(sent>maxRequestBytes||bodyLength!==undefined&&sent>bodyLength)throw Error('native request body too large');
          armUpload();
          if(!req.write(bytes))await drained();
          if(finished)return;
          armUpload();
        }
        if(finished)return;
        if(bodyLength!==undefined&&sent!==bodyLength)throw Error('native upload ended before its declared length');
        clearTimeout(uploadIdle);uploaded=true;
        if(!settled)armHeaders();
        req.end();
      };
    });
  }
  async _openSocket({path:socketPath,headers,protocols,signal,timeoutMs,idleTimeoutMs,maxDurationMs,recheckMs,maxMessageBytes,maxBufferedBytes,maxQueuedBytes,maxBytes,maxSentBytes},release){
    const p=this.profile,{agent,verified,fingerprint,chosen,result}=await this._authorize(signal);
    const host=isIP(chosen.address)===6?'['+chosen.address+']':chosen.address;
    return new Promise((resolve,reject)=>{
      let settled=false,finished=false,failure=null,idle=null,unwatch=null,wake=null,reading=false,bytesIn=0,bytesOut=0,queued=0,ws,closedResolve;
      const queue=[],pongs=[],timers=[],closed=new Promise(r=>closedResolve=r);
      const finish=(error,code=1006,reason='')=>{
        if(finished)return;finished=true;failure??=error||null;
        for(const t of timers)clearTimeout(t);clearTimeout(idle);unwatch?.();
        signal?.removeEventListener('abort',onAbort);
        try{ws?.terminate();}catch{}
        agent.destroy();release();
        for(const x of pongs.splice(0))x.reject(Error('native websocket closed'));
        wake?.();
        if(!settled){settled=true;reject(failure||Error('native websocket closed before opening'));}
        closedResolve({code,reason,error:failure?failure.message:null,bytesIn,bytesOut});
      };
      const fail=error=>finish(error);
      const onAbort=()=>fail(Error(settled?'native websocket cancelled':'native request cancelled'));
      const armIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>fail(Error('native websocket idle timeout')),idleTimeoutMs);};
      const open=()=>!finished&&ws.readyState===WebSocket.OPEN;
      const send=(data,{binary}={})=>{
        try{
          if(!open())throw Error('native websocket is not open');
          const text=typeof data==='string',bytes=bytesOf(data,'native websocket messages must be bytes or strings'),asBinary=binary===undefined?!text:binary;
          if(typeof asBinary!=='boolean')throw Error('native websocket binary flag must be boolean');
          if(bytes.length>maxMessageBytes)throw Error('native websocket message too large');
          if(bytesOut+bytes.length>maxSentBytes)throw Error('native websocket send limit reached');
          if(ws.bufferedAmount+bytes.length>maxBufferedBytes)throw Error('native websocket send buffer full; await earlier sends');
          bytesOut+=bytes.length;armIdle();
          // Resolves once the frame is written to the verified connection; that is
          // not an application acknowledgement. A failed send is never repeated.
          return new Promise((ok,no)=>ws.send(bytes,{binary:asBinary},e=>e?no(Error('native websocket closed; delivery of this message is unknown')):ok()));
        }catch(e){return Promise.reject(e);}
      };
      const ping=(data='')=>{
        try{
          if(!open())throw Error('native websocket is not open');
          const bytes=bytesOf(data,'native websocket ping data must be bytes or a string');
          if(bytes.length>125)throw Error('native websocket ping too large');
          return new Promise((ok,no)=>{pongs.push({resolve:ok,reject:no});armIdle();ws.ping(bytes,undefined,()=>{});});
        }catch(e){return Promise.reject(e);}
      };
      const close=(code=1000,reason='')=>{
        if(open()){
          if(!(code===1000||Number.isInteger(code)&&code>=3000&&code<=4999)||typeof reason!=='string'||Buffer.byteLength(reason)>123)return Promise.reject(Error('invalid native websocket close'));
          ws.close(code,reason);   // ws terminates the connection if the guest never answers the close
        }else if(!finished&&ws.readyState!==WebSocket.CLOSING)fail(Error('native websocket cancelled'));
        return closed;
      };
      const next=async()=>{
        if(reading)throw Error('native websocket messages have one reader');
        reading=true;
        try{
          for(;;){
            if(queue.length){
              const m=queue.shift();queued-=m.data.length;
              if(ws.isPaused&&queued<=maxQueuedBytes&&!finished)ws.resume();
              return {value:m,done:false};
            }
            if(finished){if(failure)throw failure;return {value:undefined,done:true};}
            await new Promise(r=>wake=r);wake=null;
          }
        }finally{reading=false;}
      };
      const iterator={next,return:async()=>{if(!finished)close();return {value:undefined,done:true};},[Symbol.asyncIterator](){return this;}};
      const handle={...result,status:101,headers:null,protocol:'',send,ping,close,closed,
        cancel:reason=>fail(Error(typeof reason==='string'?reason.slice(0,200):'native websocket cancelled')),
        messages:{[Symbol.asyncIterator]:()=>iterator},
        get queuedBytes(){return queued;},get bufferedAmount(){return finished?0:ws.bufferedAmount;}};
      try{
        // host is a literal address; servername/Host only select the virtual app. No
        // compression (bounded memory per frame), no redirects (credentials stay here).
        ws=new WebSocket('wss://'+host+':'+chosen.port+socketPath,protocols,{agent,servername:p.hostname,headers:{...headers,host:p.hostname},
          perMessageDeflate:false,followRedirects:false,maxPayload:maxMessageBytes,handshakeTimeout:timeoutMs,autoPong:true,skipUTF8Validation:false});
      }catch(e){return fail(Error('native websocket refused: '+String(e.message).slice(0,200)));}
      timers.push(setTimeout(()=>fail(Error('native websocket handshake timeout')),timeoutMs));
      signal?.addEventListener('abort',onAbort,{once:true});
      ws.on('error',e=>fail(/^native /.test(e?.message)?e:Error('native websocket error: '+String(e?.message).slice(0,200))));
      ws.on('unexpected-response',(_request,res)=>{
        const e=Error('native websocket refused: HTTP '+res.statusCode);e.status=res.statusCode;
        res.destroy();fail(e);   // redirects are not followed; the body is not read
      });
      // ws validates the 101 status, Upgrade, Sec-WebSocket-Accept, the chosen
      // subprotocol and the absence of unrequested extensions before 'open'.
      ws.once('upgrade',res=>{if(!verified.has(res.socket))fail(Error('native transport not verified'));else handle.headers=res.headers;});
      ws.once('open',()=>{
        if(finished)return;
        clearTimeout(timers.shift());settled=true;handle.protocol=ws.protocol;
        armIdle();timers.push(setTimeout(()=>fail(Error('native websocket duration limit')),maxDurationMs));
        unwatch=this._watch(fingerprint,chosen,recheckMs,fail);
        resolve(handle);
      });
      ws.on('message',(data,binary)=>{
        if(finished)return;
        bytesIn+=data.length;if(bytesIn>maxBytes)return fail(Error('native websocket received too much'));
        armIdle();queue.push({data,binary});queued+=data.length;
        // A reader that falls behind pauses the connection: backpressure reaches the guest.
        if(queued>maxQueuedBytes&&!ws.isPaused)ws.pause();
        wake?.();
      });
      ws.on('ping',armIdle);
      ws.on('pong',()=>{armIdle();pongs.shift()?.resolve();});
      ws.on('close',(code,reason)=>finish(null,code,reason.toString().slice(0,123)));
    });
  }
}

const METHODS=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'];
const FORBIDDEN=['host','connection','upgrade','content-length','transfer-encoding','proxy-authorization','proxy-connection','keep-alive','te','trailer','expect'];
// The handshake fields are the WebSocket library's, after the same HTTP refusals.
const SOCKET_FORBIDDEN=[...FORBIDDEN,'sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol','sec-websocket-accept'];
const TOKEN=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const bounded=(v,fallback,min,max)=>{const x=v===undefined?fallback:v;if(!Number.isSafeInteger(x)||x<min||x>max)throw Error('native request limit out of range');return x;};
function bytesOf(value,message){
  if(typeof value==='string')return Buffer.from(value,'utf8');
  if(value instanceof ArrayBuffer)return Buffer.from(new Uint8Array(value.slice(0)));
  if(ArrayBuffer.isView(value))return Buffer.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
  throw Error(message);
}
const isStreamBody=b=>b instanceof Readable||typeof ReadableStream!=='undefined'&&b instanceof ReadableStream||typeof b?.[Symbol.asyncIterator]==='function';
function checkPath(value){
  const requestPath=value===undefined?'/':value;
  if(typeof requestPath!=='string'||requestPath.length>8192||!requestPath.startsWith('/')||requestPath.startsWith('//')||/[\x00-\x20\x7f#]/.test(requestPath))throw Error('invalid native request path');
  return requestPath;
}
function checkHeaders(value,forbidden){
  const headers=value===undefined?{}:value;
  if(!headers||Array.isArray(headers)||typeof headers!=='object'||Object.keys(headers).length>100)throw Error('invalid native request headers');
  const seen=new Set();let headerBytes=0;
  for(const [name,v0]of Object.entries(headers)){
    const lower=name.toLowerCase();
    if(!TOKEN.test(name)||forbidden.includes(lower)||seen.has(lower))throw Error('forbidden or duplicate native request header');
    seen.add(lower);
    for(const v of Array.isArray(v0)?v0:[v0]){
      if(typeof v!=='string'||/[\x00\r\n]/.test(v))throw Error('invalid native request header value');
      headerBytes+=name.length+v.length;
    }
  }
  if(headerBytes>64*1024)throw Error('native request headers too large');
  return headers;
}
// Refused input still ends a streamed body the caller handed over.
function ownRequest(options,streaming){
  try{return snapshotRequest(options,streaming);}
  catch(e){
    const b=options?.body;
    try{if(b instanceof Readable)b.destroy();else if(typeof ReadableStream!=='undefined'&&b instanceof ReadableStream)b.cancel().catch(()=>{});else if(typeof b?.return==='function')Promise.resolve(b.return()).catch(()=>{});}catch{}
    throw e;
  }
}
// Copy everything the caller supplied, synchronously: later mutation of their
// headers or body buffer cannot change what is sent. The signal is kept by
// reference on purpose; it is the caller's live cancellation channel. So is a
// streamed body, which cannot be copied: it is read once, after verification.
function snapshotRequest(options,streaming){
  if(!options||typeof options!=='object'||Array.isArray(options))throw Error('native request options required');
  const {body:rawBody,signal,...plain}=options;
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw Error('signal must be an AbortSignal');
  const o=structuredClone(plain);
  const known=['path','method','headers','maxBytes','maxRequestBytes','bodyLength','timeoutMs','idleTimeoutMs','maxDurationMs','recheckMs'];
  if(Object.keys(o).some(k=>!known.includes(k)))throw Error('unknown native request option');
  const method=o.method===undefined?'GET':o.method,requestPath=checkPath(o.path);
  if(!METHODS.includes(method))throw Error('unsupported native request method');
  const headers=checkHeaders(o.headers,FORBIDDEN);
  const present=rawBody!==undefined&&rawBody!==null,streamed=present&&typeof rawBody!=='string'&&!ArrayBuffer.isView(rawBody)&&!(rawBody instanceof ArrayBuffer)&&isStreamBody(rawBody);
  const maxRequestBytes=streamed?bounded(o.maxRequestBytes,64*1024*1024,0,1024*1024*1024):bounded(o.maxRequestBytes,8*1024*1024,0,64*1024*1024);
  if(o.bodyLength!==undefined&&!streamed)throw Error('native bodyLength applies only to a streamed body');
  const bodyLength=o.bodyLength===undefined?undefined:bounded(o.bodyLength,0,0,maxRequestBytes);
  let body=null,source=null;
  if(present){
    if(method==='GET'||method==='HEAD')throw Error('GET and HEAD carry no native request body');
    if(streamed)source=rawBody instanceof Readable?rawBody:rawBody instanceof ReadableStream?Readable.fromWeb(rawBody):Readable.from(rawBody);
    else{
      body=bytesOf(rawBody,'native request body must be bytes, a string or a readable stream');
      if(body.length>maxRequestBytes)throw Error('native request body too large');
    }
  }
  return {path:requestPath,method,headers,body,source,bodyLength,maxRequestBytes,signal,streaming,
    maxBytes:bounded(o.maxBytes,streaming?64*1024*1024:8*1024*1024,1,streaming?1024*1024*1024:64*1024*1024),
    timeoutMs:bounded(o.timeoutMs,30000,1000,120000),
    idleTimeoutMs:bounded(o.idleTimeoutMs,60000,1000,600000),
    maxDurationMs:bounded(o.maxDurationMs,600000,1000,3600000),
    recheckMs:bounded(o.recheckMs,30000,1000,300000)};
}
function snapshotSocket(options){
  if(!options||typeof options!=='object'||Array.isArray(options))throw Error('native websocket options required');
  const {signal,...plain}=options;
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw Error('signal must be an AbortSignal');
  const o=structuredClone(plain);
  const known=['path','headers','protocols','timeoutMs','idleTimeoutMs','maxDurationMs','recheckMs','maxMessageBytes','maxBufferedBytes','maxQueuedBytes','maxBytes','maxSentBytes'];
  if(Object.keys(o).some(k=>!known.includes(k)))throw Error('unknown native websocket option');
  const socketPath=checkPath(o.path),parsed=new URL(socketPath,'wss://native.invalid');
  // The upgrade goes to exactly the path requested, not a URL-normalized variant.
  if(parsed.pathname+parsed.search!==socketPath)throw Error('native websocket path must be in normalized form');
  const headers=checkHeaders(o.headers,SOCKET_FORBIDDEN),protocols=o.protocols===undefined?[]:o.protocols;
  if(!Array.isArray(protocols)||protocols.length>16||protocols.some(x=>typeof x!=='string'||x.length>256||!TOKEN.test(x))||new Set(protocols).size!==protocols.length)throw Error('invalid native websocket subprotocols');
  const maxMessageBytes=bounded(o.maxMessageBytes,1024*1024,1,64*1024*1024);
  return {path:socketPath,headers,protocols,signal,maxMessageBytes,
    maxBufferedBytes:bounded(o.maxBufferedBytes,Math.max(4*1024*1024,maxMessageBytes),maxMessageBytes,256*1024*1024),
    maxQueuedBytes:bounded(o.maxQueuedBytes,4*1024*1024,1,256*1024*1024),
    maxBytes:bounded(o.maxBytes,256*1024*1024,1,16*1024*1024*1024),
    maxSentBytes:bounded(o.maxSentBytes,256*1024*1024,1,16*1024*1024*1024),
    timeoutMs:bounded(o.timeoutMs,30000,1000,120000),
    idleTimeoutMs:bounded(o.idleTimeoutMs,300000,1000,3600000),
    maxDurationMs:bounded(o.maxDurationMs,3600000,1000,86400000),
    recheckMs:bounded(o.recheckMs,30000,1000,300000)};
}
