#!/usr/bin/env python3
"""inventory.py: the source manifest and placement classification of every hosted service on the four DigitalOcean
transport machines (work/hosted-service-placement). READ ONLY: built from evidence already collected without secrets
(storage-capacity-feasibility/inventory/*.txt unit listings, directory-runtime-activation/hosts/*.facts.json, the
decentralization audit rows) and from this repository's sources. Writes inventory.json beside it."""
import hashlib, json, re
from pathlib import Path

W = Path(__file__).resolve().parent.parent
TREE = Path(__file__).resolve().parent / 'policy-tree'   # the composed candidate (placement + policy-mirror follow-on)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None

units = {}
for host in ['us-west', 'eu-central', 'ap-southeast', 'ca-east']:
    for line in (W / 'storage-capacity-feasibility/inventory' / (host + '.txt')).read_text().splitlines():
        if not line.startswith('UNIT '):
            continue
        name = line[5:].split('|')[0]
        fields = dict(f.split('=', 1) for f in line.split('|')[1:] if '=' in f)
        exe = line.split('EXE=')[-1].strip() if 'EXE=' in line else None
        units.setdefault(name, {})[host] = {'memoryCurrent': int(fields.get('MemoryCurrent', '0') or 0), 'exe': exe}
taken = (W / 'storage-capacity-feasibility/inventory/TAKEN-AT.txt').read_text().strip()

# Classification. "transport" is ONLY WireGuard tunnel establishment/packet forwarding and its strictly necessary management.
C = {
  'enclave-bootstrap-gateway.service': dict(cls='application', what='CID-addressed public artifact serving (/ipfs/<cid>)',
     source='network/bootstrap-gateway.mjs', target='host role bootstrap-replica (this work: package + runner)', owner='this work',
     state='artifact files of a verified manifest (refillable by CID)', secrets='none'),
  'enclave-public-directory.service': dict(cls='application', what='signed public-record directory and peer gossip (providers, qualifications, owner policies, routes, management records)',
     source='network/directory-server.mjs + public-directory.mjs (fleet bundle enclave-directory.mjs)', target='host role directory-replica (this work)', owner='this work',
     state='accepted records + replay floors (durable; corruption refuses startup)', secrets='none'),
  'enclave-route-dns.service': dict(cls='application', what='authoritative DNS for the app zone from verified routes (read-only mode)',
     source='relay/dns-relay.js (DNS_READ_ONLY=1; bundle enclave-dns-read-only.mjs)', target='host role route-dns (this work)', owner='this work',
     state='none (route map re-read)', secrets='none in read-only mode (TXT key forced off)'),
  'enclave-dns-front.service': dict(cls='application', what='dnsdist: DNS-level proxying and rate limiting in front of route DNS',
     source='control-vm/prepare-dns-front.py (dnsdist config)', target='REMOVE: route-dns enforces its own limits (DNS_RL_*); only a packet-level UDP/TCP 53 forward could remain transport, and only while a fleet address is still a delegated nameserver',
     owner='this work (removal plan)', state='none', secrets='none'),
  'enclave-bootstrap-tls.service': dict(cls='application', what='custom Caddy: TLS termination and HTTP routing for website, API, artifacts, directory, policy and lease endpoints',
     source='work/bootstrap-tls-prepare.py (Caddyfile)', target='SPLIT: artifacts -> bootstrap-replica, directory -> directory-replica, /platform-policy -> policy-mirror (this work); website/API/identity, lease endpoints -> their owners; no TLS terminates on a transport machine',
     owner='shared (this work: artifact, directory and platform-policy paths)', state='certificates', secrets='TLS private keys (application TLS belongs on hosts/apps)'),
  'caddy.service': dict(cls='application', what='Caddy: HTTPS for enclave.host / api / mcp / get / ipfs / sia names and the platform-policy mirror routes',
     source='live Caddyfiles (app-zone-certificates/live-baseline)', target='SPLIT as above; /platform-policy -> host role policy-mirror (this work); mcp -> MCP worker, ipfs/sia -> storage worker, website/API -> identity/web owner',
     owner='shared', state='certificates', secrets='TLS private keys'),
  'enclave-custodian.service': dict(cls='application', what='custody (secret release quorum member)', source='custody/*', target='attested custody host/app deployment',
     owner='custody worker', state='custody state', secrets='custody keys (NEVER read here)'),
  'enclave-network-provider.service': dict(cls='mixed', what='WireGuard provider: exit/guard tunnels, raw SNI/Host routing to peers, peer-grant control API; ALSO localRoutes to on-box services, a no-SNI recovery ingress, a relay domain-map fetch, paid-receipt co-signing and on-chain attestations',
     source='network/wg-provider/{main,provider,kernel,router,control,paid}.mjs (bundle wg-provider.mjs)', target='minimal transport profile (see transport-profile below)',
     owner='this work (classification + profile check)', state='peers.json, policy nonces, transfer budget', secrets='operator key, WireGuard keys (transport identity; NEVER read here)'),
}
LEASE = dict(cls='application', what='lease relay (app-funded claim/renew sponsorship)', source='network/lease-relay-service.mjs', target='host/app lease relay deployment',
             owner='lease worker', state='durable relay state', secrets='relay signer (NEVER read here)')
OUT_OF_SCOPE_OS = ['cron.service', 'dbus.service', 'droplet-agent.service', 'fwupd.service', 'getty@tty1.service', 'ModemManager.service', 'multipathd.service']

rows = []
for name, per_host in sorted(units.items()):
    if name in C:
        rows.append({'unit': name, 'hosts': sorted(per_host), 'memoryCurrentBytes': per_host, **C[name]})
    elif name.startswith('enclave-'):
        rows.append({'unit': name, 'hosts': sorted(per_host), 'cls': 'unclassified', 'note': 'not in the classification table: review'})
