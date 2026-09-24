# Cross-branch acceptance: the pinned owner module

The pVM evidence verifier belongs to the pVM owner and lives on `pvm-cpu/portable-runtime`. This branch never
copies it. The acceptance suites judge REAL device evidence through that module, so they need it present and
they need to know exactly which revision they ran against.

- `pins.json` names the branch, the FULL commit and the sha256 of every file the module needs. Bump the pin
  when the owner announces a revision; a bump is a reviewed change on this branch.
- `resolve.mjs` reads those files from that commit's tree with `git cat-file` (fetching the branch if the commit
  is absent), checks every hash, checks that files the adapter also uses from this worktree
  (`relay/avf-verify.mjs`) are identical, and writes them under `.verifier-integration/<pin>-<commit12>/`
  (gitignored) with a `MANIFEST.json`. Materialisation is transactional: everything is validated in memory first,
  written to a staging directory with the manifest last, then renamed into place. Any mismatch exits 2 and leaves
  nothing: no partial entry, no manifest, and no stale prior materialisation of that pin. `run.mjs` re-hashes what
  is on disk against the manifest and the pin before running anything.
- Each pin names the environment variable its entry is exported as (`env`): `pvm-app-attest` -> `ENCLAVE_PVM_MODULE`
  (the evidence verifier), `pvm-sealed` -> `ENCLAVE_PVM_SEALED_MODULE` (the reference stream reader, run as a
  differential beside `verifier/sealed-stream.mjs`).
- `run.mjs` resolves EVERY pin, then runs the acceptance suites with those variables set and
  `ENCLAVE_STRICT_INTEGRATION=1`. Under strict mode an acceptance case that would skip for a missing module
  FAILS, and a skipped count is a failure. `npm run test:integration` is this command.

Without the variables (plain `npm test`), the acceptance cases skip with a stated reason and every other suite
runs; that is the clean-checkout default on this branch until the owner's module lands on main. Nothing here
overwrites a tracked file: the module is only ever materialised under `.verifier-integration/`.

## Build artifacts

`artifacts.json` pins a build artifact by branch, full commit, the build tool's exact version, every output's sha256
and size, and the allowlist of dynamic imports the bundle may contain. `reproduce.mjs` adds a detached temporary
worktree of that commit, runs the recipe's own `--check` with the tool from this worktree's `node_modules` (refusing
any other version), re-hashes every input and output, greps the bundle for code-loading constructs, and removes the
worktree; any difference exits 2. `run.mjs` runs it before the acceptance suites. Reproducing the owner's artifact
from the same commit is the lab stand-in for a transparency log (`docs/security/pvm-client-bootstrap-review.md`).
