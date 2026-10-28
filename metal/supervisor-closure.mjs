// The supervisor's runtime closure for a metal image overlay (work/linux-lease-activation). A pinned supervisor image is
// overlaid with supervisor.js from a commit; that file is only correct with EVERY local module it loads at that commit
// (a fixed list once omitted the app-funded lease-gas runtime and its imports, so a newer supervisor.js would not start),
// and with every npm package those modules name present in the image. metal/build-image.mjs uses this; the Python
// overlay builder (metal/overlay-control-image.py supervisor_closure) applies the same rules, and
// test/metal-lease-gas-conduit.test.mjs checks the two agree on this repository.
//
// The rules (statements, not a parser; generated *.bundle.mjs files are self-contained leaves):
//   - a line that starts a comment (//, /*, *) is skipped;
//   - at the start of a line: import … from 'x', export … from 'x', import 'x', and a multi-line import's closing } … from 'x';
//   - anywhere in a line (not in a bundle): import('x'), import(new URL('x', import.meta.url)) and new URL('./x', import.meta.url);
//   - './' and '../' are files of the closure (each one must exist, and is scanned in turn); 'node:*' and Node's
//     builtin names are the runtime's; anything else is an npm package the image must carry.
import fs from 'node:fs';
import path from 'node:path';

export const NODE_BUILTINS = Object.freeze(['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events',
  'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'stream', 'stream/promises', 'string_decoder', 'timers', 'timers/promises', 'tls', 'tty', 'url', 'util',
  'v8', 'vm', 'worker_threads', 'zlib']);
export const SUPERVISOR_ROOTS = Object.freeze(['supervisor.js', 'addressbook.js']);

const Q = `(['"])([^'"\\n]+)\\1`;
const LINE_START = [new RegExp(`^(?:import|export)\\b.*?\\bfrom\\s*${Q}`), new RegExp(`^\\}.*?\\bfrom\\s*${Q}`), new RegExp(`^import\\s*${Q}`)];
const ANYWHERE = [new RegExp(`\\bimport\\s*\\(\\s*${Q}`, 'g'), new RegExp(`\\bimport\\s*\\(\\s*new URL\\(\\s*${Q}`, 'g'),
  new RegExp(`\\bnew URL\\(\\s*(['"])(\\.\\.?/[^'"\\n]+)\\1\\s*,\\s*import\\.meta\\.url`, 'g')];

/** The module specifiers one file's text names, by the rules above. */
export function specifiersOf(text, { bundle = false } = {}) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trimStart();
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    for (const re of LINE_START) { const m = re.exec(line); if (m) out.push(m[2]); }
    if (bundle) continue;
    for (const re of ANYWHERE) for (const m of line.matchAll(re)) out.push(m[2]);
  }
  return [...new Set(out)];
}
/** 'viem/accounts' -> { name: 'viem', subpath: './accounts' }; '@a/b/c' -> { name: '@a/b', subpath: './c' }. */
export function packageOf(spec) {
  const parts = spec.split('/'), n = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, n).join('/'), rest = parts.slice(n).join('/');
  return { name, subpath: rest ? './' + rest : '.' };
}

/**
 * read(rel) -> text | null (null = absent). -> { files: sorted relative paths, packages: { name: [subpaths] } }.
 * Throws when a local module named by the closure is absent.
 */
export function closureOf(read, roots = SUPERVISOR_ROOTS) {
  const seen = new Set(), packages = {}, queue = [...roots];
  while (queue.length) {
    const rel = path.posix.normalize(queue.shift());
    if (seen.has(rel)) continue;
    const text = read(rel);
    if (text === null || text === undefined) throw new Error(`the supervisor closure names ${rel}, which is not in the source`);
    seen.add(rel);
    if (!/\.(m?js|cjs)$/.test(rel)) continue;                          // data loaded by URL: part of the closure, not scanned
    for (const spec of specifiersOf(text, { bundle: /\.bundle\.mjs$/.test(rel) })) {
      if (spec.startsWith('./') || spec.startsWith('../')) queue.push(path.posix.join(path.posix.dirname(rel), spec));
      else if (spec.startsWith('node:') || NODE_BUILTINS.includes(spec)) continue;
      else { const p = packageOf(spec); (packages[p.name] ||= new Set()).add(p.subpath); }
    }
  }
  return { files: [...seen].sort(), packages: Object.fromEntries(Object.keys(packages).sort().map((k) => [k, [...packages[k]].sort()])) };
}

/** The closure of a source checkout's working files. */
export const supervisorClosure = (root, roots = SUPERVISOR_ROOTS) =>
  closureOf((rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } }, roots);

// an exports map entry for subpath: exact, or a "./prefix*" pattern
const exported = (exportsMap, sp) => sp in exportsMap || Object.keys(exportsMap).some((k) => k.endsWith('*') && sp.startsWith(k.slice(0, -1)));
/**
 * Every package the closure names must be in the image, with every subpath it uses exported. readPackageJson(name) -> the
 * package.json text in the image, or null. -> [{ name, version }] (throws, naming what is missing).
 */
export function checkPackages(packages, readPackageJson) {
  const out = [];
  for (const [name, subpaths] of Object.entries(packages)) {
    const text = readPackageJson(name);
    if (!text) throw new Error(`the supervisor image has no ${name} package, which the overlaid supervisor needs`);
    let pkg; try { pkg = JSON.parse(text); } catch { throw new Error(`the supervisor image's ${name}/package.json is not JSON`); }
    if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports) && Object.keys(pkg.exports).some((k) => k.startsWith('.')))
      for (const sp of subpaths) if (!exported(pkg.exports, sp)) throw new Error(`the supervisor image's ${name}@${pkg.version} exports no ${sp}, which the overlaid supervisor imports`);
    out.push({ name, version: String(pkg.version || '') });
  }
  return out;
}
