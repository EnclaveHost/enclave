# READ-ONLY control-VM metadata for enclave-api-relay (run as: sudo python3 -).
# Prints: whitelisted unit properties, unit/drop-in KEY NAMES (+ values only for whitelisted non-secret keys), process
# identity, sha256/stat of relay source files, certs.json stat + section COUNTS + order ages. Never: Environment values,
# /proc/<pid>/environ, env files' contents, account blobs, order URLs/CSRs, certificates, keys.
import subprocess, os, hashlib, json, re, time, glob, pwd, grp, stat
U = "enclave-api-relay.service"
def sh(*a):
    p = subprocess.run(list(a), text=True, capture_output=True); return p.stdout.strip()
out = {"now_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
props = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ExecMainStartTimestamp", "ActiveEnterTimestamp",
         "NRestarts", "FragmentPath", "DropInPaths", "WorkingDirectory", "User", "Group", "DynamicUser", "Restart",
         "RestartUSec", "TimeoutStopUSec", "KillMode", "KillSignal", "SendSIGKILL", "StateDirectory", "ReadWritePaths",
         "ProtectSystem", "EnvironmentFiles", "Type", "UnitFileState"]
out["unit"] = dict(l.split("=", 1) for l in sh("systemctl", "show", U, "-p", ",".join(props)).splitlines() if "=" in l)
es = sh("systemctl", "show", U, "-p", "ExecStart", "--value")
out["unit"]["ExecStart.argv"] = re.findall(r"argv\[\]=([^;]*);", es)
SAFE = {"ExecStart", "ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "WorkingDirectory", "User", "Group",
        "Restart", "RestartSec", "KillMode", "KillSignal", "TimeoutStopSec", "StateDirectory", "ReadWritePaths",
        "DynamicUser", "Type", "ProtectSystem", "After", "Wants", "Requires", "EnvironmentFile"}
files = [out["unit"].get("FragmentPath", "")] + out["unit"].get("DropInPaths", "").split()
uf = {}
for f in filter(None, files):
    try:
        lines = open(f).read().splitlines()
    except Exception as e:
        uf[f] = f"unreadable: {e.__class__.__name__}"; continue
    rows = []
    for l in lines:
        m = re.match(r"\s*([A-Za-z]+)\s*=(.*)", l)
        if not m: continue
        k, v = m.group(1), m.group(2).strip()
        rows.append(f"{k}={v}" if k in SAFE else f"{k}=<{len(v)} chars, not shown>")
    st = os.stat(f)
    uf[f] = {"sha256": hashlib.sha256(open(f, "rb").read()).hexdigest(), "mtime": time.strftime("%FT%TZ", time.gmtime(st.st_mtime)), "keys": rows}
out["unit_files"] = uf
pid = out["unit"].get("MainPID", "0")
if pid and pid != "0":
    p = f"/proc/{pid}"
    try:
        cmd = open(f"{p}/cmdline", "rb").read().split(b"\0")
        out["proc"] = {"cmdline": [re.sub(r"[A-Za-z0-9_\-]{40,}", "<long>", c.decode(errors="replace")) for c in cmd if c],
                       "cwd": os.readlink(f"{p}/cwd"), "exe": os.readlink(f"{p}/exe"),
                       "start": sh("ps", "-o", "lstart=", "-p", pid), "etimes": sh("ps", "-o", "etimes=", "-p", pid),
                       "user": sh("ps", "-o", "user=", "-p", pid), "rss_kib": sh("ps", "-o", "rss=", "-p", pid),
                       "node_version": sh(os.readlink(f"{p}/exe"), "-v")}
        # files the process holds open under its cwd tree (names only)
        fds = []
        for fd in glob.glob(f"{p}/fd/*"):
            try:
                t = os.readlink(fd)
                if t.startswith("/") and not t.startswith(("/dev", "/proc")): fds.append(t)
            except Exception: pass
        out["proc"]["open_files"] = sorted(set(fds))[:40]
    except Exception as e:
        out["proc"] = f"error {e.__class__.__name__}: {e}"
