p='network/wg-provider/main.mjs'; s=open(p).read()
def rep(old,new):
    global s
    assert s.count(old)==1,(old,s.count(old)); s=s.replace(old,new)
rep("""//          proofKeyFile}                    (a paid provider, pricePerGiB6 > 0: a community provider, i.e. a registry host
//                                            [kind community, hostId], co-signs receipts with that host's proof key)""","""//          proofKeyFile,                    (a paid provider, pricePerGiB6 > 0: a community provider, i.e. a registry host
//                                            [kind community, hostId], co-signs receipts with that host's proof key)
//          hostServices}                    (optional: registered hosts' own public service names and DNS 53, as raw
//                                            packets; wg-provider/host-services-config.mjs)""")
rep("""import {resolveProviderBootstrap} from '../service-index.mjs';""","""import {resolveProviderBootstrap} from '../service-index.mjs';
import {providerHostServices,hostServicesPolicyEnv} from './host-services-config.mjs';
import {resolveHostPolicyConfig} from '../platform-host-policy-config.mjs';
import {createHostPolicyRuntime} from '../host-policy-runtime.mjs';""")
rep("""const boot=resolveProviderBootstrap(cfg);
if(checkOnly){""","""const boot=resolveProviderBootstrap(cfg);
const hostServices=providerHostServices(cfg.hostServices,{zone:boot.zone,probeZone:boot.probeZone,roles:cfg.roles||[]});
if(checkOnly){""")
rep("""  pinned:!!boot.authorityPins,checkers:(cfg.checkers||[]).length,notes:boot.notes}));process.exit(0);""","""  pinned:!!boot.authorityPins,checkers:(cfg.checkers||[]).length,notes:boot.notes,
  hostServices:hostServices&&{zone:hostServices.zone,platformHostPolicy:typeof hostServices.platformHostPolicy==='string'?hostServices.platformHostPolicy:'explicit',maxHosts:hostServices.maxHosts,dnsHosts:hostServices.dns?.hosts.length||0}}));process.exit(0);""")
rep("""const kernel=new Kernel({publicAddress:cfg.publicAddress,uplink:cfg.uplink||'eth0',ports,log});""","""const kernel=new Kernel({publicAddress:cfg.publicAddress,uplink:cfg.uplink||'eth0',ports,dns:hostServices?.dns?.limits||null,log});""")
rep("""const config={providerId,hostId:cfg.hostId||null,roles:cfg.roles,pricePerGiB6:cfg.pricePerGiB6||0,publicAddress:cfg.publicAddress,exitKey:keys['wg-exit'],guardKey:keys['wg-guard'],
 ports,zone:boot.zone,probeZone:boot.probeZone,checkers:cfg.checkers||[]};""","""const config={providerId,hostId:cfg.hostId||null,roles:cfg.roles,pricePerGiB6:cfg.pricePerGiB6||0,publicAddress:cfg.publicAddress,exitKey:keys['wg-exit'],guardKey:keys['wg-guard'],
 ports,zone:boot.zone,probeZone:boot.probeZone,checkers:cfg.checkers||[],
 ...(hostServices?{hostServices:{zone:hostServices.zone,platformHostPolicy:hostServices.platformHostPolicy==='off'?'off':'on',maxHosts:hostServices.maxHosts,
  ...(hostServices.dns?{dns:{hosts:hostServices.dns.hosts,staleMs:hostServices.dns.staleMs}}:{})}}:{})};
// Host services obey the platform host policy exactly as every other enforcement point: the admin's bans and allowlist,
// at agreed blocks, only an explicit admit grants (host-policy-adapters.mjs hostAdmissions). "off" is explicit and loud.
let hostAdmission=null;
if(hostServices){
 const env=hostServicesPolicyEnv(hostServices);
 if(!env)log('host services: platform host policy is EXPLICITLY OFF (development only; not a production transport profile)');
 else{const resolved=resolveHostPolicyConfig({env,chainId:8453});const rt=createHostPolicyRuntime(resolved,{log});
  if(!rt)throw new Error('host services: the platform host policy did not resolve');hostAdmission=rt.admissions;}
 log(`host services: zone ${hostServices.zone}, at most ${hostServices.maxHosts} hosts; DNS 53 ${hostServices.dns?'to one of '+hostServices.dns.hosts.length+' pinned host(s)':'not forwarded'}`);
}""")
rep("""const provider=new WgProvider({config,signer:account,kernel,log,policyMemory,verifyOwner,domains,targets,hosts,store,""","""const provider=new WgProvider({config,signer:account,kernel,log,policyMemory,verifyOwner,domains,targets,hosts,hostAdmission,store,""")
open(p,'w').write(s)
