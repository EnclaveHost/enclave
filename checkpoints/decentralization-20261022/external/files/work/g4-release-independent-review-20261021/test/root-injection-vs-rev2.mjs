// Root's injected Windows ACL reproduction (challenge-host-tls-20261021/root-review-declaration.mjs, pinned a4adfcfb), ported
// to rev2's chain API: the SAME ACE values (Users write 0x2 on the file; Users read 1179785 on the file), plus a safe-chain
// CONTROL that must pass (non-vacuity). Read-only import of the reviewed tree; no network, no real ACL, no keys.
import fs from 'node:fs'; import { createHash } from 'node:crypto'; import assert from 'node:assert/strict';
const url = new URL('../../challenge-host-tls-20261021/tree/network/host-services/service-tls.mjs', import.meta.url);
const pin = '81cef1e8d35c8aef3fef268bda017f95abb9d704cc9595f77023803c5cb28bb1';
assert.equal(createHash('sha256').update(fs.readFileSync(url)).digest('hex'), pin, 'not the reviewed rev2 bytes');
const { checkDeclarationFile } = await import(url);
const SY = 'S-1-5-18', BA = 'S-1-5-32-544', LS = 'S-1-5-19', TI = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', BU = 'S-1-5-32-545';
const full = (sid) => ({ sid, allow: true, rights: 2032127, inheritOnly: false });
const dir = (path, owner, extra = []) => ({ path, exists: true, reparse: false, dir: true, owner, aces: [full(SY), full(BA), ...extra] });
const file = (extra) => ({ path: 'C:\\ProgramData\\Enclave\\network\\challenge\\challenge-front.json', exists: true, reparse: false, dir: false, owner: SY,
  aces: [full(SY), full(BA), { sid: LS, allow: true, rights: 1179785, inheritOnly: false }, ...extra] });
const chain = (fileExtra) => [dir('C:\\', TI, [{ sid: BU, allow: true, rights: 1179817, inheritOnly: false }]), dir('C:\\ProgramData', SY), dir('C:\\ProgramData\\Enclave', BA),
  dir('C:\\ProgramData\\Enclave\\network', BA), dir('C:\\ProgramData\\Enclave\\network\\challenge', BA, [{ sid: LS, allow: true, rights: 1179785, inheritOnly: false }]), file(fileExtra)];
const run = async (c) => { try { return { ok: await checkDeclarationFile('C:\\x', { platform: 'win32', windowsChain: async () => c }) }; } catch (e) { return { refused: e.message }; } };
const out = {
  control_safeChain: await run(chain([])),
  root_unsafeFileWrite_Users_0x2: await run(chain([{ sid: BU, allow: true, rights: 2, inheritOnly: false }])),
  root_broadRead_Users_1179785: await run(chain([{ sid: BU, allow: true, rights: 1179785, inheritOnly: false }])),
};
console.log(JSON.stringify(out, null, 1));
assert.ok(out.control_safeChain.ok, 'control must pass (else the test is vacuous)');
assert.ok(out.root_unsafeFileWrite_Users_0x2.refused, 'root R1 case must be refused');
assert.ok(out.root_broadRead_Users_1179785.refused, 'root R2 case must be refused');
console.log('PASS: root\'s injected cases are refused by rev2; the safe control passes');
