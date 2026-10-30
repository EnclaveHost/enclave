# Concrete first memory repair: omit unused base-test bytecode

First real integration job failed only in Solc compilation at inner650 MiB
(actual654); no EVM tests began. Outer717 stayed below768. The exact sources,
logs and stop record are preserved. No production source/assertion failure is
claimed and no resource cap is raised.

Four concrete test contracts were being compiled, even though --match-contract
selects only the two derived fixtures. Both intermediate contracts contain many
`new` expressions embedding the actual ledger/controller/registry/session-vault
creation code. Marking the two base fixtures abstract omits their otherwise
unused bytecode generation. Every test/helper/state declaration is unchanged and
inherited by the same selected derived fixtures. This is a meaningful reduction
in compiler work, not simply another unchanged retry. Expected63 executions /
47 unique scenarios remains identical, with no skips or negative-only filtering.

Exact two-line source delta: abstract-fixtures.diff. No artifact loading,
vm.etch, compiler/optimizer/metadata switch, dummy ledger or prelinked shortcut.
All actual deployments remain the existing normal Solidity CREATE paths. If
this proves insufficient, review artifact-backed normal CREATE separately;
do not automatically retry or enlarge memory.

Runner now writes exclusive actual-abstract-tests. Its original size/source
check remains strict, with only the two exact reviewed `abstract` substitutions
allowed against first fixture bytes whose hashes must match the size result.
Any other source drift aborts. Source hash capture and fresh artifacts/cache
remain. Proposed one attempt at unchanged main768/inner650/floor27648/CPU1/
noSwap/whole600s, only after root main lane is released and review authorizes it.
