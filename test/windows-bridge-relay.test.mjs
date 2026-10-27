import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Windows bridge relay promptly releases completed streams and preserves half-close drain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shield-bridge-relay-'));
  try {
    const exe = join(dir, process.platform === 'win32' ? 'test.exe' : 'test');
    const source = fileURLToPath(new URL('../windows/vbslike/host/src/bridge_relay.rs', import.meta.url));
    execFileSync('rustc', ['--edition=2021', '--test', source, '-o', exe], { timeout: 30000 });
    const output = execFileSync(exe, [], { encoding: 'utf8', timeout: 20000 });
    assert.match(output, /3 passed; 0 failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
