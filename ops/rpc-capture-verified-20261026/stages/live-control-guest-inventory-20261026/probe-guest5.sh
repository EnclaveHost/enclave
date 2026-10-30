S="sudo -n"
echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
gp=$($S ss -ltnpH 'sport = :8190' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
echo "gateway pid=$gp env_var_names=$($S cat /proc/$gp/environ | tr '\0' '\n' | cut -d= -f1 | grep -vE '^(PATH|HOME|LANG|USER|LOGNAME|SHELL|INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|MEMORY_PRESSURE_WATCH|MEMORY_PRESSURE_WRITE|PWD|TERM)$' | sort | tr '\n' ,)"
$S cat /proc/$gp/environ | tr '\0' '\n' | grep -E '^[A-Z0-9_]+=.*[a-z]+://' | grep -viE 'KEY|TOKEN|SECRET|PASS|AUTH' | python3 -c '
import sys,re
from urllib.parse import urlsplit
for l in sys.stdin:
  k,v=l.rstrip().split("=",1); o=[]
  for x in re.split(r"[,\s]+",v):
    if re.match(r"^[a-z]+://",x): u=urlsplit(x); o.append(u.scheme+"://"+str(u.hostname)+(":"+str(u.port) if u.port else ""))
  print("  gateway_env",k,"= n=%d"%len(o),",".join(o))'
echo "gateway_source_origins=$(grep -oE 'https?://[A-Za-z0-9.\-]+(:[0-9]+)?' /opt/enclave-rpc/gateway.mjs | sort -u | tr '\n' ,)"
echo "gateway_source_env_refs=$(grep -oE 'process\.env\.[A-Z0-9_]+|env\[.[A-Z0-9_]+.\]' /opt/enclave-rpc/gateway.mjs | sed -E 's/.*\.//; s/env\[.//; s/.\]$//' | sort -u | tr '\n' ,)"
echo "gateway_methods_hint=$(grep -oE "eth_[A-Za-z]+" /opt/enclave-rpc/gateway.mjs | sort -u | head -30 | tr '\n' ,)"
systemctl show enclave-rpc-gateway -p FragmentPath -p DropInPaths -p LoadCredential -p SetCredential --value 2>/dev/null | tr '\n' ' ' | sed -E 's/:[^ ]*//g; s/^/gateway_unit_paths_and_credential_names /'; echo
