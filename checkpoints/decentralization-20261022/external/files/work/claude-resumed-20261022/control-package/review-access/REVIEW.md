# review-access: r3 config-access exception + root's access-metadata capture

Nothing was executed remotely. No production, r3 or original file was changed: the proposals live in `proposed/` and as patch text.

## A. Cross-capture assessment (NOT a consolidated READY)

Details: `CROSS-CAPTURE-ASSESSMENT.json`.

- **Captures:** root's run2 preflight `6267198b` (04:27Z) and root's `metadata.json` `caecc921` (04:33Z, metadata.sh `f3ee8e5c`).
- **8 of the 9 r3 access facts are closed exactly:**
  - config.ids 0:986
  - config.type regular file
  - config.nlink 1
  - unit.user, unit.group enclave-indexd; unit.supplementary_groups empty
  - group.service gid=986 with no members
  - group.primary_users enclave-indexd
- **config.dir_stat (755 0) is closed in value only.** metadata.sh used `os.stat`, which follows symlinks, while r3 reads the directory itself (no `-L`). Neither capture proves `/etc/enclave-indexd` is not a symlink.
- **Rules applied by hand:** the r3 evaluator rules block none of these values, and the r3 profile's declared lists equal them.
- **Correction:** my r3 RESULT (04:39Z) said the group facts were unread. That was stale; root had read them at 04:33Z.

**Still missing (metadata-only):** these fall outside the 9 facts. One bounded read, `metadata-recipe.sh` (not executed), covers all three.
1. The lstat type of /etc/enclave-indexd.
2. Whether indexd.yml has a POSIX access ACL.
3. The type, owner and mode of /etc and /.

## B. Exception review (`storage-migration-r3/controller/replicactl.py` 90a325b0)

| # | Severity | Finding | Exact lines | Status |
|---|---|---|---|---|
| G1 | medium | A read ACL for another user leaves the mode at 0640, so "nobody else can read it" is unenforced. `setfacl -m u:nobody:r` → mode 640 and the exception is accepted. | replicactl.py 214-220 (lstat/mode only); evaluate-preflight.py 107-132; vm-preflight.sh 143-146 | demonstrated (gaps-1) |
| G2 | medium | A symlinked config directory is followed: `os.stat(os.path.dirname(...))` stats the target, and `os.lstat(path)` only refuses a symlinked last component. | replicactl.py 230 | demonstrated. The r3 preflight is fail-closed here, because `stat` of the directory without `-L` shows 777 and the 0o022 check blocks it. |
| G3 | low-medium | Only the immediate parent is checked. A group/other-writable ancestor would let someone rename the root-owned directory away and substitute one. | replicactl.py 229-234; vm-preflight.sh 146 | demonstrated |
| G4 | info, pre-existing | The checks run only in `replicactl preflight`; upgrade, rollback and backup do not re-run `check_secret_modes`, so this is time-of-check only. | replicactl.py `cmd_preflight` only | not changed (unchanged since ce63951e) |
| G5 | low, pre-existing, outside the exception | The strict path uses `Path.stat()`, which follows symlinks, so a symlinked admin_password_file pointing at a 0600 file passes. | replicactl.py 245 | not changed (unchanged since ce63951e) |

Owner-permission checks hold:
- mode must be exactly 0640, with setgid and sticky bits refused (220);
- the owner may not be in the reader group (211-212), so the service cannot gain write access;
- nlink must be 1 (219);
- gid 0 is refused;
- admin_password_file stays strict.

Exposure is clean. vm-preflight.sh `r_group` (111) prints only `$3` and `$4`, and `r_group_primary` (114) prints only `$1`. metadata.json holds only names, uids, gids, modes and unit properties. No credential field is printed anywhere.

## C. Minimal fixes

- **`controller-review-access.patch`:** applies to r3 90a325b0 and produces `proposed/replicactl.py`.
  - Refuses a `system.posix_acl_access` xattr on the config file. ENOTSUP is treated as having no ACL.
  - Walks every path component with lstat:
    - a symlinked component is refused;
    - the immediate parent keeps the r3 rule;
    - ancestors must be owned by root or the owner and not group/other writable, with root-owned sticky directories allowed.
  - Production `/ /etc /etc/enclave-indexd`, all root 0755, passes.
- **`test-access-review.patch`:** one assertion in r3's test_access.py. Inside the test's user namespace the real-root `/` and `/tmp` appear as uid 65534, so the proposed check refuses exactly those there. As real root they are uid 0.
- **`preflight-evaluator-review-access.patch.txt`:** UNTESTED text adding the facts config.acl and config.ancestors. Adopting it would make an r4 that needs its own stub test.

## D. Tests (queue, 256 MiB, all finished)

| Log | Result |
|---|---|
| `gaps-1.out` | 5/5, exit 0. G1–G3 are accepted by r3 and refused by the proposed copy; the clean layout is accepted by both; existing refusals unchanged. |
| `access-regress-1.out` | 9/10, exit 1. r3's test_access.py run verbatim against the proposed copy; the failure is the uid-65534 namespace artifact. Kept as evidence. |
| `access-regress-2.out` | 10/10, exit 0, with the one-assertion test patch. |

## E. Concrete next steps (root)

1. Decide whether to adopt `controller-review-access.patch` (and the test patch) before Phase C step 2.
2. Run `metadata-recipe.sh` with the same bounded transport as metadata.sh. Expected:
   - `configAcl` absent or unsupported;
   - every component a root-owned directory, not group/other writable.
3. Run the fresh r3 preflight as planned and evaluate it. A READY there plus a clean step 2 covers the model. The r3 evaluator alone does not check ACLs or ancestors.
4. If the preflight/evaluator text patch is adopted, it becomes r4 and needs a stub test before use.
