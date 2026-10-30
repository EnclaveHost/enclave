// Every npm package a generated artifact is built from must be EXACTLY what the committed lockfile governing it pins: a
// release artifact (scripts/build-host-service-packages.mjs) is reproducible only from a node_modules installed with
// `npm ci` from those lockfiles, never from whatever node_modules a builder happens to have. esbuild metafile inputs are
// paths relative to the builder's root: <prefix>node_modules/<pkg>[/node_modules/<pkg>]/<file>, governed by
// <prefix>package-lock.json (lockfile v2/v3 "packages" keys). -> { lockfiles: { <lockfile>: sha256 }, packages: { <prefix><key>: version } }
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function lockedInputs(root, inputs) {
  const locks = new Map(), packages = {}, lockfiles = {};
  const lockOf = (prefix) => {
    if (!locks.has(prefix)) {
      const file = path.join(root, prefix, 'package-lock.json');
      let bytes; try { bytes = fs.readFileSync(file); } catch { throw new Error(`no lockfile governs ${prefix || './'}node_modules (${path.join(prefix, 'package-lock.json')})`); }
      const lock = JSON.parse(bytes.toString('utf8'));
      if (!lock.packages || typeof lock.packages !== 'object') throw new Error(`${path.join(prefix, 'package-lock.json')}: lockfile v2 or v3 required`);
      locks.set(prefix, lock); lockfiles[path.join(prefix, 'package-lock.json')] = createHash('sha256').update(bytes).digest('hex');
    }
    return locks.get(prefix);
  };
  for (const rel of inputs) {
    const p = rel.split(path.sep).join('/');
    if (p.startsWith('../') || path.isAbsolute(p)) throw new Error(`bundle input outside the tree: ${rel}`);
    const first = p.indexOf('node_modules/');
    if (first < 0) continue;
    const prefix = p.slice(0, first), rest = p.slice(first).split('/');
    // the package directory: through the LAST node_modules/<name> (or <@scope>/<name>) segment
    let end = 0;
    for (let i = 0; i < rest.length - 1; i++) if (rest[i] === 'node_modules') end = i + (rest[i + 1].startsWith('@') ? 3 : 2);
    const key = rest.slice(0, end).join('/');
    if (packages[prefix + key] !== undefined) continue;
    const entry = lockOf(prefix).packages[key];
    if (!entry || typeof entry.version !== 'string') throw new Error(`${prefix}${key} is not in ${prefix}package-lock.json (an extraneous package)`);
    let installed;
    try { installed = JSON.parse(fs.readFileSync(path.join(root, prefix, key, 'package.json'), 'utf8')); } catch (e) { throw new Error(`${prefix}${key}: no package.json (${e.message})`); }
    const name = entry.name || key.split('node_modules/').pop();
    if (installed.version !== entry.version || installed.name !== name)
      throw new Error(`${prefix}${key} is ${installed.name}@${installed.version}, but ${prefix}package-lock.json pins ${name}@${entry.version}: install with npm ci`);
    packages[prefix + key] = entry.version;
  }
  return { lockfiles, packages: Object.fromEntries(Object.entries(packages).sort()) };
}
