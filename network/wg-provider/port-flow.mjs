// The client's side of a port-tunnel flow (isolation/m2/front/tunnel_flow.go has the protocol and the reasons): a UDP
// tunnel over several connections ("lanes") whose two ends report what they received, so live datagrams stay current
// when a connection falls behind instead of queueing behind it.
//
// From the app each data frame is a four-byte sequence number and the datagram; the app's end sends a frame again on
// another lane when the lane that carries it stalls. flowReceiver hands the datagrams on in sequence, once each, and
// waits for a missing one no longer than the reorder time: `reorderMs`, or what the app's end says a second copy
// takes on this path (its repair time, plus a margin), within `reorderMinMs` and `reorderMaxMs`. Most of the time it
// does not wait at all: the app's end covers every few data frames with a parity frame (their XOR, each as its
// two-byte length and its bytes), and with all but one of them here the missing one is made from the rest.
// To the app the datagrams are not numbered. lanePicker keeps them off a lane whose reports are behind, and says to
// drop one when every lane is: an old input event is worth as little as an old picture.
export const FLOW_HEADER='Enclave-Port-Flow',FLOW_REPORT=0xffff,FLOW_REPAIR=0xfffe,FLOW_PARITY=0xfffd,FLOW_SEQ_BYTES=4;
export const flowReport=count=>{const b=Buffer.allocUnsafe(10);b.writeUInt16BE(FLOW_REPORT);b.writeBigUInt64BE(BigInt(count),2);return b;};

