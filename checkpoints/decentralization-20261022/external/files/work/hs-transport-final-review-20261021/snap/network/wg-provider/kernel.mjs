// The provider's kernel state: two WireGuard interfaces and one nftables table (docs/design/enclave-network.md).
// Commands run without a shell; the table is replaced atomically in one nft transaction.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
const run=promisify(execFile);

export const BLOCKED4=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24',
 '192.88.99.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4'];
const ipv4=/^(\d{1,3}\.){3}\d{1,3}$/,key=/^[A-Za-z0-9+/]{43}=$/;
// UDP/TCP 53 to this host's public address may be forwarded, as packets, to ONE exit-interface peer (a host's DNS role,
// provider.mjs dnsTarget) - only inside 10.77/16, never anywhere else, so this is never an open forwarder.
const exitPeer=/^10\.77\.(\d{1,3})\.(\d{1,3})$/;
export const DNS_LIMITS=Object.freeze({perSourcePps:20,perSourceBurst:40,globalPps:2000,globalBurst:4000,tcpPerSource:8});
export function dnsLimits(d){
 if(d===null||d===undefined||d===false)return null;
 const v={...DNS_LIMITS,...(d===true?{}:d)};
 for(const k of Object.keys(DNS_LIMITS))if(!Number.isInteger(v[k])||v[k]<1||v[k]>1000000)throw new Error(`dns ${k}: 1 to 1000000`);
 if(v.perSourceBurst<v.perSourcePps||v.globalBurst<v.globalPps||v.perSourcePps>v.globalPps)throw new Error('dns limits: bursts at least the rate, per-source at most global');
 return Object.fromEntries(Object.keys(DNS_LIMITS).map(k=>[k,v[k]]));
}

// The whole ruleset. Egress peers may reach only public destinations other than this host, never SMTP; a guard peer
// may reach only qualified providers' WireGuard and control ports; nothing reaches this host or another peer from a
// tunnel. Every refusal is a TCP reset or ICMP administratively-prohibited, so a refusal is an answer, not a hang.
// dns (dnsLimits): DNS 53 from the uplink to this address is rate-limited per source and in total (and TCP connections
// per source), then DNATed to the dns_dnat map's one peer and masqueraded to 10.77.0.1; with the map empty nothing is
// forwarded. Nothing else from the internet reaches a peer except through the router's own connections.
export function ruleset({publicAddress,uplink='eth0',dns=null}){
 if(!ipv4.test(publicAddress)||!/^[a-z0-9.-]{1,15}$/.test(uplink))throw new Error('public IPv4 address and uplink required');
 const d=dnsLimits(dns);
 const dnsDecl=d?`
 map dns_dnat { type inet_service : ipv4_addr; }
 set dns_rate4 { type ipv4_addr; size 65536; flags dynamic,timeout; timeout 60s; }
 set dns_conn4 { type ipv4_addr; size 65536; flags dynamic; }`:'';
 const dnsChains=d?`
 chain dns_guard {
  type filter hook prerouting priority -150; policy accept;
  iifname "${uplink}" ip daddr ${publicAddress} meta l4proto { tcp, udp } th dport 53 jump dns_limits
 }
 chain dns_limits {
  limit rate over ${d.globalPps}/second burst ${d.globalBurst} packets drop
  update @dns_rate4 { ip saddr limit rate over ${d.perSourcePps}/second burst ${d.perSourceBurst} packets } drop
  meta l4proto tcp ct state new add @dns_conn4 { ip saddr ct count over ${d.tcpPerSource} } drop
 }
 chain dns_dstnat {
  type nat hook prerouting priority dstnat; policy accept;
  iifname "${uplink}" ip daddr ${publicAddress} udp dport 53 dnat ip to udp dport map @dns_dnat
  iifname "${uplink}" ip daddr ${publicAddress} tcp dport 53 dnat ip to tcp dport map @dns_dnat
 }`:'';
 return `table inet enclave_net {${dnsDecl}
 set egress4 { type ipv4_addr; }
 set targets_udp { type ipv4_addr . inet_service; }
 set targets_tcp { type ipv4_addr . inet_service; }
 set own4 { type ipv4_addr; elements = { ${publicAddress} } }
 set blocked4 { type ipv4_addr; flags interval; elements = { ${BLOCKED4.join(', ')} } }
 chain input {
  type filter hook input priority -10; policy accept;
  iifname { "wg-exit", "wg-guard" } ct state established,related accept
  iifname { "wg-exit", "wg-guard" } meta l4proto tcp reject with tcp reset
  iifname { "wg-exit", "wg-guard" } reject with icmpx admin-prohibited
 }
 chain forward {
  type filter hook forward priority -10; policy accept;
  ct state established,related accept
  iifname { "wg-exit", "wg-guard" } oifname { "wg-exit", "wg-guard" } reject with icmpx admin-prohibited${d?`
  iifname "${uplink}" oifname "wg-exit" ct status dnat meta l4proto { tcp, udp } th dport 53 accept`:''}
  oifname { "wg-exit", "wg-guard" } drop
  iifname "wg-exit" meta nfproto ipv6 reject with icmpx admin-prohibited
  iifname "wg-exit" ip saddr != @egress4 reject with icmpx admin-prohibited
  iifname "wg-exit" ip daddr @blocked4 meta l4proto tcp reject with tcp reset
  iifname "wg-exit" ip daddr @blocked4 reject with icmpx admin-prohibited
  iifname "wg-exit" ip daddr @own4 meta l4proto tcp reject with tcp reset
  iifname "wg-exit" ip daddr @own4 reject with icmpx admin-prohibited
  iifname "wg-exit" tcp dport 25 reject with tcp reset
  iifname "wg-exit" oifname "${uplink}" accept
  iifname "wg-guard" ip daddr . udp dport @targets_udp oifname "${uplink}" accept
  iifname "wg-guard" ip daddr . tcp dport @targets_tcp oifname "${uplink}" accept
  iifname "wg-guard" meta l4proto tcp reject with tcp reset
  iifname { "wg-exit", "wg-guard" } reject with icmpx admin-prohibited
 }
 chain postrouting {
  type nat hook postrouting priority srcnat; policy accept;
  oifname "${uplink}" ip saddr { 10.77.0.0/16, 10.78.0.0/16 } masquerade${d?`
  oifname "wg-exit" ct status dnat meta l4proto { tcp, udp } th dport 53 masquerade`:''}
 }${dnsChains}
}
`;}

