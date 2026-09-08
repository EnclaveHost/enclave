import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('the slowest successful wire call retains exact phases and public metadata across later calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-wire-peak-'));
  try {
    const bin = join(dir, 'peak');
    const flags = ['-std=c11', '-O1', '-Wall', '-Wextra', '-Werror', '-ffunction-sections', '-fdata-sections'];
    if (process.env.SHIELDED_TEST_SANITIZE === '1') flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
    execFileSync('cc', [...flags, fileURLToPath(new URL('./fixtures/shielded-wire-peak.c', import.meta.url)),
      '-Wl,--gc-sections', '-o', bin], {timeout:30_000});
    execFileSync(bin, {timeout:5_000, env:Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_')))});
  } finally {rmSync(dir, {recursive:true, force:true});}
});
