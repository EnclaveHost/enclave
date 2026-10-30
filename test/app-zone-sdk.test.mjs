// names.appZone in the public startup package: the SDK accepts and refuses exactly what the measured guest's Go check
// does (isolation/m2/bootstrap/appzone_test.go reads the same vectors). The shared owner-name vectors are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {verifyPackage, MAX_APP_ZONE_CHALLENGES} from '../sdk/bootstrap/package.mjs';
const av = JSON.parse(fs.readFileSync(new URL('../isolation/m2/bootstrap/testdata/appzone-vectors.json', import.meta.url)));
const intent = (b) => ({version: 1, sha256: createHash('sha256').update(b).digest('hex')});
test('JS and Go agree on every app-zone vector', () => {
  assert.ok(av.cases.length >= 15 && av.cases.some((c) => c.valid) && av.cases.some((c) => !c.valid));
  assert.equal(MAX_APP_ZONE_CHALLENGES, 8);
  for (const c of av.cases) {
    let err = null; try { verifyPackage(Buffer.from(c.manifest), intent(c.manifest)); } catch (e) { err = e; }
    assert.equal(err === null, c.valid, `${c.name}: ${err?.message ?? 'accepted'}`);
  }
});
