# Preserve the actual guarded-job exit status

The previous workstation `q.sh` wrote the guard exit code to a receipt and then implicitly returned the successful `echo` status. A guard failure99 could therefore look like wrapper success0. The recorded guard/receipt remained authoritative; no native failure has been counted as success.

This copy adds `exit "$rc"` after writing the receipt. It preserves retries of98 (not started) only, all admission and memory guards, commands, and logs. Existing running jobs retain their original wrapper; new jobs should use this copy. Earlier failure receipts are retained unchanged. This workstation helper contains an absolute path and is not a production service.
