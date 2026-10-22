# READ-ONLY, ON a front: which process/unit serves :443, and the Caddy instance(s) behind it (unit, binary, version,
# config path + sha256, listeners), plus the ROUTING STRUCTURE of the ipfs.enclave.host site block in that config
# (same allow-list/redaction as front-readonly.sh). No file content beyond allow-listed routing directives.
set -u
pid=$(ss -Hltnp 'sport = :443' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
echo "p443_pid=$pid p443_unit=$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ') p443_exe=$(readlink -f /proc/$pid/exe 2>/dev/null) p443_script=$(tr '\0' '\n' < /proc/$pid/cmdline 2>/dev/null | grep -m1 '\.m\?js$')"
for u in enclave-bootstrap-tls caddy; do
  echo "unit_$u active=$(systemctl show $u -p ActiveState --value) exec=$(systemctl show $u -p ExecStart --value | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p')"
done
for p in $(pgrep -x caddy) $(pgrep -f 'enclave-caddy/caddy'); do echo "caddy_proc pid=$p unit=$(ps -o unit= -p $p | tr -d ' ') exe=$(readlink -f /proc/$p/exe) listens=$(ss -Hltnp | grep "pid=$p," | awk '{print $4}' | sort -u | tr '\n' ' ')"; done | sort -u
for b in /usr/local/lib/enclave-caddy/caddy /usr/bin/caddy; do [ -x $b ] && echo "caddy_version $b $($b version 2>/dev/null | head -1)"; done
CF=/etc/enclave-bootstrap-tls/Caddyfile
[ -f $CF ] && echo "bootstrap_caddyfile=$CF sha256=$(sha256sum $CF | cut -c1-64) bytes=$(stat -c %s $CF) mode=$(stat -c '%a %U:%G' $CF)" || echo "bootstrap_caddyfile=ABSENT"
for f in /etc/enclave-bootstrap-tls/*; do [ -f "$f" ] && [ "$f" != $CF ] && echo "bootstrap_other=$f sha256=$(sha256sum "$f" | cut -c1-64) bytes=$(stat -c %s "$f")"; done
[ -f $CF ] && python3 - "$CF" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().split("\n")
SECRET = re.compile(r"(?i)(auth|token|secret|key|passw|bearer|cookie|credential|hmac|signature|private)")
ALLOW = re.compile(r"^(@[\w-]+(\s*\{)?|path\s|path_regexp\s|query\s|not\s|method\s|host\s|handle(\s|$)|handle_path\s|route(\s|$)|root\s|rewrite\s|reverse_proxy(\s|$)|file_server|respond(\s|$)|import\s|file(\s|$)|try_files\s|encode\s|uri\s|redir\s|bind\s|tls\s|\}|\{)")
sites, depth = [], 0
for i, l in enumerate(lines):
    t = l.strip()
    if depth == 0 and t.endswith("{") and not t.startswith("("): sites.append((i, t[:-1].strip()[:100]))
    depth += t.count("{") - t.count("}")
print("site_blocks=" + " | ".join(f"{i+1}:{s}" for i, s in sites))
starts = [i for i, s in sites if re.search(r"(^|[\s,/])ipfs\.enclave\.host(:\d+)?([\s,]|$)", s + " ")]
print(f"ipfs_block_count={len(starts)}")
for s in starts:
    d, e = 0, None
    for j in range(s, len(lines)):
        d += lines[j].count("{") - lines[j].count("}")
        if d == 0: e = j; break
    print(f"ipfs_block_lines={s+1}-{(e or 0)+1}")
    generic, d = [], 0
    for j in range(s, (e or s) + 1):
        t = lines[j].strip()
        if j > s and d == 1 and re.match(r"^handle\s+/ipfs/\*\s*\{$", t): generic.append(j + 1)
        if t.startswith("header") and not SECRET.search(t): out = "header <" + (t.split()[1] if len(t.split()) > 1 else "") + " ...>"
        elif SECRET.search(t): out = "[redacted line]"
        elif ALLOW.match(t) or t == "": out = t
        else: out = (t.split()[0] if t else "") + " [...]"
        if out: print(f"struct {j+1:4d} d{d} {out[:160]}")
        d += lines[j].count("{") - lines[j].count("}")
    print(f"generic_ipfs_handle_lines={','.join(map(str, generic))} count={len(generic)}")
PY