// deliver(payload) is called in sequence order. A datagram waits for the ones before it at most `reorderMs` from its
// own arrival, however many are missing. -> {push(seq,payload), parity(first,count,xor), repair(ms), stats(), close()}
export function flowReceiver({deliver,reorderMs=80,reorderMinMs=40,reorderMaxMs=500,repairMarginMs=20,maxHeld=2048,maxSkipped=4096,maxRecent=256,maxParity=64,
  now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 let next=0,timer=null,closed=false;const held=new Map(),skipped=new Set(),st={delivered:0,duplicates:0,skipped:0,late:0,waited:0,rebuilt:0,parity:0,longestWaitMs:0};
 const out=p=>{st.delivered++;deliver(p);};
 // the last datagrams that arrived, by sequence number, and the parity frames that could not be used yet
 const recent=new Map(),waiting=[];
 const keep=(seq,p)=>{recent.set(seq,p);if(recent.size>maxRecent)recent.delete(recent.keys().next().value);};
 // -> true when the group needs this parity no more (all here, or the missing one was made)
 function solve(g){
  let miss=-1;for(let i=0;i<g.count;i++){const s=(g.first+i)>>>0;if(!recent.has(s)){if(miss>=0)return false;miss=s;}}
  if(miss<0)return true;
  const x=Buffer.from(g.xor);
  for(let i=0;i<g.count;i++){const s=(g.first+i)>>>0;if(s===miss)continue;const p=recent.get(s);if(p.length+2>x.length)return true;   // not a frame of this group: nothing to make
   x[0]^=p.length>>8;x[1]^=p.length&255;for(let j=0;j<p.length;j++)x[2+j]^=p[j];}
  const n=x.readUInt16BE(0);if(n+2>x.length)return true;
  st.rebuilt++;accept(miss,x.subarray(2,2+n));return true;
 }
 const flush=()=>{for(let h;(h=held.get(next))!==undefined;){held.delete(next);const w=now()-h.at;if(w>st.longestWaitMs)st.longestWaitMs=w;out(h.p);next=(next+1)>>>0;}};
 // the one that has waited longest decides when to stop waiting (Map order is arrival order)
 const arm=()=>{
  if(timer){clearTimer(timer);timer=null;}
  if(held.size&&!closed)timer=setTimer(due,Math.max(0,held.values().next().value.at+reorderMs-now()));
 };
 // go on from the oldest sequence number that is here, remembering what was passed over
 function giveUp(){
  let least=null,d=0;for(const s of held.keys()){const x=(s-next)|0;if(least===null||x<d){least=s;d=x;}}
  for(let s=next;s!==least;s=(s+1)>>>0){st.skipped++;if(skipped.size>=maxSkipped)skipped.delete(skipped.values().next().value);skipped.add(s);}
  next=least;flush();
 }
 // -> false for a second copy
 function accept(seq,payload){
  const d=(seq-next)|0;
  if(d<0){if(skipped.delete(seq)){st.late++;keep(seq,payload);out(payload);return true;}st.duplicates++;return false;}   // passed over and here after all: still worth sending on
  if(d===0){keep(seq,payload);out(payload);next=(next+1)>>>0;if(held.size){flush();arm();}return true;}
  if(held.has(seq)){st.duplicates++;return false;}
  keep(seq,payload);held.set(seq,{p:payload,at:now()});st.waited++;
  if(held.size>maxHeld)giveUp();
  if(!timer)arm();
  return true;
 }
 function due(){
  timer=null;if(closed)return;
  while(held.size&&held.values().next().value.at+reorderMs<=now())giveUp();
  arm();
 }
 return {
  push(seq,payload){
   if(closed)return;
   if(!accept(seq,payload))return;
   // a datagram that arrived may be the one a waiting parity frame lacked
   for(let i=0;i<waiting.length;){const g=waiting[i];if(((seq-g.first)>>>0)<g.count&&solve(g))waiting.splice(i,1);else i++;}
  },
  // a parity frame: the XOR of data frames first..first+count-1
  parity(first,count,xor){
   if(closed||!Number.isInteger(count)||count<1||count>32||xor.length<2)return;
   st.parity++;
   const g={first:first>>>0,count,xor:Buffer.from(xor)};
   if(solve(g))return;
   waiting.push(g);if(waiting.length>maxParity)waiting.shift();
  },
  // the app's end says how long a second copy takes on this path
  repair(ms){if(!Number.isFinite(ms)||ms<0)return;reorderMs=Math.min(reorderMaxMs,Math.max(reorderMinMs,ms+repairMarginMs));if(timer)arm();},
  // (longestWaitMs: the longest a datagram waited here for the ones before it, since the last call with `reset`)
  stats:({reset=false}={})=>{const r={...st,held:held.size,next,reorderMs};if(reset)st.longestWaitMs=0;return r;},
  close(){closed=true;if(timer)clearTimer(timer);timer=null;held.clear();},
 };
}

// Which lane a datagram to the app goes on. sent(i) after writing one on lane i; report(i,count) when the app's end
// says how many it has received on lane i (false: a count that cannot be). pick() -> lane index, or -1 to drop.
export function lanePicker({now=Date.now,spillMs=10,lateMs=100,startupMs=2000,ring=1024}={}){
 const lanes=[];
 const behind=l=>{
  if(l.closed)return null;const un=l.sent-l.acked;if(!un)return 0;if(un>=ring)return null;
  const age=now()-l.times[l.acked%ring];
  if(l.base===null)return age<=startupMs?0:null;
  return Math.max(0,age-l.base);
 };
 return {
  // -> the lane's index; a removed lane's index is given out again
  add(){const l={sent:0,acked:0,times:new Array(ring).fill(0),base:null,closed:false};const i=lanes.findIndex(x=>x.closed);if(i<0){lanes.push(l);return lanes.length-1;}lanes[i]=l;return i;},
  remove(i){if(lanes[i])lanes[i].closed=true;},
  // the least behind, and of equals (within spillMs all are) the one carrying least
  // `any`: when every open lane is late, the least late one all the same (-1 only when none is open)
  pick({any=false}={}){let best=-1,least=0,load=0;
   for(let i=0;i<lanes.length;i++){let q=behind(lanes[i]);if(q===null||q>lateMs)continue;if(q<spillMs)q=0;const un=lanes[i].sent-lanes[i].acked;if(best<0||q<least||(q===least&&un<load)){best=i;least=q;load=un;}}
   if(best<0&&any)for(let i=0;i<lanes.length;i++){if(lanes[i].closed)continue;const un=lanes[i].sent-lanes[i].acked;if(best<0||un<load){best=i;load=un;}}
   return best;},
  sent(i){const l=lanes[i];l.times[l.sent%ring]=now();l.sent++;},
  report(i,count){
   const l=lanes[i];if(!l||!Number.isSafeInteger(count)||count<l.acked||count>l.sent)return false;if(count===l.acked)return true;
   const d=now()-l.times[(count-1)%ring];
   if(l.base===null||d<l.base)l.base=d;   // the lane's usual delay: the least ever seen
   l.acked=count;return true;
  },
  behind:i=>behind(lanes[i]),
 };
}

// -> a 'data' handler for one lane: onData(seq,payload) for each data frame, onReport(count) for each report,
// onRepair(ms) for each repair time, onParity(first,count,xor) for each parity frame; a frame that is none of them is
// a protocol error (onError).
export function flowDeframer({onData,onReport,onRepair=()=>{},onParity=()=>{},onError,maxFrame=65507}){
 let buf=Buffer.alloc(0);
 return chunk=>{
  buf=buf.length?Buffer.concat([buf,chunk]):chunk;
  while(buf.length>=2){
   const n=buf.readUInt16BE(0);
   if(n===FLOW_PARITY){
    if(buf.length<4)break;const m=buf.readUInt16BE(2);if(m<7)return onError();if(buf.length<4+m)break;
    onParity(buf.readUInt32BE(4),buf[8],buf.subarray(9,4+m));buf=buf.subarray(4+m);continue;
   }
   if(n===FLOW_REPAIR){if(buf.length<6)break;const ms=buf.readUInt32BE(2);buf=buf.subarray(6);onRepair(ms);continue;}
   if(n===FLOW_REPORT){if(buf.length<10)break;const c=buf.readBigUInt64BE(2);buf=buf.subarray(10);if(c>BigInt(Number.MAX_SAFE_INTEGER))return onError();onReport(Number(c));continue;}
   if(n>maxFrame||n<FLOW_SEQ_BYTES)return onError();
   if(buf.length<2+n)break;
   onData(buf.readUInt32BE(2),buf.subarray(2+FLOW_SEQ_BYTES,2+n));buf=buf.subarray(2+n);
  }
 };
}

// How far behind a stream of RTP datagrams is when it leaves this box, read from the datagrams' own headers and nothing
// of their payload. Each has a place in time: its RTP timestamp at 90 kHz (`by:'timestamp'`, video: every packet of a
// frame carries the frame's) or its sequence number for a steady stream (`by:'sequence'`, GameStream audio: one packet
// every 5 ms; the spacing is taken from the stream's first packets and set to the nearest usual one). A packet's
// lateness is its arrival minus its due time, counted from the least late packet the stream has had: so it is what
// the path added beyond its best, and a picture that falls steadily behind shows as lateness that grows. The two
// clocks' drift (some milliseconds in ten minutes) is in it. note(payload) for each datagram handed on; take() -> what
// was seen since the last take ({packets, lost, p50, p95, p99, max}: lateness in ms; lost = sequence numbers that
// never came), or null when nothing that looks like RTP came. `by:'none'` counts packets and losses only (Sunshine's
// video timestamps did not advance at 90 kHz in the first stream measured).
export function rtpLag({by='sequence',now=Date.now,learn=300,spacings=[2.5,5,10,20]}={}){
 let first=null,lastSeq=0,lastX=0,slope=by==='timestamp'?1/90:null,base=Infinity,seen=0,lost=0,lags=[],early=[];
 return {
  note(p){
   if(p.length<12||(p[0]&0xc0)!==0x80)return;
   const s16=p.readUInt16BE(2),t32=p.readUInt32BE(4),at=now();
   if(first===null){first={seq:s16,ts:t32};early=[[0,at]];seen=1;if(slope!==null)base=at;return;}
   // the 16-bit sequence number and the 32-bit timestamp, each unwrapped around the last one seen
   const seq=lastSeq+(((s16-((first.seq+lastSeq)&0xffff))<<16)>>16);
   if(seq>lastSeq){lost+=seq-lastSeq-1;lastSeq=seq;}else if(lost>0)lost--;
   let x=seq;
   if(by==='timestamp'){x=lastX+((t32-((first.ts+lastX)>>>0))|0);if(x>lastX)lastX=x;}
   seen++;
   if(by==='none')return;   // counted only
   if(slope===null){
    // the spacing: from the first and the last of the first packets, set to a usual one when it is within a tenth
    early.push([x,at]);if(early.length<learn)return;
    const a=early[0],b=early[early.length-1];if(b[0]<=a[0]){early=[b];return;}
    const raw=(b[1]-a[1])/(b[0]-a[0]);slope=spacings.find(v=>Math.abs(raw-v)<=v/10)??raw;
    for(const [q,t] of early)base=Math.min(base,t-q*slope);early=null;return;
   }
   const due=at-x*slope;if(due<base)base=due;
   lags.push(due-base);
  },
  take(){
   if(first===null)return null;
   const r={packets:seen,lost,p50:null,p95:null,p99:null,max:null};
   if(lags.length){lags.sort((x,y)=>x-y);const q=f=>Math.round(lags[Math.min(lags.length-1,Math.floor(lags.length*f))]);Object.assign(r,{p50:q(0.5),p95:q(0.95),p99:q(0.99),max:Math.round(lags[lags.length-1])});}
   seen=0;lost=0;lags=[];return r;
  },
 };
}
