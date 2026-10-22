// Freeze EXACTLY what the provider's kernel.mjs (tree/) applies, for the native G2 run on a host with no Node:
//   frozen/ruleset-dns.nft      ruleset({publicAddress:'47.0.0.2', uplink:'eth0', dns:<defaults>})
//   frozen/sync-h1.nft          Kernel.sync({egress:[], targets:[], dns:'10.77.0.5'})   (the first host)
//   frozen/sync-h2.nft          ... dns:'10.77.0.6'                                       (the failover target)
//   frozen/sync-none.nft        ... dns:null                                              (revoked: nobody)
//   frozen/conntrack-flush.txt  the conntrack command kernel.mjs runs on a target change and on a run's first assignment
//   frozen/ruleset-plain.nft    the table WITHOUT dns (a provider rolled back: hostServices.dns removed)
//   frozen/flush-decisions.json whether kernel.mjs runs that command after each step of the flush scenario (fake exec)
//   frozen/SHA256SUMS
// Run with the tree's node (no kernel is touched: exec is captured).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { ruleset, Kernel, DNS_LIMITS } = await import(path.join(here, '../tree/network/wg-provider/kernel.mjs'));
const out = path.join(here, 'frozen'); fs.mkdirSync(out, { recursive: true });
const write = (f, s) => fs.writeFileSync(path.join(out, f), s);
write('ruleset-dns.nft', ruleset({ publicAddress: '47.0.0.2', uplink: 'eth0', dns: true }));
write('ruleset-plain.nft', ruleset({ publicAddress: '47.0.0.2', uplink: 'eth0' }));
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-freeze-'));
const captured = [];
const k = new Kernel({ publicAddress: '47.0.0.2', uplink: 'eth0', keyDir, dns: true,
  exec: async (bin, args) => { captured.push(bin === 'nft' ? { nft: fs.readFileSync(args[1], 'utf8') } : { cmd: [bin, ...args] }); return { stdout: '' }; } });
for (const [file, dns] of [['sync-h1.nft', '10.77.0.5'], ['sync-h2.nft', '10.77.0.6'], ['sync-none.nft', null]]) {
  const from = captured.length; await k.sync({ egress: [], targets: [], dns });
  write(file, captured.slice(from).find((c) => c.nft).nft);
}
const ct = captured.find((c) => c.cmd?.[0] === 'conntrack');
write('conntrack-flush.txt', ct.cmd.join(' ') + '\n');
// the flush scenario stage2.sh replays: one run (h1, h2, none), then a RESTARTED run whose first assignment is h2
const decide = async (kernel, dns) => { const from = captured.length; await kernel.sync({ egress: [], targets: [], dns }); return captured.slice(from).some((c) => c.cmd?.[0] === 'conntrack'); };
const exec2 = async (bin, args) => { captured.push(bin === 'nft' ? { nft: '' } : { cmd: [bin, ...args] }); return { stdout: '' }; };
const run1 = new Kernel({ publicAddress: '47.0.0.2', uplink: 'eth0', keyDir, dns: true, exec: exec2 }), run2 = new Kernel({ publicAddress: '47.0.0.2', uplink: 'eth0', keyDir, dns: true, exec: exec2 });
const decisions = { 'h1 (first assignment)': await decide(run1, '10.77.0.5'), 'h1 -> h2': await decide(run1, '10.77.0.6'), 'h2 -> none': await decide(run1, null),
  'restart, first assignment h2': await decide(run2, '10.77.0.6'), 'none -> h1': await decide(run1, '10.77.0.5'), 'h1 -> h1 (nothing pending)': await decide(run1, '10.77.0.5') };
write('flush-decisions.json', JSON.stringify(decisions) + '\n');
write('limits.json', JSON.stringify(DNS_LIMITS) + '\n');
fs.rmSync(keyDir, { recursive: true, force: true });
const files = fs.readdirSync(out).filter((f) => f !== 'SHA256SUMS').sort();
write('SHA256SUMS', files.map((f) => `${createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex')}  ${f}`).join('\n') + '\n');
console.log(fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8'));
