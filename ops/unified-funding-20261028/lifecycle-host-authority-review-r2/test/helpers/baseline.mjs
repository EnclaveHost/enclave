// Test-only module resolution against the READ-ONLY baseline checkout. Nothing is copied into or written beside it:
//  - the generated host candidate (written to a temp dir) resolves its relative imports against baseline windows/node/,
//    except ../../network/lifecycle-host-dispatch.mjs, which is this task's module;
//  - this task's network modules (dispatch, authority) resolve each other here, every other relative import against
//    baseline network/ (the REAL runner, host-admission-policy.mjs, ../site/js/core/catalog-policy.js), and bare
//    packages (viem) from the baseline's node_modules.
// Import this module FIRST, before anything that imports host.mjs, chain.mjs or the task modules.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

export const BASELINE = process.env.LIFECYCLE_BASELINE || '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle';
export const BASELINE_HOST = `${BASELINE}/windows/node/host.mjs`;
export const BASE_NODE = pathToFileURL(`${BASELINE}/windows/node/`).href;
export const BASE_NETWORK = pathToFileURL(`${BASELINE}/network/`).href;
export const BASE_TEST = pathToFileURL(`${BASELINE}/test/`).href;
const SRC_NETWORK = new URL('../../src/network/', import.meta.url).href;
export const DISPATCH_URL = new URL('lifecycle-host-dispatch.mjs', SRC_NETWORK).href;
export const AUTHORITY_URL = new URL('lifecycle-host-authority.mjs', SRC_NETWORK).href;
export const GENERATOR_URL = new URL('../../src/tools/generate-lifecycle-host-candidate.mjs', import.meta.url).href;
if (!fs.existsSync(BASELINE_HOST)) throw Error(`baseline checkout not found at ${BASELINE} (set LIFECYCLE_BASELINE)`);

const RUNNER_URL = new URL('deployment-lifecycle-runner.mjs', SRC_NETWORK).href;
const OURS = new Set([DISPATCH_URL, AUTHORITY_URL, RUNNER_URL]);
const candidates = new Set();
export const registerCandidate = (url) => { candidates.add(url); };

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL;
    if (parent && OURS.has(parent)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const own = new URL(specifier, parent).href;
        return { url: OURS.has(own) ? own : new URL(specifier, BASE_NETWORK).href, shortCircuit: true };
      }
      return next(specifier, { ...context, parentURL: new URL('deployment-lifecycle-runner.mjs', BASE_NETWORK).href });
    }
    if (parent && candidates.has(parent)) {
      if (specifier === '../../network/lifecycle-host-dispatch.mjs') return { url: DISPATCH_URL, shortCircuit: true };
      if (specifier.startsWith('./') || specifier.startsWith('../')) return { url: new URL(specifier, BASE_NODE).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
