# Runs ON a front (sent over ssh to bash -s). READ-ONLY: hashes, stat, systemctl show, ss, versions, df, and the
# ROUTING STRUCTURE of the ipfs.enclave.host site block only (allow-listed directives; anything secret-looking redacted;
# header values never printed). Prints key=value lines.
set -u
echo "host=$(hostname)"
CF=/etc/caddy/Caddyfile
if [ -f $CF ]; then echo "caddyfile=$CF sha256=$(sha256sum $CF | cut -c1-64) bytes=$(stat -c %s $CF) mode=$(stat -c '%a %U:%G' $CF)"; else echo "caddyfile=ABSENT"; fi
for f in /etc/caddy/* /etc/caddy/*/*; do [ -f "$f" ] && [ "$f" != $CF ] && echo "etc_caddy_other=$f sha256=$(sha256sum "$f" | cut -c1-64)"; done 2>/dev/null
for p in ActiveState FragmentPath DropInPaths MainPID; do echo "caddy_$p=$(systemctl show caddy -p $p --value 2>/dev/null)"; done
echo "caddy_ExecStart=$(systemctl show caddy -p ExecStart --value 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p')"
echo "listen443=$(ss -Hltnp 'sport = :443' 2>/dev/null | awk '{print $4"|"$6}' | tr '\n' ' ')"
cb=$(command -v caddy || true); echo "caddy_bin=${cb:+$(readlink -f $cb)} version=$(caddy version 2>/dev/null | head -1)"
echo "python3=$(python3 --version 2>&1 | head -1) node=$( (command -v node >/dev/null && node -v) || ( [ -x /usr/local/bin/node ] && /usr/local/bin/node -v) || echo none)"
echo "opt_free_mib=$(df -B1M --output=avail /opt | tail -1 | tr -d ' ') etc_free_mib=$(df -B1M --output=avail /etc | tail -1 | tr -d ' ')"
for d in /opt/enclave-site/*/; do [ -d "$d" ] || continue
  for f in "$d"*; do [ -f "$f" ] && echo "site_file=$f bytes=$(stat -c %s "$f") sha256=$(sha256sum "$f" | cut -c1-64) mode=$(stat -c '%a %U:%G' "$f")"; done; done
[ -e /opt/enclave-site-blocks ] && echo "blocks_dir=PRESENT entries=$(find /opt/enclave-site-blocks -type f | wc -l)" || echo "blocks_dir=absent"
[ -e /root/ens-site-activation ] && echo "activation_dir=PRESENT" || echo "activation_dir=absent"
[ -f $CF ] && python3 - "$CF" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding="utf-8", errors="replace").read().split("\n")
SECRET = re.compile(r"(?i)(auth|token|secret|key|passw|bearer|cookie|credential|hmac|signature|private)")
ALLOW = re.compile(r"^(@[\w-]+(\s*\{)?|path\s|path_regexp\s|query\s|not\s|method\s|host\s|handle(\s|$)|handle_path\s|route(\s|$)|root\s|rewrite\s|reverse_proxy(\s|$)|file_server|respond(\s|$)|import\s|file(\s|$)|try_files\s|encode\s|uri\s|redir\s|\}|\{)")
starts = []
depth = 0
for i, l in enumerate(lines):
    t = l.strip()
    if depth == 0 and t.endswith("{") and re.search(r"(^|[\s,/])ipfs\.enclave\.host(:\d+)?([\s,]|\{|$)", t):
        starts.append(i)
    depth += t.count("{") - t.count("}")
print(f"ipfs_block_count={len(starts)}")
if len(starts) == 1:
    s = starts[0]; d = 0; e = None
    for j in range(s, len(lines)):
        d += lines[j].count("{") - lines[j].count("}")
        if d == 0: e = j; break
    print(f"ipfs_block_lines={s+1}-{(e or 0)+1} site_address={lines[s].strip()[:120]}")
    generic = []
    d = 0
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
