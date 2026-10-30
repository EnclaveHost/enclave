import fs from 'node:fs';
const readJSON=file=>{const b=fs.readFileSync(file);if(b.length>1048576)throw Error('startup egress file too large');return JSON.parse(b);};
// A command may need outbound storage before binding its HTTP port. Its secret
// release waits for an independently attested, lease-bound private circuit.
// The guest's own destination allowlist still governs every outbound request.
export function startupEgressReady(id,{configFile,routeFile,now=Date.now(),read=readJSON,required=false}={}) {
 if(!configFile&&!routeFile)return !required;
 if(!configFile||!routeFile)throw Error('startup egress needs config and routes');
 // Legacy apps without configuration keep their existing behavior. Native apps
 // require an explicit startup route even before enrollment writes the first config.
 if(read===readJSON&&!fs.existsSync(configFile))return !required;
 const config=read(configFile);
 if(config.version!==2||!Array.isArray(config.apps))throw Error('invalid startup egress config');
 if(!config.apps.some(a=>a.deploymentId===id&&a.startupEgress===true))return !required;
 const routes=read(routeFile),app=routes.apps?.[id];
 if(routes.version!==1||!Number.isSafeInteger(routes.expiresAt)||routes.expiresAt<=now||routes.expiresAt>now+120000||!Array.isArray(app?.proxies)||app.proxies.length<1||app.proxies.length>2)return false;
 return new Set(app.proxies).size===app.proxies.length&&app.proxies.every(p=>/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(p)&&Number(p.split(':')[1])<=65535);
}
