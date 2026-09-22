import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), gg = join(root, 'wasm/ggml-shielded');
const flags = ['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Wall','-Wextra'];
const env = {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_'))),
  ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS:'halt_on_error=1'};

// The readiness predicate decides whether trusted work may run inside an
// exchange's idle window. The real graph never presents a positive case, so a
// full run exercises only rejection; these cases are built by hand.
test('deferred-work readiness: accepts completed disjoint sources, rejects the live exchange, its siblings, reshape aliases and a rejected reply', t => {
  const headers = process.env.GGML_SRC || join(homedir(), 'q4-calib-work/llama-src');
  if (!existsSync(join(headers, 'ggml/include/ggml.h'))) return t.skip('needs GGML_SRC for ggml.h');
  const dir = mkdtempSync(join(tmpdir(), 'shielded-overlap-ready-'));
  try {
    const bin = join(dir, 'ready');
    execFileSync('c++', [...flags, '-std=c++17', '-I' + gg, '-I' + join(headers, 'ggml/include'),
      join(root, 'test/fixtures/shielded-overlap-ready.cpp'), '-o', bin], {timeout: 120_000, env});
    const out = execFileSync(bin, {encoding: 'utf8', timeout: 60_000, env});
    process.stderr.write(out);
    assert.match(out, /overlap-ready: ok/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
