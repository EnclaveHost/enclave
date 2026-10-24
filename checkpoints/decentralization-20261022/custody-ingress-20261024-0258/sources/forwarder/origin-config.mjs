// Pure dedicated-origin configuration. No DNS, listener, SSH, config write or reload.
import {validateConfig,ROUTES,GUEST_MAX_BODY} from './forwarder.mjs';
export function compileOriginIngress({endpoint,listenPort,upstreamPort,tunnelPort}) {
 let u;try{u=new URL(endpoint);}catch{throw Error('exact HTTPS origin required');}
 if(u.origin!==endpoint||u.protocol!=='https:'||u.port||u.username||u.password||u.hostname.length>253
  ||u.hostname.split('.').length<2||u.hostname.split('.').some(l=>!/^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/.test(l))
  ||['api.enclave.host','enclave.host'].includes(u.hostname))throw Error('dedicated exact HTTPS origin required');
 if(![listenPort,upstreamPort,tunnelPort].every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535)||new Set([listenPort,upstreamPort,tunnelPort]).size!==3)throw Error('three distinct unprivileged ports required');
 const forwarder=validateConfig({mount:'origin',prefix:'',listen:{host:'127.0.0.1',port:listenPort},upstreamPort});
 const info=[...ROUTES].filter(([,m])=>m==='GET').map(([p])=>p),post=[...ROUTES].filter(([,m])=>m==='POST').map(([p])=>p);
 const proxy=`reverse_proxy 127.0.0.1:${tunnelPort} {\n      transport http {\n        response_header_timeout 35s\n      }\n    }`;
 const caddy=`${endpoint} {\n  @public_info {\n    method GET\n    path ${info.join(' ')}\n  }\n  @public_protocol {\n    method POST\n    path ${post.join(' ')}\n  }\n  handle @public_info {\n    ${proxy}\n  }\n  handle @public_protocol {\n    request_body {\n      max_size ${GUEST_MAX_BODY}\n    }\n    ${proxy}\n  }\n  handle {\n    respond "Not found" 404\n  }\n}\n`;
 return {endpoint,forwarder,caddy,reverseForward:`127.0.0.1:${tunnelPort}:127.0.0.1:${listenPort}`,
  scope:'Temporary canary ingress, not final decentralized routing. Remote reverse port targets only the raw-target forwarder; never the management or state port.'};
}
