#!/usr/bin/env python3
# Auth-boundary mutation checks. For each mutant: a hard-linked scratch copy of the tree; the ONE mutated file is written to a
# temp file and renamed over its link (a new inode: the tree is never modified); the named suite must then FAIL.
import os, shutil, subprocess, sys, json, time
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TREE = os.path.join(H, 'tree'); SCR = os.path.join(H, 'mut', 'scratch')
P = 'network/wg-provider/provider.mjs'; K = 'network/wg-provider/kernel.mjs'; N = 'network/host-service-names.mjs'
T1 = ['test/wg-provider-host-services.test.mjs']
TT = ['test/host-service-transport.test.mjs']; E = 'windows/node/network-enroll.mjs'; HT = 'network/host-service-transport.mjs'; PA = 'network/privacy-agent.mjs'
M = [
 ('service: operator signature not checked', P, "if(!host||!host.active||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from an active registered host');\n  await this.admitHost(r.runner);", "if(!host)throw new Error('the request is not from an active registered host');\n  await this.admitHost(r.runner);", T1),
 ('service: inactive host accepted', P, "if(!host||!host.active||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from an active registered host');\n  await this.admitHost(r.runner);", "if(!host||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from an active registered host');\n  await this.admitHost(r.runner);", T1),
 ('platform policy: any decision admits', P, "if(d?.admit!==true)throw new Error('platform host policy: '", "if(false)throw new Error('platform host policy: '", T1),
 ('platform policy: missing policy silently allowed', P, "   throw new Error('host services need the platform host policy", "   return;throw new Error('host services need the platform host policy", T1),
 ('route: service/app separation removed', P, "(p.role==='service')===service&&", "", T1),
 ('names: an app custom domain may take a name in a dedicated service zone', P, "&&\n   !(svc&&svc!==zone&&(n===svc||n.endsWith('.'+svc))));", ");", T1),
 ('nonce: replay not consumed atomically', P, "  if(this.nonces.has(nonce))throw new Error('replayed request');\n  this.nonces.set(nonce", "  this.nonces.set(nonce", T1),
 ('revoke: signer not checked', P, "if(!host||String(host.operator).toLowerCase()!==signer)throw new Error('the request is not from the host\\'s registry operator');", "if(!host)throw new Error('the request is not from the host\\'s registry operator');", T1),
 ('revoke: another host\'s or an app\'s peer', P, "if(!peer||peer.runner!==r.runner||!(peer.role==='service'||peer.control))", "if(!peer)", T1),
 ('sweep: a ban never removes', P, " if(!d||d.admit!==false)return false;", " return false;", T1),
 ('sweep: any refusal removes (not definite)', P, " if(!d||d.admit!==false)return false;", " return !!d&&d.admit===false;", T1),
 ('dns: unpinned hosts eligible', P, "if(p.role!=='service'||p.expiresAt<=now||!pins.has(p.runner))continue;", "if(p.role!=='service'||p.expiresAt<=now)continue;", T1),
 ('dns: stale handshake still eligible', P, "   if(now-Math.max(p.grantedAt||p.createdAt,p.lastHandshake||0)>stale)continue;\n", "", T1),
 ('names: truncated host label (8-hex-style collision)', N, "  return base32(Buffer.from(id.slice(2), 'hex'));", "  return base32(Buffer.from(id.slice(2, 10), 'hex')).padEnd(52, 'a');", T1),
 ('request shape: a service peer with egress', P, "if(r.role==='service'&&(!/^0x0{64}$/.test(r.deploymentId)||/^0x0{64}$/.test(r.runner)||r.policy!==null||!r.ingress||r.egress))", "if(r.role==='service'&&(!/^0x0{64}$/.test(r.deploymentId)||/^0x0{64}$/.test(r.runner)||r.policy!==null||!r.ingress))", T1),
 ('B5 dns: the health probe result ignored', P, "   if(p.dnsOk!==true||!(now-(p.dnsCheckedAt||0)<=stale))continue;\n", "", T1),
 ('m3 restore: saved service names kept', P, "try{p.names=Object.values(hostServiceNames(p.runner,this.config.hostServices.zone));}catch{continue;}", "", T1),
 ('N2 kernel: no conntrack delete at all', K, "    try{await this.flushDns();this.flushPending=false;", "    try{this.flushPending=false;", ['test/wg-provider-dns-kernel.test.mjs']),
 ('N2 kernel: no delete on the first assignment of a run', K, "   if(next!==this.dnsTarget||!this.dnsSynced){", "   if(next!==this.dnsTarget){", ['test/wg-provider-dns-kernel.test.mjs']),
 ('P1 kernel: a failed delete is not retried', K, "catch(e){this.flushFailures=(this.flushFailures||0)+1;", "catch(e){this.flushPending=false;this.flushFailures=(this.flushFailures||0)+1;", ['test/wg-provider-dns-kernel.test.mjs']),
 ('P1 kernel: the DNS gate removed', K, "  iifname \"${uplink}\" oifname \"wg-exit\" ct status dnat udp dport 53 ${d?'ip daddr != @dns_target4 ':''}drop\n", "", ['test/wg-provider-dns-kernel.test.mjs']),
 ('P1 kernel: the gate set not synced with the map', K, ",`add element inet enclave_net dns_target4 { ${dns} }`", "", ['test/wg-provider-dns-kernel.test.mjs']),
 ('P1 kernel: a loose zero-match ("10 flow entries")', K, "/(^|[^0-9])0 flow entries have been deleted/", "/0 flow entries/", ['test/wg-provider-dns-kernel.test.mjs']),
 ('N2 fail-closed: DNS forwarded without conntrack', 'network/wg-provider/host-services-config.mjs', "  if (!conntrack) return { on: false,", "  if (false) return { on: false,", ['test/wg-provider-dns-kernel.test.mjs']),
 ('N3 host services: a failed first round rejects start()', HT, "async start() { await this.reconcile().catch((e) => this.log('host service circuits: ' + e.message));", "async start() { await this.reconcile();", TT),
 ('N3 control: a failed first round rejects start()', 'network/wg-control.mjs', "async start(){await this.reconcile().catch(e=>this.log('control circuits: '+e.message));", "async start(){await this.reconcile();", TT),
 ('N4: the provider policy runtime is not persisted', 'network/wg-provider/main.mjs', "{log,store:fileStore(path.join(stateDir,'platform-host-policy.json'))}", "{log}", ['test/wg-provider-dns-kernel.test.mjs']),
 ('B2 enroll: an invalid block is dropped', E, "  catch (e) { return { block: structuredClone(h), error: e.message }; }", "  catch (e) { return { block: null, error: e.message }; }", TT),
 ('B1 ads: a configured TLS port advertises https', HT, "out[r] = `${port && await tlsReady({ port, servername: all[r], roots, timeoutMs }) ? 'https' : 'http'}", "out[r] = `${port ? 'https' : 'http'}", TT),
 ('B7 preflight: runner/endpoint mismatch accepted', PA, "if(endpoint!==undefined&&keccak256(toBytes(String(endpoint)))!==runner)", "if(false)", TT),
 ('B3 preflight: a missing worker accepted', PA, "!path.isAbsolute(workerModule)||!exists(workerModule))", "!path.isAbsolute(workerModule))", TT),
 ('prereq: DNS check-config without conntrack accepted', 'network/wg-provider/main.mjs', "if(hostServices?.dns&&!conntrack){console.error(", "if(false){console.error(", ['test/wg-provider-dns-kernel.test.mjs']),
 ('prereq: install.sh drops hostServices on reinstall', 'network/wg-provider/install.sh', '"ports","hostServices"].filter', '"ports"].filter', ['test/wg-provider-dns-kernel.test.mjs']),
 ('windows: loopback UDP for DNS in the sandbox policy', 'network/wg-circuit-runtime.mjs', "programs:[{path:files.wg,udp:[udpPeer],connect:", "programs:[{path:files.wg,udp:[udpPeer,...dnsTcp],connect:", TT),
 ('P3 route-dns: the loopback transport shares the per-source bucket', 'relay/dns-relay.js', "(dnsTransport && LOOPBACK_RELAY.has(src) ? dnsTransport(\"transport\") : dnsPerSource(src))", "dnsPerSource(src)", ['test/route-dns-transport-rate.test.mjs']),
 ('P3 route-dns: any loopback-range source gets the aggregate', 'relay/dns-relay.js', "LOOPBACK_RELAY.has(src)", "String(src).startsWith(\"127.\")", ['test/route-dns-transport-rate.test.mjs']),
 ('P3 gen-config: no transport aggregate for a DNS host', 'network/host-services/stage-tool.mjs', "return { transportRateLimitPerSec: rate, transportRateLimitCap: 2 * rate }; })() : {})", "return {}; })() : {})", ['test/route-dns-transport-rate.test.mjs']),
 ('kernel: DNS target outside 10.77/16 accepted', K, "return x<=255&&y<=255&&y!==0&&y!==255&&!(x===0&&y<=1)?a:null;};", "return a||null;};", ['test/wg-provider-dns-kernel.test.mjs']),
]
# baseline: the UNMUTATED tree passes these suites (else a "killed" mutant proves nothing)
base = subprocess.run(['node', '--test', '--test-concurrency=1', '--test-timeout=60000', '--test-reporter=tap', 'test/wg-provider-host-services.test.mjs',
                       'test/wg-provider-dns-kernel.test.mjs', 'test/wg-provider.test.mjs', 'test/host-service-transport.test.mjs'], cwd=TREE, capture_output=True, text=True,
                      env={**os.environ, 'MAIN_KERNEL': os.path.join(H, '..', 'enclave', K)})
