import json, os, pathlib
P=pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
B=P.parent.parent/'outputs/rpc-production-final-20261025/base-multipart-production-20261026'
if (P/'logs/rmp-r3-canary-copy-1758.rc').read_text().strip()!='0': raise SystemExit('copy not confirmed')
os.chdir(P)
os.execvp('bash',['bash','recovery-multipart-stage/r3/jobs/root-preservation.sh',str(B/'verify-request.json'),(B/'verify-request.sha256').read_text().strip(),str(B/'manifest.json'),(B/'manifest.sha256').read_text().strip(),'verify','0-0'])
