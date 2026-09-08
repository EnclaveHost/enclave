import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of ['gpu-util-window', 'gpu-capture-run', 'framed-observer', 'framed-forward']) {
  test(`host capture: ${name} boundaries and owned subprocess lifecycle`, () => {
    const path = fileURLToPath(new URL(`./shielded-${name}.py`, import.meta.url));
    execFileSync('python3', [path], { timeout: 60_000, stdio: 'pipe' });
  });
}
