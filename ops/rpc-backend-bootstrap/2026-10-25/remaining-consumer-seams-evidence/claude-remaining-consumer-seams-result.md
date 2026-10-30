# Remaining consumer seams: public directory + wg-qualify checker (FINAL, 2026-10-25 22:25 UTC)

**Status: source written, syntax-checked; TESTS NOT STARTED.**
- Both foreground queue attempts at 256 MiB were refused with **exit 98** ("small allocation held"):
  `logs/remaining-seams-20261025T222409Z.*` and `…T222415Z.*`. Both logs are preserved.
- **Nothing is tested yet.**
- **Not done:** no commit, deploy, SSH, live or config change, contract change or native build.
- **Worktree:** `relay-consumer-source` (branch `fix/rpc-relay-consumers-20261025`, HEAD `ab371cbc2`). The pre-existing
  untracked `node_modules`/`network/node_modules` symlinks are left alone.

## Findings before editing

**Public directory: the seam already existed.**
- `network/directory-server.mjs` `runDirectory` built `LeaseReader({..., ...chainAuthorityOptions(config)})`.
- In verifier mode, `LeaseReader` builds **no** provider client and has no fallback (`lease-reader.mjs:152-158`), and it
  checks the verifier's chain id (`:378-379`).
- **Gap:** an explicit verifier config that still named `rpc` was silently ignored rather than refused.

**wg-qualify: no seam.**
- Its reads are `addr('registry')`, `registry.get`, `connectivityAddress` and the `qualificationDigest` that its key
  SIGNS.
- Today they go to one plain `--rpc` provider, or to the `--independent` agreed quorum.
- The reviewed `network/chain-authority.mjs` `createChainAuthority(...).client` already provides proof-routed
  `eth_call`: the local verifier only, refusals by name, `local-verifier`/unsafe tier. **No new proof semantics were
  needed, and nothing plain is proxied as verified.**

## Changes (exact)

| File | sha256 | Change |
| --- | --- | --- |
| `network/directory-server.mjs` (M, +11/−1) | `ee7b8d82…` | New exported `directoryReaderOptions(config)`. **Legacy quorum options are byte-identical** (`{rpc, addressBook, authorityPins, includeHostPayout: true}`). `chainAuthority: "verifier"` together with any `rpc` now **throws** at startup. `runDirectory` uses it |
| `network/qualifier-chain.mjs` (new) | `3961b319…` | `qualifierChainAuthority({...})`, described below |
| `scripts/network/wg-qualify.mjs` (M, +8/−1) | `342289b8…` | Calls `qualifierChainAuthority` **before** bootstrap and logs `chain reads: {...}`; `chain = verified ? {readContract} : <exact old expression>`. Usage comment added. No other line changed |
| `test/directory-reader-authority.test.mjs` (new) | `bbf084a6…` | 4 tests |
| `test/qualifier-chain-authority.test.mjs` (new) | `b5ad0944…` | 5 tests |

**`qualifierChainAuthority` behaviour:**
- **No `--chain-authority`, or `quorum`:** returns `null`, so the old paths are untouched. A verifier given without the
  mode is refused.
- **`verifier`:**
  - it requires a loopback `--chain-verifier` (refused otherwise, by the reviewed `verifierEndpoint`);
  - it **refuses `--rpc`** (mixed) and **`--independent`** (its agreed quorum is another authority), and is Base-only;
  - before **every** read it runs `actionGate` (fresh signed head) and an `eth_chainId` check;
  - any failure throws: no provider client exists, so nothing can fall back;
  - `describe()` reports `attested: false`, because the host-local helper is never labelled attested.

**Review patch:** `logs/remaining-seams.patch` (`d4291ef4…`). **Job:** `logs/remaining-seams-job.sh` (`047121c1…`).

## Tests prepared (NOT run)

**`directory-reader-authority`** uses the in-process Helios-like stand-in pattern from
`test/lease-reader-verifier.test.mjs`:
- **Legacy:** the options are identical and give a quorum `LeaseReader` with 2 clients.
- **Refusals:** `rpc` with the verifier (including `rpc: []`), a verifier without the mode, the mode without a URL, and a
  remote verifier are refused. `runDirectory` rejects the mixed config at startup.
- **Positive:** with no provider client, the pinned registry is read and the operator comes from a proof-pinned
  (`blockHash`) `eth_call`; the authority is `local-verifier`/`unsafe`.
- **Failures:** outage, proof failure, wrong chain and a stale head each refuse.

**`qualifier-chain-authority`** uses a real loopback JSON-RPC stand-in through `createChainAuthority`, plus a decoy
"public RPC" server that must see **0** requests:
- **Legacy:** returns `null`.
- **Refusals:** mixed and remote selections, and a chain id other than 8453, are refused before any request.
- **Positive:** the registry operator and `connectivityAddress` are read through the verifier only, with chain and head
  checked.
- **Failures:** down, stale, wrong chain and proof failure each make every read throw, with the decoy at 0.
- **Real script runs:**
  - a legacy run still writes `[]`;
  - a verifier run logs `local-verifier` with `"attested":false`;
  - `--rpc` with the verifier exits non-zero with the refusal, and the decoy stays at 0.

**Regression controls in the same job:** `public-directory`, `lease-reader-verifier` and `chain-authority` (existing,
unchanged).

**Root command, when the small lane is free:**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
T=$(date -u +%Y%m%dT%H%M%SZ); python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log "$PWD/logs/remaining-seams-$T.guard" -- unshare -rn "$PWD/logs/remaining-seams-job.sh" > "logs/remaining-seams-$T.out" 2>&1; echo $? > "logs/remaining-seams-$T.rc"
```

**Pass criteria:** `job rc=0`, every listed file `ok`, 0 skipped.

**First-run risk:** the error-message regexes (for example viem's wording for a proof error, and `LeaseReader`'s
stale-head wording) were written from source and **not executed**. A first run may need a test-only wording adjustment;
no semantics should change.

## Risks and limits

- **Host-services `directory-replica` role** (`network/host-services/roles.mjs:83-101`, not edited). It forwards `rpc`
  alongside `chainAuthority`. A replica config that names both will now **refuse at startup** instead of silently
  ignoring `rpc`. That is intended fail-closed behaviour, but check live or role configs before rollout. The generated
  bundle `network/host-services/packages/directory-replica.mjs` is **not rebuilt** and keeps the old behaviour until it
  is.
- **The live directory** (`runtime-37366ab`) and **the live checker** (`nan-retirement-2d848c8`) run older code. These
  seams need a new release. Then the configs change:
  - directory: remove `rpc`, add `chainAuthority: "verifier"` and `chainVerifier: http://127.0.0.1:<port>/`;
  - checker: replace `--rpc …` with `--chain-authority verifier --chain-verifier http://127.0.0.1:<port>/`.

  Each host needs its own host-local verifier with the own node as its proof source; none exists on the regional hosts
  today. That is the placement blocker from the cutover plan.
- **`--independent` together with the verifier is refused, not supported.** Supporting it would need
  `resolveCheckerBootstrap` changes; that is out of scope, and the live checker does not use `--independent`.
- **Trust tier.** The local verifier is the sequencer-signed **unsafe** tier with no L1 finality. A qualification digest
  signed through it has that trust, not an attested one.
