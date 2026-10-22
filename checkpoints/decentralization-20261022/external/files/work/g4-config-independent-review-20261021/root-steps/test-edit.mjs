// LOCAL fixture test of edit-privacy-config.mjs (no real config): the edit adds only the block, before walletAdmission;
// refusals: wrong CAS sha, non-enroll formatting, an existing block, a wrong block sha.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto'; import assert from 'node:assert/strict';
const sha = (b) => createHash('sha256').update(b).digest('hex'); const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-edit-'));
const block = fs.readFileSync(new URL('../config/challengeReplica.block.json', import.meta.url)); const bsha = sha(block); const bf = path.join(d, 'b.json'); fs.writeFileSync(bf, block);
const cfg = { version: 2, runner: '0x' + '22'.repeat(32), apps: [{ deploymentId: '0x' + '11'.repeat(32), expectedFile: 'C:\\x' }], enclaveNetwork: { relay: 'https://r', checkers: ['0x' + '57'.repeat(20)], apps: 'all', paceMbps: 5, walletAdmission: { file: 'C:\\w.json' } } };
const run = (txt, exp = sha(txt), bs = bsha) => { const f = path.join(d, 'c.json'), o = path.join(d, 'o.json'); fs.writeFileSync(f, txt); try { fs.rmSync(o, { force: true });
  const r = execFileSync(process.execPath, [new URL('./edit-privacy-config.mjs', import.meta.url).pathname, f, o, bf, exp, bs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: JSON.parse(r), out: fs.readFileSync(o, 'utf8') }; }
  catch (e) { return { refused: String(e.stderr) }; } };
const base = JSON.stringify(cfg, null, 2) + '\n';
const r = run(base); assert.ok(r.ok, JSON.stringify(r));
const k = Object.keys(JSON.parse(r.out).enclaveNetwork); assert.deepEqual(k.slice(-2), ['challengeReplica', 'walletAdmission']);
const back = JSON.parse(r.out); delete back.enclaveNetwork.challengeReplica; assert.equal(JSON.stringify(back, null, 2) + '\n', base, 'apps and every other byte preserved');
assert.ok(run(base, '0'.repeat(64)).refused.includes('CAS'));
assert.ok(run(JSON.stringify(cfg)).refused.includes('network-enroll format'));
assert.ok(run(base, sha(base), '0'.repeat(64)).refused.includes('reviewed bytes'));
assert.ok(run(r.out).refused.includes('already present'));
const nw = JSON.parse(JSON.stringify(cfg)); delete nw.enclaveNetwork.walletAdmission; const r2 = run(JSON.stringify(nw, null, 2) + '\n'); assert.equal(Object.keys(JSON.parse(r2.out).enclaveNetwork).at(-1), 'challengeReplica');
// network-enroll a9729786 writes WITHOUT a final newline (writeAtomic(JSON.stringify(cfg, null, 2))): accepted, ending kept
const enrollText = JSON.stringify(cfg, null, 2); const r3 = run(enrollText); assert.ok(r3.ok, JSON.stringify(r3));
assert.ok(!r3.out.endsWith('\n'), 'enroll format kept'); const b3 = JSON.parse(r3.out); delete b3.enclaveNetwork.challengeReplica; assert.equal(JSON.stringify(b3, null, 2), enrollText);
// what network-enroll would now compute (its key order: ..., challengeReplica, walletAdmission LAST) equals the edited section,
// so its next pass is a no-op (no rewrite, no agent restart)
const e3 = JSON.parse(r3.out).enclaveNetwork, want = { ...Object.fromEntries(Object.entries(e3).filter(([k]) => !['challengeReplica', 'walletAdmission'].includes(k))), challengeReplica: e3.challengeReplica, walletAdmission: e3.walletAdmission };
assert.equal(JSON.stringify(e3), JSON.stringify(want));
assert.ok(run(enrollText + '\n\n').refused.includes('network-enroll format'), 'any other ending refuses');
fs.rmSync(d, { recursive: true, force: true }); console.log('edit-privacy-config: 9/9 PASS');
