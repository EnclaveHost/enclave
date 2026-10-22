p='network/host-services/stage-tool.mjs'; s=open(p).read()
def rep(old,new):
    global s
    assert s.count(old)==1,(old,s.count(old)); s=s.replace(old,new)
rep("""//        agree on one public address and the label passes the route-dns role's validation; disagreements are reported""","""//        agree on one public address and the label passes the route-dns role's validation; disagreements are reported
//   node stage-tool.mjs host-services --endpoint <registry endpoint> --zone <app zone> --exit <providerId>=<IPv4> ... [--tls-http P --tls R=P ...]
//        THIS host's public service names (network/host-service-names.mjs, from the endpoint's registry id) and, from ONE
//        list of WireGuard exits: the route-dns appStatic labels (each name -> every exit's address), the privacy agent's
//        enclaveNetwork.hostServices block (the same exits) and the http(s) endpoints to advertise later. Nothing is
//        changed anywhere: gen-config takes it as spec.hostServices (its appStatic), the agent block is the operator's.""")
rep("""import { planHostServices, policyEnv, policyCarrierFetch } from './runner.mjs';""","""import { planHostServices, policyEnv, policyCarrierFetch } from './runner.mjs';
import { hostServiceNames, validServiceZone } from '../host-service-names.mjs';
import { validateHostServicesTransport } from '../host-service-transport.mjs';
import { ROLES } from './roles.mjs';""")
rep("""export function genConfig(spec, listenersText) {""","""/**
 * A host's public service names and how they resolve, all from ONE exit list (work/host-service-transport-20261021):
 *   - names: hostServiceNames(registry id of `endpoint`, zone) - only this host's, nobody chooses them;
 *   - appStatic: { '<label>': [every exit's IPv4] } for the hosted route-dns (the zone must be the app zone it serves): a
 *     client gets every provider that carries this host's grant, and tries the next when one is down;
 *   - agent: enclaveNetwork.hostServices for the privacy agent - a service circuit to EXACTLY those exits;
 *   - endpoints: what `runner.mjs advertise` would publish once the names answer (http until a role has TLS, G3).
 * ports default to the hs2 stage-1 ports; dns (route-dns 53) is included only with `dns: true`.
 */
export function hostServicePublication({ endpoint, zone, exits, ports = { 'directory-replica': 18188, 'bootstrap-replica': 18189, 'policy-mirror': 18190 },
  dns = null, tls = null }) {
  validServiceZone(zone);
  if (!/^https:\\/\\/[^\\s/?#@]+(\\/[^\\s?#]*)?$/.test(String(endpoint || '').replace(/\\/+$/, ''))) throw fail(1, 'host services: the host\\'s registry endpoint (https) is required');
  if (!Array.isArray(exits) || !exits.length || exits.length > 8) throw fail(1, 'host services: 1 to 8 exits {providerId, address}');
  const addresses = exits.map((x) => x?.address), ids = exits.map((x) => x?.providerId);
  if (new Set(addresses).size !== addresses.length || new Set(ids).size !== ids.length) throw fail(1, 'host services: each exit once (distinct ids and addresses)');
  const hostId = hostIdOfEndpoint(endpoint), names = hostServiceNames(hostId, zone);
  const agent = validateHostServicesTransport({ zone, exits: ids, ports, ...(tls ? { tls } : {}), ...(dns ? { dns } : {}) });
  const appStatic = Object.fromEntries(Object.keys(ports).map((role) => [names[role].slice(0, -(zone.length + 1)), [...addresses]]));
  // the route-dns role's own validation (public IPv4s, non-deployment labels): the same check its config will get
  ROLES['route-dns'].validate({ dnsPort: 53, bind: '127.0.0.1', apiPort: 8154, zone, ipZone: 'ip.' + zone.split('.').slice(1).join('.'), nsName: 'ns-check.' + zone,
    nsNames: ['ns-check.' + zone], routeMapUrl: 'http://127.0.0.1:1/v1/network/routes', appStatic });
  const endpoints = Object.fromEntries(Object.keys(ports).map((role) => [role, [`${agent.tls?.tlsPorts[role] ? 'https' : 'http'}://${names[role]}/`]]));
  return { hostId, zone, names, appStatic, agent: { hostServices: { zone, exits: ids, ports, ...(tls ? { tls } : {}), ...(dns ? { dns } : {}) } }, endpoints };
}

export function genConfig(spec, listenersText) {""")
rep("""          // only mappings captured from public authoritative answers (capture-app-static.sh); never inferred
          ...(spec.dns.appStatic && Object.keys(spec.dns.appStatic).length ? { appStatic: spec.dns.appStatic } : {}) } },""","""          // only mappings captured from public authoritative answers (capture-app-static.sh), never inferred; plus THIS
          // host's own service labels from spec.hostServices (hostServicePublication: its exits' addresses)
          ...(() => { const own = spec.hostServices ? hostServicePublication({ endpoint: spec.endpoint, zone: spec.dns.zone, ...spec.hostServices }).appStatic : {};
            for (const l of Object.keys(own)) if (spec.dns.appStatic?.[l] !== undefined) throw fail(3, `refused: appStatic label ${l} is both captured and this host's service name`);
            const all = { ...(spec.dns.appStatic || {}), ...own };
            return Object.keys(all).length ? { appStatic: all } : {}; })() } },""")
# health: a list value must be answered exactly (as a set)
rep("""    for (const [label, address] of statics) {
      const a = await dnsQuery(dn.dnsPort, local(dn.bind), `${label}.${dn.zone}`, 1);
      if (!a || a.rcode !== 0 || !a.authoritative || a.addresses.length !== 1 || a.address !== address) wrong.push({ label, want: address, got: a });
    }""","""    for (const [label, address] of statics) {
      const a = await dnsQuery(dn.dnsPort, local(dn.bind), `${label}.${dn.zone}`, 1), want = Array.isArray(address) ? address : [address];
      if (!a || a.rcode !== 0 || !a.authoritative || a.addresses.length !== want.length || [...a.addresses].sort().join() !== [...want].sort().join()) wrong.push({ label, want: address, got: a });
    }""")
rep("""  const o = (() => { try { return args(rest, ['rpc', 'carrier', 'from-dir', 'from-origin', 'label', 'server']); } catch (e) { console.error(e.message); process.exit(1); } })();""","""  const o = (() => { try { return args(rest, ['rpc', 'carrier', 'from-dir', 'from-origin', 'label', 'server', 'exit', 'tls']); } catch (e) { console.error(e.message); process.exit(1); } })();""")
rep("""    } else throw fail(1, 'usage: stage-tool.mjs capture-public|policy-import|fill-artifacts|gen-config|health|capture-app-static ... (see the header)');""","""    } else if (cmd === 'host-services') {
      if (!o.endpoint || !o.zone || !o.exit?.length) throw fail(1, 'host-services needs --endpoint, --zone and --exit <providerId>=<IPv4> ...');
      const exits = o.exit.map((x) => { const [providerId, address] = String(x).split('='); return { providerId, address }; });
      const tls = o['tls-http'] ? { httpPort: Number(o['tls-http']), tlsPorts: Object.fromEntries((o.tls || []).map((x) => { const [r, p] = String(x).split('='); return [r, Number(p)]; })) } : null;
      print(hostServicePublication({ endpoint: o.endpoint, zone: o.zone, exits, tls, ...(o.dns ? { dns: { tcp: 18153, udp: 18153 } } : {}) }));
    } else throw fail(1, 'usage: stage-tool.mjs capture-public|policy-import|fill-artifacts|gen-config|health|capture-app-static|host-services ... (see the header)');""")
open(p,'w').write(s)
