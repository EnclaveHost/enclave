# Root recipe r3 (ROOT ONLY; nothing here was run on the VM by its author)

r3 contains:
- root's reviewed `${POSTGRES_USER:-postgres}` correction, integrated in the preflight, the digest opt-in and the controller copy
  (psql, pg_dump, pg_restore);
- the production `indexd.yml` access model (0640 root:enclave-indexd) as one explicit, verified exception.

Preserved unchanged: r1 (`storage-migration/`), r2 (`storage-migration-r2/`, PINS ok), the controller ce63951e and root's live
captures. No secret check is relaxed globally: without the profile entry, the controller behaves exactly as ce63951e.

## 0. Pins

    cd storage-migration-r3 && sha256sum -c PINS.sha256

## 1. B1 again, read-only (root's routine authority; no user approval, wallet, spend or hardware)

    # on the VM, as root, same transport as root's runs 20261022:
    timeout -k 10 330 bash -s < preflight/vm-preflight.sh > pf.out
    # locally:
    python3 preflight/evaluate-preflight.py pf.out; echo "exit=$?"

r3 reads the same facts as root's corrected run, plus 9 metadata-only facts of at most 10 s each (the 300 s budget is unchanged):
- `stat` of indexd.yml: `%u:%g`, `%F`, `%h`;
- `stat` of /etc/enclave-indexd: `%a %u`;
- `systemctl show enclave-indexd -p User|Group|SupplementaryGroups`;
- `getent group enclave-indexd`, printed as `gid=N members=...` only;
- the usernames whose primary gid is that group (`getent passwd`, field 1 only).

No file content, password field or config value is read.

READY additionally requires the production model, exactly:
- indexd.yml is a regular file with 1 link, mode 640, uid 0, and gid = the enclave-indexd gid (not 0);
- the group has no supplementary members, and only the user enclave-indexd has it as primary group;
- the unit runs User=/Group=enclave-indexd with no SupplementaryGroups;
- /etc/enclave-indexd is uid 0 and not group/other writable.

Already known without new reads:
- The live fragment sha cb96c3be (root's capture) equals `work/storage-vm/enclave-indexd.service`, and the live drop-in
  directory is absent. So the unit side of the model holds; r3 confirms it directly.

## 2. If the access model BLOCKS

Do not "fix" either of these by chmod or chown:
- `chmod 0600 root` stops the unprivileged unit reading its config;
- `chown enclave-indexd` lets the service write its own config.

Each blocker names the one fact that differs, for example a supplementary member of enclave-indexd or another user with that
primary group. Changing groups, users or file modes is a production permission change. It is NOT authorized in this task, and
it needs root's own decision.

## 3. Controller (Phase C step 2, when the live upgrade is scheduled; NOT authorized now)

- Use `controller/replicactl.py` (r3) and `controller/live-primary.profile.json` (r3). The profile adds:

      "config_file_access": {"mode": "0640", "owner": "root", "group": "enclave-indexd", "group_members": [], "group_primary_users": ["enclave-indexd"]}

  `replicactl preflight` then accepts indexd.yml only under that exact model. It re-reads lstat and the group/passwd
  databases at run time.
- `admin_password_file` stays strict (no group/other bits).
- The two ROOT_DECIDES values (admin_password_file, backup_dir) are unchanged and still root's.
- If the B1 r3 read shows different group facts, root edits the declared lists only after deciding the access model is
  intended. The controller refuses any difference.

## 4. Unchanged

B2 and Phase C are on the user's hold. Phase A (enclave builds) is still pending. The digest opt-in is not part of B1.
