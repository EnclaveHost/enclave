// The GameStream ingress (gamestream.mjs) as a service of its own, beside a provider it does not change. It listens on
// Sunshine's six ports on this box's public address and carries each flow through the app's 443 port tunnel BY WAY OF
// THE PROVIDER'S OWN 443 ROUTER on this box: TLS to `router` (127.0.0.1) under the app's name, which that router
// forwards to the peer holding the name, exactly as it forwards any internet client. So this holds no key, reads no
// provider state and reaches only what port 443 of this box already serves; the app's public certificate must verify.
//
// It cannot ask the provider which names a peer holds, so the names it will bind are those of its configured zones
// (one label under a zone: <id>.app.<zone>). A name under a zone that no peer holds still binds the client that sent
// it; that client's flows then fail at the router (closed), and nobody else's are touched. Bytes are metered by the
// router, as routed 443 traffic. For a provider that runs main's own release, `"gameStream": true` in provider.json
// is the tighter form (it binds only names a peer holds).
import {createGameStream,GAMESTREAM_PORTS} from './gamestream.mjs';

const IPV4=/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const LABEL='[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ZONE=new RegExp(`^${LABEL}(?:\\.${LABEL})+$`),ONE=new RegExp(`^${LABEL}$`);
const CAPS={maxFlows:[1,4096,256],maxPerClient:[1,64,32],maxBindings:[1,16384,4096]};

// -> the checked configuration with defaults filled in; throws on anything it does not know
export function parseGatewayConfig(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('configuration must be an object');
 for(const k of Object.keys(raw))if(!['zones','router','host',...Object.keys(CAPS)].includes(k))throw Error(`unknown field ${k}`);
 const {zones,router='127.0.0.1',host}=raw;
 if(!Array.isArray(zones)||!zones.length||zones.length>8||zones.some(z=>typeof z!=='string'||z.length>200||!ZONE.test(z)))throw Error('zones must be 1-8 lowercase DNS names');
 if(typeof router!=='string'||!IPV4.test(router))throw Error('router must be an IPv4 address (the provider\'s 443 router, 127.0.0.1)');
 if(typeof host!=='string'||!IPV4.test(host))throw Error('host must be the IPv4 address to listen on');
 const caps={};
 for(const [k,[min,max,usual]] of Object.entries(CAPS)){const v=raw[k]??usual;if(!Number.isInteger(v)||v<min||v>max)throw Error(`${k} must be an integer from ${min} to ${max}`);caps[k]=v;}
 return {zones:[...new Set(zones)],router,host,...caps};
}

// -> route(name): `router` for one label under a zone, null for everything else (an address, a deeper or foreign name)
export function zoneRoute(zones,router){
 return name=>{
  if(typeof name!=='string'||name.length>253)return null;
  for(const zone of zones)if(name.endsWith('.'+zone)&&ONE.test(name.slice(0,-zone.length-1)))return router;
  return null;
 };
}

// at most `burst` lines a minute: a client that names apps nobody holds cannot fill the journal
export function limitedLog(write,{burst=30,now=Date.now}={}){
 let start=now(),n=0,dropped=0;
 return line=>{
  if(now()-start>=60000){if(dropped)write(`(${dropped} more lines not logged in the last minute)`);start=now();n=0;dropped=0;}
  if(n<burst){n++;write(line);}else dropped++;
 };
}

export async function startGateway(cfg,{log=()=>{},ports=GAMESTREAM_PORTS,connect}={}){
 const {zones,router,host,maxFlows,maxPerClient,maxBindings}=cfg;
 const g=await createGameStream({route:zoneRoute(zones,router),host,ports,log,maxFlows,maxPerClient,maxBindings,...(connect?{connect}:{})});
 log(`gamestream gateway: ${host} TCP ${g.ports.https}, ${g.ports.http}, ${g.ports.rtsp} and UDP ${g.ports.udp.join(', ')} for *.${zones.join(', *.')} through ${router}:443`);
 return g;
}
