#!/usr/bin/env python3
"""Mutation check of the indexd-fence tests (negative controls). Each mutant is one source edit to a COPY of
indexd-fence (work/storage-real-indexd/mutants/tree); the fence tests must fail on every mutant. Run inside one
bounded scope (run-bounded.sh). Writes mutants/results.txt. Fixture credentials are only read by fence-gotest.sh."""
import os, shutil, subprocess, sys

HERE = "/home/steven/Documents/Codex/2026-10-18/wo/work/storage-real-indexd"
SRC = HERE + "/indexd-fence"
TREE = HERE + "/mutants/tree"

# (name, file, old, new, test package, -run regexp)
MUTANTS = [
    ("M1_token_only_check", "persist/postgres/fence.go",
     "if sf != nil && sf.Fence == cur && subtle.ConstantTimeCompare(sf.Receipt[:], receipt) == 1 {",
     "if sf != nil && sf.Fence == cur {",
     "./persist/postgres/", "TestFence(EqualRaiseClone|MutationChecks)$"),
    ("M2_equal_raise_accepted", "persist/postgres/fence.go",
     "if fence.Compare(cur) <= 0 {", "if fence.Compare(cur) < 0 {",
     "./persist/postgres/", "TestFence(RaiseRules|EqualRaiseClone)$"),
    ("M3_fenced_lock_not_exclusive", "persist/postgres/fence.go",
     "seq_enabled FROM accounts WHERE public_key = $1 FOR UPDATE`\n\t}",
     "seq_enabled FROM accounts WHERE public_key = $1 FOR KEY SHARE`\n\t}",
     "./persist/postgres/", "TestFence(ConcurrentRaiseVsWrites|SeqCommitOrder|EqualRaiseClone)$"),
    ("M13_unfenced_mutations_unlocked", "persist/postgres/fence.go",
     "seq_enabled FROM accounts WHERE public_key = $1 FOR KEY SHARE`",
     "seq_enabled FROM accounts WHERE public_key = $1`",
     "./persist/postgres/", "TestFence(ConcurrentBackfill|RaiseWaitsForInflightUnfenced(Pin|Delete))$"),
    ("M4_prune_batches_unchecked", "persist/postgres/slabs.go",
     "\t\t\tif _, err := lockAccount(ctx, tx, account, sf); err != nil {\n\t\t\t\treturn err\n\t\t\t}\n",
     "",
     "./persist/postgres/", "TestFencePruneBatchesRaise$"),
    ("M5_delete_without_seq", "persist/postgres/objects.go",
     "UPDATE object_events SET was_deleted = TRUE, updated_at = NULL, seq = $3",
     "UPDATE object_events SET was_deleted = TRUE, updated_at = NULL, seq = COALESCE(seq, $3)",
     "./persist/postgres/", "TestFence(PagedSnapshot|ConcurrentRaiseVsWrites)$"),
    ("M6_blocked_metadata_returned", "persist/postgres/fence.go",
     "if !e.Deleted && !e.Blocked {", "if !e.Deleted {",
     "./persist/postgres/", "TestFence(Backfill|BlockedUnblockRepair)$"),
    ("M7_hash_ignores_credential", "api/app/auth.go",
     "\th.E.Write(cred[:])\n", "\t_ = cred\n",
     "./api/app/", "TestFenceAPISignatureTampering$"),
    ("M8_duplicate_sf_accepted", "api/app/auth.go",
     "} else if len(vals) != 1 {", "} else if len(vals) < 1 {",
     "./api/app/", "TestFenceAPIQueryCanonical$"),
    ("M10_hash_body_not_length_bound", "api/app/auth.go",
     "\th.E.WriteBytes(body)\n\treturn h.Sum()", "\th.E.Write(body)\n\treturn h.Sum()",
     "./api/app/", "TestFenceHashVector$"),
    ("M11_hash_raw_v2_form", "api/app/auth.go",
     "\th.E.WriteString(fenceHashDomain)\n\th.E.WriteString(method)\n\th.E.WriteString(hostname)\n\th.E.WriteString(path)\n\th.E.WriteUint64(uint64(validUntil.Unix()))\n\tcred := sf.Bytes()\n\th.E.Write(cred[:])\n\th.E.WriteBytes(body)\n",
     "\th.E.Write([]byte(method))\n\th.E.Write([]byte(hostname))\n\th.E.Write([]byte(path))\n\th.E.WriteUint64(uint64(validUntil.Unix()))\n\th.E.Write(body)\n\th.E.Write([]byte(\"indexd/fence/v2\"))\n\tcred := sf.Bytes()\n\th.E.Write(cred[:])\n",
     "./api/app/", "TestFenceHashV2ReplayAfterFenceLoss$"),
    ("M12_current_listing_hides_blocked", "persist/postgres/current.go",
     "AND ($4 OR NOT EXISTS", "AND ($4 IS NULL OR NOT EXISTS",
     "./persist/postgres/", "TestFenceBlockedUnblockRepair$"),
    ("M9_backfill_skipped", "persist/postgres/fence.go",
     "if !seqEnabled {\n\t\t\t// number every existing event",
     "if false {\n\t\t\t// number every existing event",
     "./persist/postgres/", "TestFence(Backfill|ConcurrentBackfill)$"),
]


def main():
    if os.path.exists(TREE):
        shutil.rmtree(TREE)
    shutil.copytree(SRC, TREE, symlinks=True)
    out = []
    only = set(sys.argv[1:])
    for name, rel, old, new, pkg, run in MUTANTS:
        if only and name not in only:
            continue
        path = os.path.join(TREE, rel)
        orig = open(path).read()
        if orig.count(old) != 1:
            out.append(f"{name}: NOT APPLIED (pattern count {orig.count(old)})")
            continue
        open(path, "w").write(orig.replace(old, new))
        log = f"{HERE}/logs/mut-{name}.log"
        with open(log, "w") as f:
            rc = subprocess.call([HERE + "/logs/fence-gotest.sh", pkg, "-run", run, "-count=1", "-timeout", "300s"],
                                 stdout=f, stderr=subprocess.STDOUT, env=dict(os.environ, FENCE_TREE=TREE))
        open(path, "w").write(orig)
        verdict = "KILLED (tests failed)" if rc != 0 else "SURVIVED (tests passed)"
        out.append(f"{name}: {verdict} rc={rc} [{pkg} -run {run}]")
        print(out[-1], flush=True)
    shutil.rmtree(TREE)
    open(HERE + "/mutants/results" + ("-" + "-".join(sorted(only)) if only else "") + ".txt", "w").write("\n".join(out) + "\n")
    print("\n".join(out))
    sys.exit(0 if all("KILLED" in o for o in out) else 1)


if __name__ == "__main__":
    main()