rows.append({'unit': 'enclave-lease-relay.service', 'hosts': ['us-west', 'eu-central'], 'evidence': 'outputs/app-lease-gas-review/relays-active.json (activated after the unit listing)', **LEASE})
rows.append({'unit': 'minipc control/indexd/PostgreSQL', 'hosts': ['minipc (not DigitalOcean)'], 'cls': 'application', 'what': 'control plane, indexd and its database',
             'target': 'distributed host/app storage deployment', 'owner': 'storage worker', 'secrets': 'database contents (NEVER read here)'})
rows.append({'unit': 'regional recovery archives', 'hosts': ['all four'], 'cls': 'application data', 'what': 'encrypted recovery copies',
             'target': 'optional replicas only; usable recovery through storage apps', 'owner': 'storage/custody workers'})

# platform-policy mirrors are pinned to the fleet in source
cfg = (TREE / 'network/platform-host-policy-config.mjs').read_text()
mirrors = re.findall(r'"(https://[0-9.]+/platform-policy)"', cfg)
dependencies = [
  {'what': 'platform host policy document mirrors (PRODUCTION_MIRRORS)', 'source': 'network/platform-host-policy-config.mjs', 'pinned': mirrors,
   'allInFleet': all(m.split('/')[2] in ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'] for m in mirrors),
   'owner': 'this work (policy-mirror role + carriers)',
   'note': 'admin-signed and chain-anchored, so any carrier works. The DEFAULT list is fleet-only and is left unchanged in source (no non-fleet public address exists yet; S4). Fleet-independent path: host role policy-mirror (network/host-services/policy-mirror.mjs) and the runner\'s carriers (network/policy-carriers.mjs: importDir, peers, service-index kind "policy"), shown to the UNCHANGED gate as the reserved origin https://policy-carriers.invalid/platform-policy; runner.mjs check warns when a host has no carrier'},
  {'what': 'service-index directory advertisement', 'source': 'contracts/deployments/service-index-activation-base.json',
   'pinned': json.loads((TREE / 'contracts/deployments/service-index-activation-base.json').read_text())['advertisement']['endpoints'],
   'allInFleet': True, 'note': 'the only listed directory candidate is the fleet: hosts must advertise their own directory/replica roles (runner advertise, operator-signed)'},
]
transport_profile = {
  'keep (transport)': ['WireGuard exit/guard tunnels and peers (kernel.mjs, provider.mjs)', 'raw SNI (443) / Host (80) routing to the tunnel address of the peer holding a name; never terminates TLS (router.mjs)',
                       'peer grant control API /v1/peer and /v1/info (control.mjs), verified against leases and owner policies', 'its signed provider record published to directories', 'the transfer budget'],
  'remove from a transport machine': ['localRoutes: services ON the box (e.g. a custodian) reached by name - application co-location', 'noSniRoute: an IP-certificate recovery ingress into an on-box TLS service',
                                      'relay: the custom-domain map from the Enclave relay (route records and owner names belong in directories)'],
  'separate role, not transport': ['paid receipts (paid.mjs) and on-chain qualification submissions: settlement for a COMMUNITY provider on a registry host; not needed for minimal transport'],
  'check': 'scripts/check-transport-profile.mjs <provider.json>: refuses localRoutes, noSniRoute and relay, and reports a paid/settlement role',
}
policy_mirror = {
  'role': 'policy-mirror', 'serviceIndexKind': 'policy (6)', 'source': ['network/host-services/policy-mirror.mjs', 'network/policy-carriers.mjs', 'network/host-services/runner.mjs (gate carriers)', 'network/cold-bootstrap.mjs (client policy option)'],
  'authority': 'unchanged: network/platform-host-policy.mjs via host-policy-runtime.mjs and host-service-gate.mjs (not modified; also built into the measured guest, the relay bundle and the site vendor)',
  'cycle': 'a host gate reads importDir and its own policy-mirror store from disk, re-verified at a fresh agreed block: no role, network carrier or admission is needed to load the anchored document',
  'coldPrerequisites': ['two or more Base RPC providers (the policy quorum)', 'the pinned EnclaveAddressBook / hostOwnership (platformHostPolicy)', 'the anchored signed document from ANY carrier: an operator import, a peer policy mirror, or a service-index policy ad'],
}
out = {'at': taken, 'readOnly': True, 'evidence': ['storage-capacity-feasibility/inventory/*.txt', 'directory-runtime-activation/hosts/*.facts.json',
       'outputs/decentralization-audit/hosted-service-placement.json', 'outputs/decentralization-audit/provider-failure-domain-audit.json'],
       'rows': rows, 'fleetDependenciesInSource': dependencies, 'policyMirror': policy_mirror, 'transportProfile': transport_profile, 'osAgentsNotEnclaveServices': OUT_OF_SCOPE_OS,
       'sourceSha256': {f: sha(TREE / f) for f in ['network/bootstrap-gateway.mjs', 'network/directory-server.mjs', 'network/public-directory.mjs', 'relay/dns-relay.js',
                        'network/wg-provider/main.mjs', 'network/wg-provider/router.mjs', 'network/platform-host-policy-config.mjs', 'network/platform-host-policy.mjs',
                        'network/host-policy-runtime.mjs', 'network/host-service-gate.mjs', 'network/host-policy-mirrors.mjs', 'network/policy-carriers.mjs', 'network/host-services/policy-mirror.mjs']}}
(Path(__file__).resolve().parent / 'inventory.json').write_text(json.dumps(out, indent=1) + '\n')
print(f"{len(rows)} rows; unclassified: {[r['unit'] for r in rows if r['cls'] == 'unclassified']}; policy mirrors in fleet: {dependencies[0]['allInFleet']}")
