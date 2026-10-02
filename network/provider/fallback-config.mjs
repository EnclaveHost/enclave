import net from 'node:net';
import {validateAppNames} from '../app-ingress.mjs';
import {validatePublicFallback} from '../public-fallback.mjs';

// Provisioning only: this runs on the fleet operator's machine. HAProxy holds
// no certificates or private app keys and never terminates TLS. Data transport
// remains the unmodified, publicly advertised TUNA reverse service.
export function provisionFallback({provider,apps,allocations={}}) {
  const checked=validatePublicFallback({...provider,httpsPort:20000,httpPort:20001});
  const saved=structuredClone(allocations),used=new Set(),names=new Map(),seen=new Set();
  for(const [id,v] of Object.entries(saved)) {
    if(!/^0x[0-9a-f]{64}$/.test(id)||!v||Object.keys(v).some(k=>!['httpsPort','httpPort'].includes(k)))throw new Error('invalid saved fallback allocation');
    validatePublicFallback({...provider,...v});
    for(const p of [v.httpsPort,v.httpPort]){if(p<20000||p>29999||used.has(p))throw new Error('duplicate or out-of-range fallback port');used.add(p);}
  }
  const assigned=apps.map(app=>{
    validateAppNames(app.deploymentId,app.names);
    if(seen.has(app.deploymentId))throw new Error('duplicate fallback app');seen.add(app.deploymentId);
    for(const name of app.names){const n=name.toLowerCase();if(names.has(n)&&names.get(n)!==app.deploymentId)throw new Error('fallback hostname belongs to two apps');names.set(n,app.deploymentId);}
    if(!saved[app.deploymentId]){
      let port=20000;while(port<30000&&(used.has(port)||used.has(port+1)))port+=2;
      if(port>=30000)throw new Error('fallback port pool exhausted');
      saved[app.deploymentId]={httpsPort:port,httpPort:port+1};used.add(port);used.add(port+1);
    }
    return {...app,publicFallback:{identity:checked.identity,address:checked.address,...saved[app.deploymentId]}};
  });
  const config=['# Generated TLS passthrough: no TLS termination or app private keys.',
    'global','  maxconn 4096','  user haproxy','  group haproxy',
    'defaults','  mode tcp','  timeout connect 10s','  timeout client 1h','  timeout server 1h',
    'frontend encrypted_apps','  bind :443','  tcp-request inspect-delay 5s',
    '  tcp-request content accept if { req.ssl_hello_type 1 }'];
  for(const app of assigned)config.push(`  use_backend tls_${app.deploymentId.slice(2)} if { req.ssl_sni -i ${app.names.join(' ')} }`);
  config.push('  default_backend unknown_tls','backend unknown_tls','  tcp-request content reject',
    'frontend http_apps','  bind :80','  mode http');
  for(const app of assigned)config.push(`  use_backend http_${app.deploymentId.slice(2)} if { hdr(host),lower,field(1,:) -m str ${app.names.map(n=>n.toLowerCase()).join(' ')} }`);
  const address=net.isIPv6(checked.address)?`[${checked.address}]`:checked.address;
  for(const app of assigned){
    const id=app.deploymentId.slice(2),f=app.publicFallback;
    config.push(`backend tls_${id}`,`  server tunnel ${address}:${f.httpsPort}`,
      `backend http_${id}`,'  mode http',`  server tunnel ${address}:${f.httpPort}`);
  }
  return {apps:assigned,allocations:saved,haproxy:config.join('\n')+'\n'};
}
