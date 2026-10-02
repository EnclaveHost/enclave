import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Shield group keys preserve aliases, matching order, exact lengths and owned storage', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'shield-group-key-'));
  const sanitize = process.env.SHIELDED_TEST_SANITIZE === '1'
    ? ['-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [];
  try {
    const bin = join(dir, 'group-key');
    execFileSync('c++', ['-std=c++17', '-O1', ...sanitize, '-Wall', '-Wextra', '-Werror',
      join(root, 'test/fixtures/shielded-group-key.cpp'), '-o', bin],
      { timeout: 60_000, stdio: 'pipe' });
    execFileSync(bin, { timeout: 10_000, stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
