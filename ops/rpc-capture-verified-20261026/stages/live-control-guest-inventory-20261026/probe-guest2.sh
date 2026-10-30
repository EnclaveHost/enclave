S="sudo -n"
echo "utc=$(date -u +%FT%TZ) host=$(hostname)"
cfg=$(systemctl show enclave-control-tls -p ExecStart --value | grep -oE -- '--config[ =][^ ;]+' | head -1 | sed -E 's/--config[ =]//'); ad=$(systemctl show enclave-control-tls -p ExecStart --value | grep -oE -- '--adapter[ =][^ ;]+' | sed -E 's/--adapter[ =]//')
echo "caddy_config=$cfg adapter=${ad:-auto} sha16=$($S sha256sum "$cfg" 2>/dev/null | cut -c1-16) caddy_version=$(/usr/bin/caddy version 2>/dev/null | awk '{print $1}')"
$S cat "$cfg" 2>/dev/null | python3 -c '
import sys,re,json
t=sys.stdin.read()
try:
  j=json.loads(t)
  for sn,s in j.get("apps",{}).get("http",{}).get("servers",{}).items():
    print("server",sn,"listen",s.get("listen"))
    def walk(rs,hosts):
      for r in rs or []:
        h=hosts
        for m in r.get("match",[]) or []:
          if m.get("host"): h=m["host"]
        for hd in r.get("handle",[]) or []:
          if hd.get("handler")=="reverse_proxy": print(" route hosts=%s upstreams=%s"%(",".join(h or ["*"]),",".join(u.get("dial","?") for u in hd.get("upstreams",[]))))
          if hd.get("handler")=="subroute": walk(hd.get("routes"),h)
    walk(s.get("routes"),None)
except Exception:
  site=None
  for l in t.splitlines():
    s=l.strip()
    if not s or s.startswith("#"): continue
    if l and not l[0].isspace() and s.endswith("{"): site=s[:-1].strip(); print("site",site[:160]); continue
    m=re.match(r"reverse_proxy\s+(?:(\S+)\s+)?((?:[a-z]+://)?[0-9A-Za-z.\-\[\]]+:\d+(?:\s+[0-9A-Za-z.\-\[\]:/]+:\d+)*)",s)
    if m: print("  reverse_proxy matcher=%s upstream=%s"%(m.group(1) if m.group(1) and ":" not in m.group(1) else "-", re.sub(r"[a-z]+://","",m.group(2))))
    m=re.match(r"@(\S+)\s+host\s+(.+?)\s*(\{)?$",s)
    if m: print("  matcher @%s host %s"%(m.group(1),m.group(2)[:160]))
' | head -60
