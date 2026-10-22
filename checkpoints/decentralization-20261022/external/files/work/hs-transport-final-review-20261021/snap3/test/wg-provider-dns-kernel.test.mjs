// The provider kernel's DNS 53 packet forward (network/wg-provider/kernel.mjs, work/host-service-transport-20261021): off by
// default and then byte-identical to the ruleset before it; when on, rate limits before the DNAT, forward/masquerade only
// for that DNAT, and the map holds at most one exit-peer address (never anything outside 10.77/16).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ruleset, Kernel, dnsLimits } from '../network/wg-provider/kernel.mjs';

const MAIN = process.env.MAIN_KERNEL;   // the unchanged kernel.mjs of the source reference (work/enclave), when given
test('without dns the ruleset is exactly the previous one', async () => {
  const now = ruleset({ publicAddress: '203.0.113.7', uplink: 'eth0' });
  assert.ok(!/dns|limit rate|ct count|dnat/.test(now));
  if (MAIN) {
    const old = await import(MAIN);
    assert.equal(now, old.ruleset({ publicAddress: '203.0.113.7', uplink: 'eth0' }), 'byte-identical to the source reference');
    assert.equal(ruleset({ publicAddress: '198.51.100.9', uplink: 'ens3', dns: null }), old.ruleset({ publicAddress: '198.51.100.9', uplink: 'ens3' }));
  }
});

test('with dns: limits come before the DNAT; only DNATed 53 is forwarded and masqueraded; empty map forwards nothing', () => {
  const r = ruleset({ publicAddress: '203.0.113.7', uplink: 'eth0', dns: { perSourcePps: 10, perSourceBurst: 30, globalPps: 500, globalBurst: 900, tcpPerSource: 4 } });
  const guard = r.indexOf('chain dns_guard'), limits = r.indexOf('chain dns_limits'), nat = r.indexOf('chain dns_dstnat');
  assert.ok(guard > 0 && limits > guard && nat > limits);
  assert.match(r, /type filter hook prerouting priority -150;/);
  assert.match(r, /type nat hook prerouting priority dstnat;/);
  assert.match(r, /iifname "eth0" ip daddr 203\.0\.113\.7 meta l4proto \{ tcp, udp \} th dport 53 jump dns_limits/);
  assert.match(r, /limit rate over 500\/second burst 900 packets drop/);
  assert.match(r, /update @dns_rate4 \{ ip saddr limit rate over 10\/second burst 30 packets \} drop/);
  assert.match(r, /ct state new add @dns_conn4 \{ ip saddr ct count over 4 \} drop/);
  assert.match(r, /udp dport 53 dnat ip to udp dport map @dns_dnat/);
  assert.match(r, /tcp dport 53 dnat ip to tcp dport map @dns_dnat/);
  // the forward accept is ONLY for DNATed 53 to wg-exit, and sits before the "nothing into a tunnel" drop
  const fwd = r.indexOf('iifname "eth0" oifname "wg-exit" ct status dnat meta l4proto { tcp, udp } th dport 53 accept'), drop = r.indexOf('oifname { "wg-exit", "wg-guard" } drop');
  assert.ok(fwd > 0 && drop > fwd);
  assert.match(r, /oifname "wg-exit" ct status dnat meta l4proto \{ tcp, udp \} th dport 53 masquerade/);
  // rule lines ending in "accept" (chain headers end in "policy accept;"): exactly one new one, and the new chains' policies
  const accepts = (x) => (x.match(/accept$/gm) || []).length;
  assert.equal(accepts(r), accepts(ruleset({ publicAddress: '203.0.113.7', uplink: 'eth0' })) + 1, 'exactly one new accept rule');
});

test('dns limits are bounded and consistent', () => {
  assert.equal(dnsLimits(null), null);
  assert.deepEqual(dnsLimits(true), { perSourcePps: 20, perSourceBurst: 40, globalPps: 2000, globalBurst: 4000, tcpPerSource: 8 });
  for (const bad of [{ perSourcePps: 0 }, { globalPps: 1.5 }, { perSourceBurst: 1 }, { perSourcePps: 3000 }, { tcpPerSource: 2e6 }]) assert.throws(() => dnsLimits(bad), /dns/, JSON.stringify(bad));
});

