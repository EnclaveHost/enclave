echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
pid=$(ss -ltnpH 'sport = :30443' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
sess=$(grep -oE 'session-[0-9]+' /proc/$pid/cgroup | head -1 | cut -d- -f2)
echo "tunnel_sshd pid=$pid session=$sess $(loginctl show-session "$sess" -p Name -p RemoteHost -p Timestamp -p Service --no-pager 2>/dev/null | tr '\n' ' ')"
ss -ltnH 2>/dev/null | awk '$4 ~ /^127\.0\.0\.1:/ {print $4}' | while read a; do p=$(ss -ltnpH "sport = :${a##*:}" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2); [ "$p" = "$pid" ] && echo "tunnel_forwarded_port $a"; done | sort -u
