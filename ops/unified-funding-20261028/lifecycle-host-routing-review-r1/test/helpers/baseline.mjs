// Test-only module resolution against the READ-ONLY baseline checkout. Nothing is copied into or written beside it:
//  - the generated host candidate (written to a temp dir) resolves its relative imports against baseline windows/node/,
//    except ../../network/lifecycle-host-dispatch.mjs, which is this task's module;
//  - this task's dispatch module resolves ./deployment-lifecycle-runner.mjs to the baseline runner (the real one).
// Import this module FIRST, before anything that imports host.mjs, chain.mjs or the dispatch.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

export const BASELINE = process.env.LIFECYCLE_BASELINE || '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle';
export const BASELINE_HOST = `${BASELINE}/windows/node/host.mjs`;
export const BASE_NODE = pathToFileURL(`${BASELINE}/windows/node/`).href;
export const BASE_NETWORK = pathToFileURL(`${BASELINE}/network/`).href;
export const BASE_TEST = pathToFileURL(`${BASELINE}/test/`).href;
export const DISPATCH_URL = new URL('../../src/network/lifecycle-host-dispatch.mjs', import.meta.url).href;
export const GENERATOR_URL = new URL('../../src/tools/generate-lifecycle-host-candidate.mjs', import.meta.url).href;
if (!fs.existsSync(BASELINE_HOST)) throw Error(`baseline checkout not found at ${BASELINE} (set LIFECYCLE_BASELINE)`);

const candidates = new Set();
export const registerCandidate = (url) => { candidates.add(url); };

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL;
    if (parent === DISPATCH_URL && specifier === './deployment-lifecycle-runner.mjs')
      return { url: new URL('deployment-lifecycle-runner.mjs', BASE_NETWORK).href, shortCircuit: true };
    if (parent && candidates.has(parent)) {
      if (specifier === '../../network/lifecycle-host-dispatch.mjs') return { url: DISPATCH_URL, shortCircuit: true };
      if (specifier.startsWith('./') || specifier.startsWith('../')) return { url: new URL(specifier, BASE_NODE).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
