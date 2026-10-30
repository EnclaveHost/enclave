// Test-only module resolution for r3 against the READ-ONLY baseline checkout and the READ-ONLY review-r2 stage. Nothing
// is copied into or written beside either. Load with `node --test --import ./test/helpers/baseline.mjs` so the same
// hooks also serve the unmodified review-r2 / root tests run IN PLACE:
//  - this task's network modules (dispatch, authority, admission) resolve each other here; './deployment-lifecycle-runner.mjs'
//    is the ROOT-FIXED staged runner in review-r2 (sha256 pinned below: hostAdmitted && snapshot.admitted !== false);
//    every other relative import resolves against baseline network/, bare packages from the baseline node_modules;
//  - review-r2 test helpers baseline.mjs and lifecycle-fixture.mjs are redirected to these r3 helpers, so r2/root tests
//    exercise the r3 sources and never load the r2 dispatch/authority. review-r2 helpers/candidate-host.mjs is used in
//    place (its imports are redirected): it generates the host candidate with THIS task's generator;
//  - a test file importing baseline network/deployment-lifecycle-journal.mjs gets the GENERATED owned journal candidate
//    (written to a temp dir here from the pinned baseline by tools/generate-lifecycle-journal-candidate.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { generateJournalCandidate } from '../../src/tools/generate-lifecycle-journal-candidate.mjs';

export const BASELINE = process.env.LIFECYCLE_BASELINE || '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle';
export const REVIEW_R2 = process.env.LIFECYCLE_REVIEW_R2 || fileURLToPath(new URL('../../../lifecycle-host-authority-review-r2/', import.meta.url));
export const BASELINE_HOST = `${BASELINE}/windows/node/host.mjs`;
export const BASELINE_JOURNAL = `${BASELINE}/network/deployment-lifecycle-journal.mjs`;
export const BASE_NODE = pathToFileURL(`${BASELINE}/windows/node/`).href;
export const BASE_NETWORK = pathToFileURL(`${BASELINE}/network/`).href;
export const BASE_TEST = pathToFileURL(`${BASELINE}/test/`).href;
const SRC_NETWORK = new URL('../../src/network/', import.meta.url).href;
export const DISPATCH_URL = new URL('lifecycle-host-dispatch.mjs', SRC_NETWORK).href;
export const AUTHORITY_URL = new URL('lifecycle-host-authority.mjs', SRC_NETWORK).href;
export const ADMISSION_URL = new URL('lifecycle-independent-admission.mjs', SRC_NETWORK).href;
export const GENERATOR_URL = new URL('../../src/tools/generate-lifecycle-host-candidate.mjs', import.meta.url).href;
export const JOURNAL_GENERATOR_URL = new URL('../../src/tools/generate-lifecycle-journal-candidate.mjs', import.meta.url).href;
export const ADAPTER_GENERATOR_URL = new URL('../../src/tools/generate-lifecycle-adapter-candidate.mjs', import.meta.url).href;
export const RUNNER_FILE = path.join(REVIEW_R2, 'src/network/deployment-lifecycle-runner.mjs');
export const RUNNER_SHA256 = '75590c8e4be2095b9011ea3b482ceef90a1d21f92ad676dba41578093e7db668';   // review-r2 review-pins.json
const R2_TEST = pathToFileURL(path.join(REVIEW_R2, 'test/')).href, R3_TEST = new URL('../', import.meta.url).href;
export const CANDIDATE_HOST_URL = new URL('helpers/candidate-host.mjs', R2_TEST).href;   // review-r2, used in place
if (!fs.existsSync(BASELINE_HOST)) throw Error(`baseline checkout not found at ${BASELINE} (set LIFECYCLE_BASELINE)`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
if (sha(fs.readFileSync(RUNNER_FILE)) !== RUNNER_SHA256) throw Error(`review-r2 staged runner is not the root-fixed ${RUNNER_SHA256}`);
const RUNNER_URL = pathToFileURL(RUNNER_FILE).href;

// the generated owned journal, from the pinned baseline (the generator refuses any other input)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-r3-journal-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
const journalFile = path.join(tmp, 'deployment-lifecycle-journal.mjs');
fs.writeFileSync(journalFile, generateJournalCandidate(fs.readFileSync(BASELINE_JOURNAL, 'utf8')).source, { flag: 'wx' });
export const JOURNAL_CANDIDATE_URL = pathToFileURL(journalFile).href;

const OURS = new Set([DISPATCH_URL, AUTHORITY_URL, ADMISSION_URL, new URL('lifecycle-host-profile.mjs', SRC_NETWORK).href]);
const RESOLVE_IN_BASE = new Set([RUNNER_URL, JOURNAL_CANDIDATE_URL]);
const HELPERS = new Map(['baseline.mjs', 'lifecycle-fixture.mjs'].map(n => [new URL(`helpers/${n}`, R2_TEST).href, new URL(n, import.meta.url).href]));
const BASE_JOURNAL_URL = new URL('deployment-lifecycle-journal.mjs', BASE_NETWORK).href;
const candidates = new Set();
export const registerCandidate = (url) => { candidates.add(url); };
const bare = (specifier, context, next) => next(specifier, { ...context, parentURL: new URL('deployment-lifecycle-runner.mjs', BASE_NETWORK).href });

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL;
    const rel = specifier.startsWith('./') || specifier.startsWith('../');
    if (parent && OURS.has(parent)) {
      if (!rel) return bare(specifier, context, next);
      const own = new URL(specifier, parent).href;
      if (OURS.has(own)) return { url: own, shortCircuit: true };
      if (specifier === './deployment-lifecycle-runner.mjs') return { url: RUNNER_URL, shortCircuit: true };
      return { url: new URL(specifier, BASE_NETWORK).href, shortCircuit: true };
    }
    if (parent && RESOLVE_IN_BASE.has(parent)) return rel ? { url: new URL(specifier, BASE_NETWORK).href, shortCircuit: true } : bare(specifier, context, next);
    if (parent && candidates.has(parent)) {
      if (specifier === '../../network/lifecycle-host-dispatch.mjs') return { url: DISPATCH_URL, shortCircuit: true };
      if (rel) return { url: new URL(specifier, BASE_NODE).href, shortCircuit: true };
    }
    if (parent && (parent.startsWith(R2_TEST) || parent.startsWith(R3_TEST))) {
      const target = rel ? new URL(specifier, parent).href : specifier;
      if (HELPERS.has(target)) return { url: HELPERS.get(target), shortCircuit: true };
      if (target === BASE_JOURNAL_URL) return { url: JOURNAL_CANDIDATE_URL, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
