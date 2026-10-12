// Bring-your-own WireGuard: parse a standard wg-quick config as DATA ONLY (docs/design/enclave-network.md).
// Shared by the browser (the Network tab validates before anything leaves it), the relay and the host.
// Enclave owns interface creation, routes, DNS and firewall: anything that would run a command or change host
// networking is refused, as are partial tunnels (all app traffic, including DNS, must follow the tunnel).

const KEY=/^[A-Za-z0-9+/]{43}=$/;
const FORBIDDEN=new Set(['preup','postup','predown','postdown','table','saveconfig','fwmark','listenport']);
const INTERFACE=new Set(['privatekey','address','dns','mtu']);
const PEER=new Set(['publickey','presharedkey','endpoint','allowedips','persistentkeepalive']);

function v4(s){const m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);if(!m)return null;const b=m.slice(1).map(Number);return b.every(x=>x<=255&&String(x)===String(+x))?b:null;}
function v6(s){
 if(typeof s!=='string'||!/^[0-9a-fA-F:]+$/.test(s)||s.length>39||(s.match(/::/g)||[]).length>1)return null;
 const [h,t]=s.includes('::')?s.split('::'):[s,null];const head=h?h.split(':'):[],tail=t?t.split(':'):[];
 if([...head,...tail].some(x=>!/^[0-9a-fA-F]{1,4}$/.test(x)))return null;
 const fill=t===null?0:8-head.length-tail.length;if(t===null?head.length!==8:fill<1)return null;
 return [...head,...Array(fill).fill('0'),...tail].map(x=>parseInt(x,16));
}
export function ipKind(s){return v4(s)?4:v6(s)?6:0;}
// Destinations a tunnel endpoint (or resolver) may never be: an imported config must not point the host at its own
// private networks or cloud metadata.
export function privateAddress(s){
 const a=v4(s);
 if(a){const [x,y]=a;return x===0||x===10||x===127||x>=224||(x===100&&y>=64&&y<=127)||(x===169&&y===254)||(x===172&&y>=16&&y<=31)||(x===192&&y===168)||(x===192&&y===0)||(x===198&&(y===18||y===19));}
 const b=v6(s);if(!b)return true;
 const z=b.every(x=>x===0),lo=b.slice(0,7).every(x=>x===0)&&b[7]===1;
 return z||lo||(b[0]&0xfe00)===0xfc00||(b[0]&0xffc0)===0xfe80||(b[0]&0xff00)===0xff00||(b[0]===0x2001&&b[1]===0x0db8)||
  (b.slice(0,5).every(x=>x===0)&&b[5]===0xffff);
}
function cidr(s){
 const [ip,bits,...rest]=s.split('/');if(rest.length)return null;const kind=ipKind(ip);if(!kind)return null;
 const max=kind===4?32:128,n=bits===undefined?max:Number(bits);
 if(!Number.isInteger(n)||n<0||n>max||(bits!==undefined&&String(n)!==bits))return null;return {ip,bits:n,kind};
}
function endpoint(s){
 let host,port;const m=/^\[([^\]]+)\]:(\d{1,5})$/.exec(s);
 if(m){host=m[1];port=+m[2];if(ipKind(host)!==6)return null;}
 else{const i=s.lastIndexOf(':');if(i<1)return null;host=s.slice(0,i);port=+s.slice(i+1);if(host.includes(':'))return null;}
 if(!Number.isInteger(port)||port<1||port>65535)return null;
 if(!ipKind(host)&&!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host))return null;
 return {host:host.toLowerCase(),port};
}

