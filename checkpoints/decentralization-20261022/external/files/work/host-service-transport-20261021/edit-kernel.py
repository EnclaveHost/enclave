p='network/wg-provider/kernel.mjs'; s=open(p).read()
def rep(old,new,count=1):
    global s
    assert s.count(old)==count, (old, s.count(old))
    s=s.replace(old,new)
rep("""const ipv4=/^(\\d{1,3}\\.){3}\\d{1,3}$/,key=/^[A-Za-z0-9+/]{43}=$/;
""","""const ipv4=/^(\\d{1,3}\\.){3}\\d{1,3}$/,key=/^[A-Za-z0-9+/]{43}=$/;
// UDP/TCP 53 to this host's public address may be forwarded, as packets, to ONE exit-interface peer (a host's DNS role,
// provider.mjs dnsTarget) - only inside 10.77/16, never anywhere else, so this is never an open forwarder.
const exitPeer=/^10\\.77\\.(\\d{1,3})\\.(\\d{1,3})$/;
export const DNS_LIMITS=Object.freeze({perSourcePps:20,perSourceBurst:40,globalPps:2000,globalBurst:4000,tcpPerSource:8});
export function dnsLimits(d){
 if(d===null||d===undefined||d===false)return null;
 const v={...DNS_LIMITS,...(d===true?{}:d)};
 for(const k of Object.keys(DNS_LIMITS))if(!Number.isInteger(v[k])||v[k]<1||v[k]>1000000)throw new Error(`dns ${k}: 1 to 1000000`);
 if(v.perSourceBurst<v.perSourcePps||v.globalBurst<v.globalPps||v.perSourcePps>v.globalPps)throw new Error('dns limits: bursts at least the rate, per-source at most global');
 return Object.fromEntries(Object.keys(DNS_LIMITS).map(k=>[k,v[k]]));
}
""")
rep("""// tunnel. Every refusal is a TCP reset or ICMP administratively-prohibited, so a refusal is an answer, not a hang.
export function ruleset({publicAddress,uplink='eth0'}){
 if(!ipv4.test(publicAddress)||!/^[a-z0-9.-]{1,15}$/.test(uplink))throw new Error('public IPv4 address and uplink required');
 return `table inet enclave_net {""","""// tunnel. Every refusal is a TCP reset or ICMP administratively-prohibited, so a refusal is an answer, not a hang.
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
  meta l4proto tcp ct state new add @dns_conn4 { ip saddr ct count over ${d.tcpPerSource} } reject with tcp reset
 }
 chain dns_dstnat {
  type nat hook prerouting priority dstnat; policy accept;
  iifname "${uplink}" ip daddr ${publicAddress} udp dport 53 dnat ip to udp dport map @dns_dnat
  iifname "${uplink}" ip daddr ${publicAddress} tcp dport 53 dnat ip to tcp dport map @dns_dnat
 }`:'';
 return `table inet enclave_net {${dnsDecl}""")
rep("""  ct state established,related accept
  iifname { "wg-exit", "wg-guard" } oifname { "wg-exit", "wg-guard" } reject with icmpx admin-prohibited
  oifname { "wg-exit", "wg-guard" } drop""","""  ct state established,related accept
  iifname { "wg-exit", "wg-guard" } oifname { "wg-exit", "wg-guard" } reject with icmpx admin-prohibited${d?`
  iifname "${uplink}" oifname "wg-exit" ct status dnat meta l4proto { tcp, udp } th dport 53 accept`:''}
  oifname { "wg-exit", "wg-guard" } drop""")
rep("""  oifname "${uplink}" ip saddr { 10.77.0.0/16, 10.78.0.0/16 } masquerade
 }
}
`;}""","""  oifname "${uplink}" ip saddr { 10.77.0.0/16, 10.78.0.0/16 } masquerade${d?`
  oifname "wg-exit" ct status dnat meta l4proto { tcp, udp } th dport 53 masquerade`:''}
 }${dnsChains}
}
`;}""")
rep("""export class Kernel {
 constructor({publicAddress,uplink='eth0',ports={exit:51820,guard:51821},keyDir='/etc/enclave-network',exec=run,log=()=>{}}){
  Object.assign(this,{publicAddress,uplink,ports,keyDir,exec,log});
 }""","""export class Kernel {
 constructor({publicAddress,uplink='eth0',ports={exit:51820,guard:51821},keyDir='/etc/enclave-network',dns=null,exec=run,log=()=>{}}){
  Object.assign(this,{publicAddress,uplink,ports,keyDir,exec,log});this.dns=dnsLimits(dns);this.dnsTarget=null;
 }""")
rep("""  await this.nft((existing?'delete table inet enclave_net\\n':'')+ruleset({publicAddress:this.publicAddress,uplink:this.uplink}));""","""  await this.nft((existing?'delete table inet enclave_net\\n':'')+ruleset({publicAddress:this.publicAddress,uplink:this.uplink,dns:this.dns}));""")
rep(""" // Replace the dynamic sets in one transaction.
 async sync({egress,targets}){""",""" // Replace the dynamic sets (and the DNS 53 target) in one transaction.
 async sync({egress,targets,dns=null}){""")
rep("""   ...(tcp.length?[`add element inet enclave_net targets_tcp { ${tcp.join(', ')} }`]:[])].join('\\n')+'\\n';
  await this.nft(script);
 }""","""   ...(tcp.length?[`add element inet enclave_net targets_tcp { ${tcp.join(', ')} }`]:[]),
   ...(this.dns?['flush map inet enclave_net dns_dnat',...(dnsTarget(dns)?[`add element inet enclave_net dns_dnat { 53 : ${dns} }`]:[])]:[])].join('\\n')+'\\n';
  await this.nft(script);
  if(this.dns&&(dnsTarget(dns)||null)!==this.dnsTarget){this.log(`dns 53 now forwarded to ${dnsTarget(dns)||'nobody'}`);this.dnsTarget=dnsTarget(dns)||null;}
 }""")
rep("""// Per-peer counters as WireGuard reports them""","""// Per-peer counters as WireGuard reports them""")
s=s.replace("""export class Kernel {""","""// a DNS target is a valid exit-interface peer address (not the provider's own 10.77.0.0/.1/.255), else none
const dnsTarget=a=>{const m=exitPeer.exec(String(a||''));if(!m)return null;const [x,y]=[Number(m[1]),Number(m[2])];
 return x<=255&&y<=255&&y!==0&&y!==255&&!(x===0&&y<=1)?a:null;};
export class Kernel {""",1)
open(p,'w').write(s)
