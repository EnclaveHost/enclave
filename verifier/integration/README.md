# Cross-branch acceptance: the pinned owner module

The pVM evidence verifier belongs to the pVM owner and lives on `pvm-cpu/portable-runtime`. This branch never
copies it. The acceptance suites judge REAL device evidence through that module, so they need it present and
they need to know exactly which revision they ran against.

- `pins.json` names the branch, the FULL commit and the sha256 of every file the module needs. Bump the pin
  when the owner announces a revision; a bump is a reviewed change on this branch.
- `resolve.mjs` reads those files from that commit's tree with `git cat-file` (fetching the branch if the commit
  is absent), checks every hash, checks that files the adapter also uses from this worktree
  (`relay/avf-verify.mjs`) are identical, and writes them under `.verifier-integration/<pin>-<commit12>/`
  (gitignored) with a `MANIFEST.json`. Any mismatch exits 2 and writes nothing usable.
- `run.mjs` resolves, then runs the acceptance suites with `ENCLAVE_PVM_MODULE=<resolved entry>` and
  `ENCLAVE_STRICT_INTEGRATION=1`. Under strict mode an acceptance case that would skip for a missing module
  FAILS, and a skipped count is a failure. `npm run test:integration` is this command.

Without the variables (plain `npm test`), the acceptance cases skip with a stated reason and every other suite
runs; that is the clean-checkout default on this branch until the owner's module lands on main. Nothing here
overwrites a tracked file: the module is only ever materialised under `.verifier-integration/`.