// -> {config, warnings} or throws an Error whose .problems lists every problem found (shown to the owner).
export function parseWireGuardConfig(text){
 const problems=[],warnings=[];
 if(typeof text!=='string'||text.length>8192)throw Object.assign(new Error('a WireGuard config is text up to 8 KB'),{problems:['a WireGuard config is text up to 8 KB']});
 const sections=[];let cur=null;
 text.split(/\r?\n/).forEach((raw,i)=>{
  const line=raw.replace(/\s*#.*$/,'').trim();if(!line)return;
  const sec=/^\[(\w+)\]$/.exec(line);
  if(sec){cur={name:sec[1].toLowerCase(),values:new Map(),line:i+1};sections.push(cur);if(!['interface','peer'].includes(cur.name))problems.push(`line ${i+1}: unknown section [${sec[1]}]`);return;}
  const kv=/^([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
  if(!kv||!cur){problems.push(`line ${i+1}: not a "Key = value" line inside a section`);return;}
  const key=kv[1].toLowerCase();
  if(FORBIDDEN.has(key)){problems.push(`line ${i+1}: ${kv[1]} is not allowed (Enclave runs no config commands and manages routes and firewall itself)`);return;}
  if(!(cur.name==='interface'?INTERFACE:PEER).has(key)){problems.push(`line ${i+1}: ${kv[1]} is not a supported [${cur.name==='interface'?'Interface':'Peer'}] setting`);return;}
  if(cur.values.has(key)&&key!=='address'&&key!=='dns'&&key!=='allowedips'){problems.push(`line ${i+1}: ${kv[1]} given twice`);return;}
  cur.values.set(key,[...(cur.values.get(key)||[]),...kv[2].split(',').map(s=>s.trim()).filter(Boolean)]);
 });
 const ifaces=sections.filter(s=>s.name==='interface'),peers=sections.filter(s=>s.name==='peer');
 if(ifaces.length!==1)problems.push('exactly one [Interface] section is required');
 if(peers.length!==1)problems.push('exactly one [Peer] section is supported');
 const I=ifaces[0]?.values||new Map(),P=peers[0]?.values||new Map(),one=(m,k)=>(m.get(k)||[])[0];
 const privateKey=one(I,'privatekey');if(!KEY.test(privateKey||''))problems.push('[Interface] PrivateKey must be a WireGuard key');
 const addresses=(I.get('address')||[]).map(cidr);
 if(!addresses.length||addresses.some(a=>!a))problems.push('[Interface] Address must list tunnel addresses');
 const a4=addresses.filter(a=>a?.kind===4),a6=addresses.filter(a=>a?.kind===6);
 if(a4.length!==1||a6.length>1)problems.push('[Interface] Address needs exactly one IPv4 and at most one IPv6 address');
 const dns=I.get('dns')||[];
 if(!dns.length)problems.push('[Interface] DNS is required: names must resolve through the tunnel, never the host');
 for(const d of dns){if(!ipKind(d))problems.push(`[Interface] DNS ${d}: only resolver IP addresses are supported (no search domains)`);}
 if(dns.length>4)problems.push('[Interface] DNS: at most four resolvers');
 const mtuRaw=one(I,'mtu'),mtu=mtuRaw===undefined?0:Number(mtuRaw);
 if(mtuRaw!==undefined&&(!Number.isInteger(mtu)||mtu<1280||mtu>1500))problems.push('[Interface] MTU must be 1280-1500');
 const publicKey=one(P,'publickey');if(!KEY.test(publicKey||''))problems.push('[Peer] PublicKey must be a WireGuard key');
 const psk=one(P,'presharedkey');if(psk!==undefined&&!KEY.test(psk))problems.push('[Peer] PresharedKey must be a WireGuard key');
 const ep=one(P,'endpoint');const parsedEndpoint=ep?endpoint(ep):null;
 if(!parsedEndpoint)problems.push('[Peer] Endpoint must be host:port (an outbound-only VPN still needs its server address)');
 else if(ipKind(parsedEndpoint.host)&&privateAddress(parsedEndpoint.host))problems.push('[Peer] Endpoint must be a public address');
 const allowed=(P.get('allowedips')||[]).map(cidr);
 if(allowed.some(a=>!a))problems.push('[Peer] AllowedIPs has an invalid range');
 const full4=allowed.some(a=>a?.kind===4&&a.bits===0),full6=allowed.some(a=>a?.kind===6&&a.bits===0);
 if(!full4)problems.push('[Peer] AllowedIPs must include 0.0.0.0/0: only full-tunnel configs are supported, so no app traffic can bypass the tunnel');
 if(allowed.some(a=>a&&a.bits!==0))problems.push('[Peer] AllowedIPs: partial ranges are not supported (full tunnel only)');
 if(a6.length&&!full6)problems.push('[Peer] AllowedIPs must include ::/0 when the tunnel has an IPv6 address');
 if(!a6.length)warnings.push('No IPv6 tunnel address: the app\'s IPv6 traffic will be refused, never sent outside the tunnel.');
 for(const d of dns){if(ipKind(d)===6&&!a6.length)problems.push(`[Interface] DNS ${d}: an IPv6 resolver needs an IPv6 tunnel address`);}
 const keepRaw=one(P,'persistentkeepalive'),keepalive=keepRaw===undefined?25:Number(keepRaw);
 if(!Number.isInteger(keepalive)||keepalive<0||keepalive>120)problems.push('[Peer] PersistentKeepalive must be 0-120 seconds');
 if(problems.length)throw Object.assign(new Error(problems[0]),{problems});
 const config={privateKey,addresses:[a4[0].ip,...a6.map(a=>a.ip)],dns,mtu:mtu||1420,publicKey,...(psk?{presharedKey:psk}:{}),
  endpoint:parsedEndpoint,allowedIPs:full6?['0.0.0.0/0','::/0']:['0.0.0.0/0'],keepalive};
 return {config,warnings};
}

// What may be shown about a config anywhere outside the encrypted secret: no key material.
export function redactWireGuardConfig(c){
 return {addresses:c.addresses,dns:c.dns,mtu:c.mtu,endpoint:`${c.endpoint.host}:${c.endpoint.port}`,ipv6:c.addresses.length>1,keepalive:c.keepalive,
  publicKey:c.publicKey,hasPresharedKey:!!c.presharedKey};
}

// The bytes the policy's configDigest commits to: sha256(salt || this). Sorted keys, no whitespace.
export function wireGuardConfigBytes(c){
 const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
 return new TextEncoder().encode(JSON.stringify(sort(c)));
}
export async function wireGuardConfigDigest(saltHex,c){
 if(!/^[0-9a-f]{64}$/.test(saltHex||''))throw new Error('32-byte salt required');
 const salt=Uint8Array.from(saltHex.match(/../g),h=>parseInt(h,16)),body=wireGuardConfigBytes(c),buf=new Uint8Array(salt.length+body.length);
 buf.set(salt);buf.set(body,salt.length);
 const d=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',buf));
 return [...d].map(b=>b.toString(16).padStart(2,'0')).join('');
}
