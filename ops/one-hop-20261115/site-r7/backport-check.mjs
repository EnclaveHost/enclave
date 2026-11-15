// The backported r6 source behaves as main f814b020a requires (test/network-policy.test.mjs, test/enclave-network-site.test.mjs):
// node backport-check.mjs SOURCE_ENCLAVE_DIR
import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2]);
const core = await import(pathToFileURL(root + '/network/network-policy-core.mjs'));
const id = '0x' + '9a'.repeat(32);
const policy = guard => ({ version: 5, deploymentId: id, nonce: 3, issuedAt: 1794700000, mode: 'enclave-network', fallback: 'none', enclaveNetwork: { routes: 2, guard, maxPricePerGiB6: 0, budget6: 0 } });
// the validator: guard is the owner's boolean, nothing else
const validate = core.validateNetworkPolicy;
for (const g of [true, false]) assert.equal(validate(policy(g)).enclaveNetwork.guard, g);
for (const g of [undefined, null, 0, 1, 'false', 'true', {}]) assert.throws(() => validate(policy(g)), /invalid Enclave network settings/);
assert.match(core.networkPolicyMessage(policy(false)), /^enclave-network:policy:v5\n.*"guard":false/s);
// the tab's helpers, taken out of the module (it imports the page's wallet and chain code)
const src = fs.readFileSync(root + '/site/js/core/enclave-network.js', 'utf8');
const a = src.indexOf('export const ONE_HOP_PRIVACY='), b = src.indexOf('export async function renderEnclaveNetwork(');
assert.ok(a > 0 && b > a);
const line = start => { const l = src.split('\n').filter(l => l.startsWith(start)); assert.equal(l.length, 1, start); return l[0]; };
const m = new Function(line('const esc=') + '\n' + line('const toU6=') + '\n' + src.slice(a, b).replace(/export (const|function)/g, '$1') + '; return { esc, ONE_HOP_PRIVACY, oneHopControl, enclaveNetworkChoice, circuitLine };')();
const esc = m.esc;
assert.match(m.ONE_HOP_PRIVACY, /a single provider carries the whole route: it sees the host's IP address together with this app's visitors/);
// what the owner signs
assert.deepEqual(m.enclaveNetworkChoice({ routes: '2', oneHop: false, price: '0', budget: '0' }), { routes: 2, guard: true, maxPricePerGiB6: 0, budget6: 0 });
assert.deepEqual(m.enclaveNetworkChoice({ routes: '1', oneHop: true, price: '0.5', budget: '3' }), { routes: 1, guard: false, maxPricePerGiB6: 500000, budget6: 3000000 });
assert.throws(() => m.enclaveNetworkChoice({ routes: '2', oneHop: true, price: '1', budget: '0' }), /price limit needs a budget/);
for (const oneHop of [true, false]) validate({ ...policy(true), enclaveNetwork: m.enclaveNetworkChoice({ routes: '2', oneHop, price: '0', budget: '0' }) });
// the box: it can be ticked only where the host reports the setting; a signed choice can always be taken off
const box = o => m.oneHopControl(o), disabled = h => / disabled/.test(h), checked = h => / checked/.test(h);
assert.equal(disabled(box({ checked: false, hostAllows: null })), true);
assert.equal(disabled(box({ checked: true, hostAllows: null })), false); assert.equal(checked(box({ checked: true, hostAllows: null })), true);
for (const hostAllows of [true, false]) { assert.equal(disabled(box({ checked: false, hostAllows })), false); assert.equal(checked(box({ checked: false, hostAllows })), false); }
assert.match(box({ checked: false, hostAllows: true }), /This app&#39;s host allows it\./);
assert.match(box({ checked: false, hostAllows: false }), /does not allow it: routes keep their guard there/);
assert.match(box({ checked: false, hostAllows: null }), /has not reported that it knows this setting/);
for (const hostAllows of [true, false, null]) { const h = box({ checked: false, hostAllows }); assert.match(h, /name="oneHop"/); assert.match(h, /Shorter path, less private\./); assert.ok(h.includes(esc(m.ONE_HOP_PRIVACY))); }
// the route line
const exit = { region: 'sfo3', address: '192.0.2.7' }, guard = { region: 'tor1' };
assert.match(m.circuitLine({ kind: 'network', guard: null, exit, healthy: true, ingress: true }), /^Route: one hop through sfo3 192\.0\.2\.7 \(no guard: this provider sees the host\) — healthy · website$/);
assert.match(m.circuitLine({ kind: 'network', guard, exit, healthy: true, egress: true }), /^Route: guard tor1 → exit sfo3 192\.0\.2\.7 — healthy · outbound$/);
assert.match(m.circuitLine({ kind: 'network', guard, exit, healthy: false, standby: true }), /standing by — <span class="warn">checking<\/span>$/);
assert.match(m.circuitLine({ kind: 'byo', healthy: true }), /^Your WireGuard peer — healthy$/);
assert.match(m.circuitLine({ kind: 'host', healthy: true }), /^The host's own connection — healthy$/);
assert.doesNotMatch(m.circuitLine({ kind: 'network', guard: null, exit: { region: '<b>', address: '"x' }, healthy: true }), /<b>|"x/);
// the form: the box is in the network block, the signed setting comes from enclaveNetworkChoice, and the tab still posts to the relay only
assert.equal(src.split('oneHopControl(').length - 1, 2); assert.equal(src.split('enclaveNetworkChoice(').length - 1, 2);
assert.match(src, /hostAllows:typeof host\?\.oneHop==="boolean"\?host\.oneHop:null/);
assert.equal(src.includes('guard:true'), false);
console.log('backport ok');
