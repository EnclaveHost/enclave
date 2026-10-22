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
  assert.equal((r.match(/accept/g) || []).length, (ruleset({ publicAddress: '203.0.113.7', uplink: 'eth0' }).match(/accept/g) || []).length + 1, 'exactly one new accept');
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
