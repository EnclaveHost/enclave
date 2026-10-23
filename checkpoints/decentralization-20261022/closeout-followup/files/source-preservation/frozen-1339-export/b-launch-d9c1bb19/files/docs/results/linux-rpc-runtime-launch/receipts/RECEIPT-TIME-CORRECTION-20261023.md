# Receipt: time correction for rpc-runtime-final-integration RESULT.md

Written 2026-10-23T10:14Z (`date -u`) from the linux-rpc-runtime-launch session. This is a new file:
`RESULT.md` and `INVENTORY.json` are left byte-identical, and no commit or ref was rewritten.

| file | sha256 (unchanged) | mtime |
|---|---|---|
| RESULT.md | `fbbb3153326034589fad14432cf41b077d62462160c13aa0073ed633d74e1687` | 2026-10-23T02:33:51.196-07:00 = **09:33:51Z** |
| INVENTORY.json | `130c3e80d7ccfb61a66411b2f8c73f62e68b24ec43f221333edb0c020bce9d7c` | 2026-10-23T02:33:51.316-07:00 = 09:33:51Z |

**Correction.** RESULT.md's header line `(2026-10-23, 09:40Z; times come from job logs and date -u.)` is wrong.
- The 09:40Z was an estimate written before the file was finished. It was not measured.
- It lies after the file's own write time (09:33:51Z) and after root's reading at 09:35:45Z.
- The measured time of that result is **2026-10-23T09:33:51Z**: the mtime of RESULT.md. The host clock is UTC-07:00.

Measured times backing the result (Git committer dates and job-file mtimes; local -07:00 → Z):

| item | local | UTC |
|---|---|---|
| commit 69b966f7f (kernel lock + helper + archive) | 02:08:38-07:00 | 09:08:38Z |
| commit c31e975a4 (final source pin) | 02:08:38-07:00 | 09:08:38Z |
| jobs/a-e2e.rc | 02:19:48-07:00 | 09:19:48Z |
| jobs/scan.rc | 02:20:06-07:00 | 09:20:06Z |
| jobs/e2e-release.rc (guard stop, 99) | 02:21:37-07:00 | 09:21:37Z |
| jobs/e2e-release2.rc (release E2E 15/15, rc 0) | 02:29:49-07:00 | 09:29:49Z |
| jobs/pe-e2e.rc (last job) | 02:33:15-07:00 | 09:33:15Z |
| RESULT.md / INVENTORY.json written | 02:33:51-07:00 | 09:33:51Z |

None of the result's content changes: the source pin c31e975a44ef3114d4eadddb27e75956b33ccf2c (tree 6fbe601d), the job
results and the claims are unaffected. Only the header's time was wrong.