# relay source: script path from argv, its directory
src_dir = None
for a in out.get("proc", {}).get("cmdline", []) if isinstance(out.get("proc"), dict) else []:
    if a.endswith((".js", ".mjs")):
        cand = a if a.startswith("/") else os.path.join(out["proc"]["cwd"], a)
        src_dir = os.path.dirname(os.path.realpath(cand)); out["entry"] = os.path.realpath(cand); break
if not src_dir and isinstance(out.get("proc"), dict): src_dir = os.path.realpath(out["proc"]["cwd"])
out["src_dir"] = src_dir
if src_dir:
    def meta(fp):
        st = os.lstat(fp)
        d = {"sha256": hashlib.sha256(open(fp, "rb").read()).hexdigest() if stat.S_ISREG(os.stat(fp).st_mode) else None,
             "size": st.st_size, "mode": oct(st.st_mode & 0o7777), "mtime": time.strftime("%FT%TZ", time.gmtime(st.st_mtime)),
             "owner": f"{pwd.getpwuid(st.st_uid).pw_name}:{grp.getgrgid(st.st_gid).gr_name}"}
        if os.path.islink(fp): d["symlink_to"] = os.readlink(fp)
        return d
    sel = {}
    for n in ["certs.js", "store.js", "fleet-auth.js", "domains.js", "api-relay.js", "package.json"]:
        fp = os.path.join(src_dir, n)
        sel[n] = meta(fp) if os.path.lexists(fp) else "absent"
    out["src_files"] = sel
    out["src_dir_stat"] = meta(src_dir)
    out["src_dir_realpath"] = os.path.realpath(src_dir)
    out["src_dir_listing_certs_like"] = sorted(x for x in os.listdir(src_dir) if "cert" in x.lower())
    out["src_dir_is_git"] = os.path.isdir(os.path.join(src_dir, ".git"))
    out["src_dir_parent_listing"] = sorted(os.listdir(os.path.dirname(src_dir)))[:40]
    out["src_dir_fs"] = sh("df", "--output=source,fstype,target", src_dir).splitlines()[-1:]
    out["src_dir_mount_ro"] = sh("findmnt", "-n", "-o", "OPTIONS", "--target", src_dir)
    try:
        imp = [l for l in open(os.path.join(src_dir, "api-relay.js")).read().splitlines() if "certs.js" in l][:5]
        out["api_relay_imports_certs"] = [l.strip()[:200] for l in imp]
    except Exception as e:
        out["api_relay_imports_certs"] = str(e)
# certs.json: locate under the unit's state dir(s), stat + counts only
cands = sorted(set(glob.glob("/var/lib/enclave-relay/certs.json") + glob.glob("/var/lib/private/enclave-relay/certs.json") + glob.glob("/var/lib/*/certs.json") + glob.glob("/var/lib/private/*/certs.json")))
cj = {}
now = time.time() * 1000
for f in cands:
    st = os.stat(f)
    d = {"size": st.st_size, "mode": oct(st.st_mode & 0o7777), "mtime": time.strftime("%FT%TZ", time.gmtime(st.st_mtime)),
         "owner": f"{st.st_uid}:{st.st_gid}", "dir_mode": oct(os.stat(os.path.dirname(f)).st_mode & 0o7777),
         "siblings_certs_like": sorted(x for x in os.listdir(os.path.dirname(f)) if "cert" in x.lower())}
    try:
        j = json.load(open(f))
        d["sections"] = {k: (len(v) if isinstance(v, (dict, list)) else type(v).__name__) for k, v in j.items()}
        d["orders"] = [{"name": o.get("name"), "ca": o.get("ca"), "age_s": round((now - o.get("at", 0)) / 1000),
                        "has_txt": bool(o.get("txtName"))} for o in (j.get("orders") or {}).values()]
        d["failures_names_n_age"] = [{"name": n, "n": v.get("n"), "age_s": round((now - v.get("at", 0)) / 1000)}
                                     for n, v in (j.get("failures") or {}).items() if "ef514ed3" in n]
        d["cert_ef514ed3"] = [{"ca": c.get("ca"), "notAfter": c.get("notAfter"), "issuedAt": c.get("issuedAt")}
                              for c in (j.get("certs") or {}).values() if "ef514ed3" in str(c.get("name"))]
    except Exception as e:
        d["parse"] = e.__class__.__name__
    cj[f] = d
out["certs_json"] = cj
print(json.dumps(out, indent=1))
