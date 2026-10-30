#!/usr/bin/env node
// Bundle the reviewed host verifier without starting it, reading keys, or contacting a chain.
// node build.mjs CLEAN_SOURCE NEW_OUTPUT_DIR
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const [sourceArg, outArg, ...extra] = process.argv.slice(2);
if (!sourceArg || !outArg || extra.length) throw new Error('usage: build.mjs CLEAN_SOURCE NEW_OUTPUT_DIR');
const source = path.resolve(sourceArg), out = path.resolve(outArg);
if (fs.existsSync(out)) throw new Error('output already exists; use a new directory');
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('tracked source changes must be reviewed and committed before packaging');
const require = createRequire(path.join(source, 'package.json'));
const { build, stop, version } = require('esbuild');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const result = await build({ absWorkingDir: source, entryPoints: ['network/rpc-runtime-main.mjs'], platform: 'node', format: 'esm',
    target: 'node20', bundle: true, minify: true, write: false, metafile: true, preserveSymlinks: true,
    banner: { js: 'import { createRequire as __runtimeCreateRequire } from "node:module"; const require = __runtimeCreateRequire(import.meta.url);' } });
  const bytes = Buffer.from(result.outputFiles[0].contents);
  const inputs = Object.fromEntries(Object.keys(result.metafile.inputs).sort().map(rel => {
    if (path.isAbsolute(rel) || rel.startsWith('../')) throw new Error(`input outside source: ${rel}`);
    return [rel, sha(fs.readFileSync(path.join(source, rel)))];
  }));
  // A bundle must have no unresolved package import or relative runtime-file dependency.
  for (const item of Object.values(result.metafile.outputs)) for (const imp of item.imports) {
    if (!imp.external || !imp.path.startsWith('node:')) throw new Error(`unresolved runtime import: ${imp.path}`);
  }
  const manifest = { format: 'enclave-host-verifier-bundle/v1', sourceCommit: git('rev-parse', 'HEAD'),
    sourceTree: git('rev-parse', 'HEAD^{tree}'), esbuildVersion: version, target: 'node20',
    artifact: { file: 'rpc-runtime.mjs', sha256: sha(bytes), bytes: bytes.length },
    binaryPins: JSON.parse(fs.readFileSync(path.join(source, 'metal/chain-verifier-image.json'))).binaries,
    inputs, limitations: ['unsafe sequencer-signed head authority; no L1 finality derived here', 'packaging is not production readiness'] };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'rpc-runtime.mjs'), bytes, { mode: 0o444 });
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o444 });
  console.log(JSON.stringify({ sourceCommit: manifest.sourceCommit, artifact: manifest.artifact, inputs: Object.keys(inputs).length }));
} finally { stop(); }
