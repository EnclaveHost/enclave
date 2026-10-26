echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
pid=$(ss -ltnpH 'sport = :30443' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
ss -tnpH state established 2>/dev/null | grep -E "pid=$pid," | awk '{print "tunnel_conn local="$3" peer="$4}' | grep -E 'local=[^ ]*:22 ' 
pp=$(awk '/^PPid/{print $2}' /proc/$pid/status); echo "tunnel_sshd pid=$pid ppid=$pp started=$(date -u -d @$(( $(date +%s) - $(ps -o etimes= -p $pid) )) +%FT%TZ)"
ss -tnpH state established '( sport = :22 )' 2>/dev/null | grep -c . | sed 's/^/sshd_inbound_total=/'
ss -tnH state established '( sport = :22 )' 2>/dev/null | awk '{print $4}' | sed -E 's/:[0-9]+$//' | sort | uniq -c | awk '{print "sshd_inbound_from",$2,"n="$1}'
