// A WireGuard provider configured as minimal transport (scripts/check-transport-profile.mjs; work/hosted-service-placement):
// the transport-only shape passes; each application responsibility found on the fleet's providers refuses, by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkTransportProfile } from '../scripts/check-transport-profile.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINIMAL = { bootstrap: 'explicit', operatorKeyFile: '/etc/enclave-network/operator.key', publicAddress: '203.0.113.7', uplink: 'eth0', roles: ['guard', 'ingress', 'egress'],
  rpc: ['https://rpc-a.example', 'https://rpc-b.example'], directories: ['https://dir-a.example/'], authorityPins: { deployments: '0x' + '11'.repeat(20), registry: '0x' + '22'.repeat(20) },
  checkers: ['0x' + '33'.repeat(20)], zone: 'app.example', probeZone: 'probe.example', pricePerGiB6: 0 };

test('the minimal transport shape passes, and names what it keeps', () => {
  const r = checkTransportProfile(MINIMAL);
  assert.equal(r.ok, true, r.violations.join('; '));
  assert.deepEqual(r.separateRoles, []);
  assert.ok(r.transport.some((t) => /no TLS termination/.test(t)));
});

test('application responsibilities on a transport machine refuse, each by name', () => {
  for (const [over, re] of [
    [{ localRoutes: { 'custodian.example': { host: '127.0.0.1', tls: 8443, http: 8080 } } }, /localRoutes serves 1 on-box service name/],
    [{ noSniRoute: { host: '127.0.0.1', tls: 9443 } }, /noSniRoute/],
    [{ relay: 'https://api.enclave.host' }, /custom-domain map comes from the Enclave relay/],
    [{ bootstrap: undefined }, /bootstrap is legacy/],
    [{ roles: ['guard', 'dns'] }, /role "dns" is not a transport role/],
  ]) {
    const cfg = { ...MINIMAL, ...over }; for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
    const r = checkTransportProfile(cfg);
    assert.equal(r.ok, false, JSON.stringify(over)); assert.ok(r.violations.some((v) => re.test(v)), r.violations.join('; '));
  }
  const paid = checkTransportProfile({ ...MINIMAL, pricePerGiB6: 5, proofKeyFile: '/etc/enclave-network/proof.key' });
  assert.equal(paid.ok, true); assert.match(paid.separateRoles[0], /settlement/);
});

test('the command exits 1 on a non-transport configuration and never opens a key file it names', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-profile-'));
  try {
    const f = path.join(d, 'provider.json');
    fs.writeFileSync(f, JSON.stringify({ ...MINIMAL, operatorKeyFile: path.join(d, 'does-not-exist.key'), localRoutes: { 'site.example': { host: '127.0.0.1', tls: 8443, http: 8080 } } }));
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/check-transport-profile.mjs'), f], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr); assert.match(r.stdout, /localRoutes/);
    fs.writeFileSync(f, JSON.stringify({ ...MINIMAL, operatorKeyFile: path.join(d, 'does-not-exist.key') }));
    assert.equal(spawnSync(process.execPath, [path.join(REPO, 'scripts/check-transport-profile.mjs'), f], { encoding: 'utf8' }).status, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
