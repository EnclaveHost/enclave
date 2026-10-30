# production-cutover-current-plan-stage (PREPARED; nothing run; every activation flag stays false)
| file | what |
|---|---|
| `canaries/public-rpc-egress-observe.sh` | read-only: sockets of a systemd unit's processes vs the 5 public providers' resolved addresses |
| `canaries/windows-public-rpc-egress-observe.ps1` | the same for the Windows node's node.exe processes |
| `canaries/static-public-rpc-scan.sh` | read-only: no public provider host in a shipped site/credit/guest bundle or release dir |
| `scratch.git` refs/c/r9-credit | private scratch composition: r9 82ec7d45 + consumer 12b41d459 (clean, untested) |
The plan and missing-step list: `../logs/claude-production-cutover-current-plan-result.md`.