open(os.path.join(H, 'logs', 'mutation-baseline.tap'), 'w').write(base.stdout + base.stderr)
summary = [l for l in base.stdout.splitlines() if l.startswith('# ') and l.split()[1] in ('tests', 'pass', 'fail', 'skipped')]
print('BASELINE', ' '.join(summary), flush=True)
if base.returncode != 0: print('BASELINE FAILED: no mutants run'); sys.exit(2)
if os.environ.get('ONLY_P3'): M = [m for m in M if m[0].startswith('P3 ')]
out = []
for name, f, old, new, tests in M:
    shutil.rmtree(SCR, ignore_errors=True); os.makedirs(os.path.dirname(SCR), exist_ok=True)
    subprocess.run(['cp', '-al', TREE, SCR], check=True)
    src = open(os.path.join(TREE, f)).read()
    if src.count(old) != 1: out.append({'mutant': name, 'result': 'NOT APPLIED (pattern count %d)' % src.count(old)}); continue
    tmp = os.path.join(SCR, f + '.mut'); open(tmp, 'w').write(src.replace(old, new)); os.replace(tmp, os.path.join(SCR, f))
    assert open(os.path.join(TREE, f)).read() == src, 'the tree changed'
    t0 = time.time()
    r = subprocess.run(['node', '--test', '--test-concurrency=1', '--test-timeout=60000'] + tests, cwd=SCR, capture_output=True, text=True,
                       env={**os.environ, 'MAIN_KERNEL': os.path.join(H, '..', 'enclave', K)})
    failed = [l[len('not ok '):].split(' - ', 1)[-1] for l in r.stdout.splitlines() if l.lstrip().startswith('not ok ') and ' - test/' not in l]
    out.append({'mutant': name, 'file': f, 'killed': r.returncode != 0, 'failing': [x.strip() for x in failed][:4], 'secs': round(time.time() - t0, 1)})
    print(('KILLED   ' if r.returncode != 0 else 'SURVIVED ') + name + ('  <- ' + '; '.join(out[-1]['failing'][:2]) if failed else ''), flush=True)
shutil.rmtree(os.path.join(H, 'mut'), ignore_errors=True)
json.dump(out, open(os.path.join(H, 'logs', 'mutation.json'), 'w'), indent=1)
alive = [o['mutant'] for o in out if not o.get('killed')]
print('MUTANTS %d, KILLED %d, SURVIVED/NOT APPLIED: %s' % (len(out), len(out) - len(alive), alive or 'none'))
sys.exit(1 if alive else 0)