// a DNS target is a valid exit-interface peer address (not the provider's own 10.77.0.0/.1/.255), else none
const dnsTarget=a=>{const m=exitPeer.exec(String(a||''));if(!m)return null;const [x,y]=[Number(m[1]),Number(m[2])];
 return x<=255&&y<=255&&y!==0&&y!==255&&!(x===0&&y<=1)?a:null;};
export class Kernel {
 constructor({publicAddress,uplink='eth0',ports={exit:51820,guard:51821},keyDir='/etc/enclave-network',dns=null,exec=run,log=()=>{}}){
  Object.assign(this,{publicAddress,uplink,ports,keyDir,exec,log});this.dns=dnsLimits(dns);this.dnsTarget=null;
 }
 async cmd(bin,args,input){
  if(input===undefined)return (await this.exec(bin,args,{timeout:15000})).stdout;
  return await new Promise((resolve,reject)=>{const c=execFile(bin,args,{timeout:15000},(e,out)=>e?reject(e):resolve(out));c.stdin.end(input);});
 }
 async key(name){
  const file=`${this.keyDir}/${name}.key`;
  try{await fs.access(file);}catch{
   await fs.mkdir(this.keyDir,{recursive:true,mode:0o700});
   const k=(await this.cmd('wg',['genkey'])).trim();await fs.writeFile(file,k+'\n',{mode:0o600,flag:'wx'});
  }
  const priv=(await fs.readFile(file,'utf8')).trim();
  return {file,publicKey:(await this.cmd('wg',['pubkey'],priv+'\n')).trim()};
 }
 // Interfaces, forwarding and the table. Idempotent: safe at every start.
 async ensure(){
  const keys={};
  for(const [name,net,port,mtu] of [['wg-exit','10.77.0.1/16',this.ports.exit,1340],['wg-guard','10.78.0.1/16',this.ports.guard,1420]]){
   const k=await this.key(name);keys[name]=k.publicKey;
   try{await this.cmd('ip',['link','show',name]);}catch{await this.cmd('ip',['link','add',name,'type','wireguard']);}
   await this.cmd('wg',['set',name,'listen-port',String(port),'private-key',k.file]);
   const addrs=await this.cmd('ip',['-4','addr','show','dev',name]);if(!addrs.includes(net.split('/')[0]+'/'))await this.cmd('ip',['addr','add',net,'dev',name]);
   await this.cmd('ip',['link','set',name,'mtu',String(mtu),'up']);
  }
  await this.cmd('sysctl',['-q','-w','net.ipv4.ip_forward=1']);
  await this.applyTable();
  return keys;
 }
 // nft reads a script from a file (older nft refuses -f - on a pipe); the file lives in the 0700 key directory
 async nft(script){
  const file=`${this.keyDir}/.nft-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.nft`;
  await fs.writeFile(file,script,{mode:0o600});
  try{await this.cmd('nft',['-f',file]);}finally{await fs.rm(file,{force:true});}
 }
 async applyTable(){
  let existing='';try{existing=await this.cmd('nft',['list','table','inet','enclave_net']);}catch{}
  await this.nft((existing?'delete table inet enclave_net\n':'')+ruleset({publicAddress:this.publicAddress,uplink:this.uplink,dns:this.dns}));
 }
 iface(peer){return peer.role==='guard'?'wg-guard':'wg-exit';}
 async setPeer(peer){
  if(!key.test(peer.key)||!ipv4.test(peer.address))throw new Error('invalid peer');
  await this.cmd('wg',['set',this.iface(peer),'peer',peer.key,'allowed-ips',peer.address+'/32']);
 }
 // the public keys the kernel holds on an interface
 async listPeers(iface){return (await this.cmd('wg',['show',iface,'peers'])).split('\n').map(x=>x.trim()).filter(Boolean);}
 async removePeer(peer){if(key.test(peer.key))await this.cmd('wg',['set',this.iface(peer),'peer',peer.key,'remove']);}
 // Replace the dynamic sets (and the DNS 53 target) in one transaction.
 async sync({egress,targets,dns=null}){
  const e=egress.filter(a=>ipv4.test(a)),t=targets.filter(x=>ipv4.test(x.address)&&x.address!==this.publicAddress);
  // a guard reaches each exit's WireGuard port, its control port, and its public 443/80 (route probes see the guard)
  const udp=t.map(x=>`${x.address} . ${Number(x.ports.exit)}`),tcp=t.flatMap(x=>[`${x.address} . ${Number(x.ports.control)}`,`${x.address} . 443`,`${x.address} . 80`]);
  const script=['flush set inet enclave_net egress4','flush set inet enclave_net targets_udp','flush set inet enclave_net targets_tcp',
   ...(e.length?[`add element inet enclave_net egress4 { ${e.join(', ')} }`]:[]),
   ...(udp.length?[`add element inet enclave_net targets_udp { ${udp.join(', ')} }`]:[]),
   ...(tcp.length?[`add element inet enclave_net targets_tcp { ${tcp.join(', ')} }`]:[]),
   ...(this.dns?['flush map inet enclave_net dns_dnat',...(dnsTarget(dns)?[`add element inet enclave_net dns_dnat { 53 : ${dns} }`]:[])]:[])].join('\n')+'\n';
  await this.nft(script);
  if(this.dns&&(dnsTarget(dns)||null)!==this.dnsTarget){
   const was=this.dnsTarget;this.log(`dns 53 now forwarded to ${dnsTarget(dns)||'nobody'}`);this.dnsTarget=dnsTarget(dns)||null;
   // UDP flows already DNATed to the old target would keep going there until conntrack forgets them (30 s unreplied,
   // 120 s assured): delete exactly those (UDP, to this address, port 53). Best effort: without conntrack-tools the
   // bound above stands, said once. TCP connections are left to finish.
   if(was)await this.cmd('conntrack',['-D','-p','udp','--orig-dst',this.publicAddress,'--orig-port-dst','53']).catch(e=>{
    if(e?.code==='ENOENT'&&!this.conntrackMissing){this.conntrackMissing=true;this.log('conntrack-tools absent: UDP flows to the old DNS target end on their conntrack timeout (<=120 s)');}});
  }
 }
 // Per-peer counters as WireGuard reports them (the provider's own observation; never billing evidence alone).
 async stats(){
  const out={};
  for(const name of ['wg-exit','wg-guard']){
   const lines=(await this.cmd('wg',['show',name,'dump'])).trim().split('\n').slice(1);
   for(const l of lines){const f=l.split('\t');if(f.length>=7)out[f[0]]={iface:name,lastHandshake:Number(f[4])*1000,rx:Number(f[5]),tx:Number(f[6])};}
  }
  return out;
 }
 // Bytes through the uplink, both directions, for the transfer budget.
 async uplinkBytes(){
  const dev=(await fs.readFile('/proc/net/dev','utf8')).split('\n').find(l=>l.trim().startsWith(this.uplink+':'));
  if(!dev)throw new Error('uplink not found');const f=dev.split(':')[1].trim().split(/\s+/).map(Number);return {rx:f[0],tx:f[8]};
 }
}
