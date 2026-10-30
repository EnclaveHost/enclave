// Checks every emitted JS bundle must pass (network/build.mjs, scripts/network/build-consumers.mjs): it parses (a duplicate
// top-level declaration is a SyntaxError only node reports), and it carries at most ONE "am I the main script?" check - its
// program's own. Inside one bundle every module's import.meta.url is the bundle's, so a second check (a bundled library's
// command line) runs inside the program when the bundle runs. A bundle built behind network/main-guard.mjs or
// network/host-services/argv-guard.mjs (guarded) may carry more: the guard makes every such check false.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const MAIN_CHECK = /process\.argv\[1\][\s\S]{0,200}?import\.meta\.url/g;
const GUARDS = ['(enclave bundle entry)', '(enclave host role)'];
export function checkBundle(file, { guarded = false } = {}) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { throw new Error(`${file}: the bundle does not parse: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 6).join(' | ')}`); }
  const text = fs.readFileSync(file, 'utf8'), checks = (text.match(MAIN_CHECK) || []).length;
  if (guarded && !GUARDS.some((g) => text.includes(g))) throw new Error(`${file}: built as guarded, but the main guard is not in the bundle`);
  if (!guarded && checks > 1) throw new Error(`${file}: ${checks} bundled "main module" checks; a bundled library's command line would run inside the program (bundle it behind network/main-guard.mjs)`);
  return { mainChecks: checks, guarded };
}