test('sync: the map is flushed and holds at most the one valid exit-peer target; anything else forwards nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-kernel-'));
  try {
    const scripts = [], lines = [];
    const exec = async (bin, args) => { if (bin === 'nft' && args[0] === '-f') scripts.push(fs.readFileSync(args[1], 'utf8')); return { stdout: '' }; };
    const k = new Kernel({ publicAddress: '203.0.113.7', keyDir: dir, dns: true, exec, log: (m) => lines.push(m) });
    await k.sync({ egress: [], targets: [], dns: '10.77.3.9' });
    assert.match(scripts.at(-1), /flush map inet enclave_net dns_dnat\nadd element inet enclave_net dns_dnat \{ 53 : 10\.77\.3\.9 \}/);
    assert.match(lines.at(-1), /now forwarded to 10\.77\.3\.9/);
    for (const bad of ['10.78.0.5', '44.0.0.1', '10.77.0.1', '10.77.0.0', '10.77.1.255', '10.77.300.1', '127.0.0.1', '10.77.1.2; flush ruleset', null]) {
      await k.sync({ egress: [], targets: [], dns: bad });
      assert.match(scripts.at(-1), /flush map inet enclave_net dns_dnat/);
      assert.ok(!/dns_dnat \{/.test(scripts.at(-1)), `target ${bad} must not be forwarded to`);
    }
    // a kernel without dns never touches the map (the table has none)
    const plain = new Kernel({ publicAddress: '203.0.113.7', keyDir: dir, exec });
    await plain.sync({ egress: [], targets: [], dns: '10.77.3.9' });
    assert.ok(!/dns_dnat/.test(scripts.at(-1)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wg-provider --ruleset prints exactly the table a configuration applies (for `nft -c` before a restart), touching nothing', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruleset-'));
  try {
    const base = { bootstrap: 'explicit', operatorKeyFile: path.join(dir, 'never-read.key'), publicAddress: '203.0.113.7', uplink: 'eth0', roles: ['guard', 'ingress', 'egress'],
      rpc: ['https://rpc-a.example', 'https://rpc-b.example'], directories: ['https://dir-a.example/'], authorityPins: { deployments: '0x' + '11'.repeat(20), registry: '0x' + '22'.repeat(20), connectivity: '0x' + '0'.repeat(40), sessionVaultFactory: '0x' + '0'.repeat(40) },
      checkers: ['0x' + '33'.repeat(20)], zone: 'app.example', probeZone: 'probe.example', pricePerGiB6: 0 };
    const run = (cfg) => { const f = path.join(dir, 'p.json'); fs.writeFileSync(f, JSON.stringify(cfg)); return spawnSync(process.execPath, [path.join(REPO, 'network/wg-provider/main.mjs'), '--ruleset', f], { encoding: 'utf8' }); };
    const plain = run(base); assert.equal(plain.status, 0, plain.stderr); assert.equal(plain.stdout, ruleset({ publicAddress: '203.0.113.7', uplink: 'eth0' }));
    const dns = run({ ...base, hostServices: { zone: 'app.example', platformHostPolicy: 'production', dns: { hosts: ['0x' + 'a1'.repeat(32)], perSourcePps: 10, perSourceBurst: 20 } } });
    assert.equal(dns.status, 0, dns.stderr);
    assert.equal(dns.stdout, ruleset({ publicAddress: '203.0.113.7', uplink: 'eth0', dns: { perSourcePps: 10, perSourceBurst: 20 } }));
    assert.match(dns.stdout, /limit rate over 10\/second burst 20 packets/);
    assert.equal(fs.existsSync(path.join(dir, 'never-read.key')), false);
    const bad = run({ ...base, hostServices: { zone: 'app.example' } }); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /platformHostPolicy is required/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N2: the UDP 53 conntrack flows are deleted on EVERY target change AND on the first assignment of a run; a missing tool is said once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-ct-'));
  try {
    const calls = [], lines = []; let mode = 'ok';
    const exec = async (bin, args) => { calls.push([bin, ...args]);
      if (bin === 'conntrack' && mode === 'absent') throw Object.assign(new Error('spawn conntrack ENOENT'), { code: 'ENOENT' });
      if (bin === 'conntrack' && mode === 'none') throw Object.assign(new Error('Command failed'), { stderr: 'conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.' });
      return { stdout: '' }; };
    const CT = ['conntrack', '-D', '-p', 'udp', '--orig-dst', '203.0.113.7', '--orig-port-dst', '53'];
    const k = new Kernel({ publicAddress: '203.0.113.7', keyDir: dir, dns: true, exec, log: (m) => lines.push(m) });
    const ct = () => calls.filter((c) => c[0] === 'conntrack').length;
    await k.sync({ egress: [], targets: [], dns: '10.77.3.9' }); assert.equal(ct(), 1, 'first assignment of a run: a previous run\'s DNATed flows are deleted');
    assert.deepEqual(calls.find((c) => c[0] === 'conntrack'), CT, 'exactly kernel.mjs\'s one command');
    await k.sync({ egress: [], targets: [], dns: '10.77.3.9' }); assert.equal(ct(), 1, 'the same target: nothing');
    await k.sync({ egress: [], targets: [], dns: '10.77.4.4' }); assert.equal(ct(), 2, 'a change: deleted');
    await k.sync({ egress: [], targets: [], dns: null }); assert.equal(ct(), 3, 'to nobody (revoke, unhealthy): deleted');
    // a restarted provider whose first sync assigns NOBODY still deletes what the previous run left
    const r2 = new Kernel({ publicAddress: '203.0.113.7', keyDir: dir, dns: true, exec, log: (m) => lines.push(m) });
    await r2.sync({ egress: [], targets: [], dns: null }); assert.equal(ct(), 4);
    mode = 'none'; await k.sync({ egress: [], targets: [], dns: '10.77.3.9' }); assert.equal(ct(), 5);
    assert.ok(!lines.some((l) => /conntrack delete failed/.test(l)), '"0 flow entries" is not a failure');
    mode = 'absent'; await k.sync({ egress: [], targets: [], dns: '10.77.4.4' }); await k.sync({ egress: [], targets: [], dns: '10.77.3.9' });
    assert.equal(lines.filter((l) => /conntrack delete failed/.test(l)).length, 1, 'said once');
    // a provider without dns never runs conntrack
    const plain = new Kernel({ publicAddress: '203.0.113.7', keyDir: dir, exec }); const before = ct();
    await plain.sync({ egress: [], targets: [], dns: '10.77.3.9' }); assert.equal(ct(), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N2: DNS forwarding FAILS CLOSED without conntrack (no DNS rules, no pins); N4: the provider persists its accepted policy under stateDir', async () => {
  const { providerDnsPlan } = await import('../network/wg-provider/host-services-config.mjs');
  const h = { zone: 'app.example', dns: { hosts: ['0x' + 'a1'.repeat(32)], staleMs: 180000, limits: { perSourcePps: 20 } } };
  assert.deepEqual(providerDnsPlan(null, null), { on: false, limits: null, pins: null, reason: null });
  assert.deepEqual(providerDnsPlan({ zone: 'app.example' }, null), { on: false, limits: null, pins: null, reason: null });
  const off = providerDnsPlan(h, null); assert.equal(off.on, false); assert.equal(off.limits, null); assert.equal(off.pins, null); assert.match(off.reason, /NOT forwarded \(fail closed\)/);
  assert.deepEqual(providerDnsPlan(h, '/usr/sbin/conntrack'), { on: true, limits: h.dns.limits, pins: { hosts: h.dns.hosts, staleMs: 180000 }, reason: null });
  const { fileURLToPath } = await import('node:url');
  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../network/wg-provider/main.mjs'), 'utf8');
  assert.match(main, /new Kernel\(\{[^)]*dns:dnsPlan\.limits/, 'the kernel gets DNS rules only from the plan');
  assert.match(main, /\.\.\.\(dnsPlan\.pins\?\{dns:dnsPlan\.pins\}:\{\}\)/, 'the provider pins DNS hosts only from the plan');
  assert.match(main, /const dnsProbe=dnsOn\?/);
  assert.match(main, /createHostPolicyRuntime\(resolved,\{log,store:fileStore\(path\.join\(stateDir,'platform-host-policy\.json'\)\)\}\)/, 'N4: persisted like host-service-gate');
});

test('B5 probe: healthy only for an answer with the same id, the response bit and NOERROR; silence, REFUSED, a wrong id or a closed port is not', async () => {
  const dgram = await import('node:dgram');
  const { probeDns, soaQuestion } = await import('../network/wg-provider/dns-probe.mjs');
  const q = soaQuestion('app.example', 0x1234);
  assert.equal(q.readUInt16BE(0), 0x1234); assert.equal(q.readUInt16BE(q.length - 4), 6, 'an SOA question');
  const stub = async (reply) => { const s = dgram.createSocket('udp4'); s.on('message', (m, r) => { const out = reply(m); if (out) s.send(out, r.port, r.address); });
    await new Promise((ok) => s.bind(0, '127.0.0.1', ok)); return s; };
  const answer = (rcode, qr = true, idDelta = 0) => (m) => { const b = Buffer.from(m); b.writeUInt16BE((m.readUInt16BE(0) + idDelta) & 0xffff, 0); b[2] = (qr ? 0x84 : 0); b[3] = rcode; return b; };
  const cases = [['NOERROR answer', answer(0), true], ['REFUSED', answer(5), false], ['not a response', answer(0, false), false], ['wrong id', answer(0, true, 1), false], ['silent', () => null, false]];
  for (const [what, reply, want] of cases) {
    const s = await stub(reply);
    try { assert.equal(await probeDns({ address: '127.0.0.1', port: s.address().port, zone: 'app.example', timeoutMs: 400 }), want, what); } finally { s.close(); }
  }
  const s = await stub(() => null); const port = s.address().port; s.close();
  assert.equal(await probeDns({ address: '127.0.0.1', port, zone: 'app.example', timeoutMs: 400 }), false, 'closed port');
  assert.equal(await probeDns({ address: '127.0.0.1', port, zone: '', timeoutMs: 100 }), false, 'no zone: never throws');
});

test('activation prerequisite: with hostServices.dns, --check-config requires conntrack; without dns nothing changes', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-check-'));
  try {
    const base = { bootstrap: 'explicit', operatorKeyFile: path.join(dir, 'never-read.key'), publicAddress: '203.0.113.7', uplink: 'eth0', roles: ['guard', 'ingress', 'egress'],
      rpc: ['https://rpc-a.example', 'https://rpc-b.example'], directories: ['https://dir-a.example/'], authorityPins: { deployments: '0x' + '11'.repeat(20), registry: '0x' + '22'.repeat(20), connectivity: '0x' + '0'.repeat(40), sessionVaultFactory: '0x' + '0'.repeat(40) },
      checkers: ['0x' + '33'.repeat(20)], zone: 'app.example', probeZone: 'probe.example', pricePerGiB6: 0 };
    const withDns = { ...base, hostServices: { zone: 'app.example', platformHostPolicy: 'production', dns: { hosts: ['0x' + 'a1'.repeat(32)] } } };
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const run = (cfg, PATH) => { const f = path.join(dir, 'p.json'); fs.writeFileSync(f, JSON.stringify(cfg)); return spawnSync(process.execPath, [path.join(REPO, 'network/wg-provider/main.mjs'), '--check-config', f], { encoding: 'utf8', env: { ...process.env, PATH } }); };
    const missing = run(withDns, bin);
    assert.equal(missing.status, 1, missing.stdout); assert.match(missing.stderr, /needs conntrack/);
    fs.writeFileSync(path.join(bin, 'conntrack'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const present = run(withDns, bin);
    assert.equal(present.status, 0, present.stderr); assert.equal(JSON.parse(present.stdout).hostServices.conntrack, path.join(bin, 'conntrack'));
    fs.rmSync(path.join(bin, 'conntrack'));
    for (const cfg of [base, { ...base, hostServices: { zone: 'app.example', platformHostPolicy: 'production' } }]) {
      const r = run(cfg, bin); assert.equal(r.status, 0, r.stderr); assert.ok(!('conntrack' in (JSON.parse(r.stdout).hostServices || {})), 'no DNS: no conntrack requirement');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install.sh keeps the operator\'s hostServices and gates every DNS step (conntrack, nft -c of the exact ruleset, ufw 53) on it', async () => {
  const { fileURLToPath } = await import('node:url');
  const sh = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../network/wg-provider/install.sh'), 'utf8');
  assert.match(sh, /\["kind","hostId","pricePerGiB6","proofKeyFile","localRoutes","noSniRoute","budget","ports","hostServices"\]/, 'a reinstall must not drop hostServices');
  assert.match(sh, /\[ "\$DNS53" = 0 \] \|\| command -v conntrack >\/dev\/null \|\| DEBIAN_FRONTEND=noninteractive apt-get install -y -q conntrack/);
  assert.match(sh, /if \[ "\$DNS53" = 1 \]; then "\$NODE" "\$OPT\/\$REL\/wg-provider\.mjs" --ruleset "\$CFG\.new" \| nft -c -f -/);
  assert.match(sh, /if \[ "\$DNS53" = 1 \]; then for p in udp tcp; do ufw route allow in on "\$UPLINK" out on wg-exit to any port 53 proto \$p/);
  // the order: the release's own --check-config (which needs conntrack with dns) and the kernel check run BEFORE the switch
  assert.ok(sh.indexOf('--check-config "$CFG.new"') < sh.indexOf('mv "$CFG.new" "$CFG"') && sh.indexOf('--ruleset "$CFG.new"') < sh.indexOf('mv "$CFG.new" "$CFG"'));
});
