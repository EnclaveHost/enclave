#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo
timeout 60 ssh -p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1 "sudo python3 -" < /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-upload-502-20261021/claude/vm-db-quota.py
