# 2026-09-25: two apps stopped accepting, with their records reading healthy

**Closed.** All six apps recovered at 00:36:09Z. The cause is NOT understood; this records what
was measured so the next occurrence starts further along.

## What happened

| time (UTC) | |
|---|---|
| ~00:11 | Codex reports TLS `unexpected EOF` for `e64f7cba`, `d9798e4c`, `a77d0c57`, and for the Linux canaries `4e62e60d` and `395bed3e`. Recovers by itself. |
| 00:15 | `d9798e4c` (ipns-publisher) has a DIFFERENT symptom: clean TLS (`verify=0`), HTTP timeout, sustained, in sequential and parallel clients. |
| 00:17 | Diagnosed from the box: **its own loopback `127.0.0.1:9776` does not answer** (000 after 10 s). |
| 00:18 | Single-app force relaunch (`POST /v1/deployments/<id>/restart`). Reloads cleanly into a new slot, lease/config/secrets preserved - **and still hangs**. |
| ~00:20 | `e64f7cba` (RISC Box) joins it: loopback `127.0.0.1:9822` also dead. Three others stay healthy. |
| 00:22 | Evidence archived, then the shared node restarted via the scheduled task. |
| 00:23 | `d9798e4c` answers 200 immediately. |
| 00:36 | `e64f7cba` answers 200, after its ~14-minute 21.8 GiB guest restore. 6/6. |

## What the evidence rules out

- **Not ingress, the relay or TLS.** The loopback ports were dead FROM THE BOX. Codex's `verify=0`
  with an HTTP timeout says the same thing from outside.
- **Not app state.** A fresh reload of `d9798e4c` hung the same way.
- **Not the `wasi:cli` world.** `7ae476a3` and `c34499ee` are `wasi:cli` too and stayed up.
- **Not the lease.** Renewals continued throughout; the records read `status: running`.
- **Not the isolation work.** None of it is deployed: the node runs the bytes recorded at
  `ef1b2077`, whose hashes were unchanged before and after (`170a0db0…`, `d2595f35…`, `6ec96d19…`).

## What it points at, without proving

A **fresh reload hangs while a node restart fixes it** puts the fault in the shared enclave - the
`ee-host` worker and the brokered sockets - rather than in either app. The `ee-host` process had
17,241 s of CPU across 13 threads at the time; that is high but not by itself a diagnosis.

The app-zone log shows the same shape for both: the TLS handshake completes, `serving from
127.0.0.1:<port>` is logged, and then `app read ECONNRESET`. **That `serving on` line is the
LOADER's, not the app's own readiness**, which is why the record can read healthy while nothing
answers - and why `status: running` was not evidence here.

## The honest gaps

1. **The cause is unexplained.** Three occurrences tonight (this one, and two earlier apps that
   self-recovered). "A node restart clears it" is a workaround, not an understanding.
2. **The 00:11 cross-host EOFs are unexplained too.** They hit Linux canaries as well, which is a
   CORRELATION and not evidence that NucBox or the isolation work was uninvolved. An earlier note of
   mine called them "not NucBox-specific"; that overstated what correlation can carry.
3. **Two route types, and they are not interchangeable.** `/x/<id>` and
   `<label>.app.enclave.host` take different paths, and an earlier health claim of mine covered only
   the first. Both belong in any recovery criterion.

## What would move it next time

- Capture `ee-host` thread stacks before restarting - the restart destroys the only evidence.
- Check whether the hung apps share an enclave SLOT number. The log shows slot numbers repeating
  across apps (two apps both "slot 3"), which may be display or may be real.
- A readiness signal from the APP rather than the loader, so `status: running` means something.
