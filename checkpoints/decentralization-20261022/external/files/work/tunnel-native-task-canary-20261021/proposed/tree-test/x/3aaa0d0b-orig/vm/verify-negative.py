#!/usr/bin/env python3
"""verify-negative.py v2 - run ON THE CONTROL VM by tunnel_install.py verify (as root). Uses the tunnel identity IN PLACE
(never copied or printed) and proves, per check, that the SAME authenticated identity is DENIED:
  authenticated  positive control: the identity authenticates and an empty -N session is accepted (else nothing counts)
  noShell        a remote command: no output, refused
  noPty          a PTY request: refused
  noOtherRemote  -R on another port, and -R on 0.0.0.0: "remote port forwarding failed"
  noLocal        -L: our own ssh owns the local listener, the server answers "open failed" (no SSH banner comes back)
  noDynamic      -D: our own ssh owns the SOCKS listener, the server answers "open failed"
Each line is NAME=PASS | FAIL (the server ALLOWED it) | ERROR (no authenticated session, or the check could not be
made: transport, auth, port, listener). overall=PASS only if every line is PASS.
Local ports come from the kernel (bind to port 0), and the listener is checked to belong to our own ssh's PID.
The V_* variables exist for the local test harness only; on the VM the defaults apply.
"""
import os, re, socket, struct, subprocess, sys, time

E = os.environ.get
KEY = E("V_KEY", "/var/lib/enclave-control-tunnel/id_ed25519")
KNOWN = E("V_KNOWN", "/var/lib/enclave-control-tunnel/known_hosts")
PORT = E("V_PORT", "22")
DPORT = int(E("V_DPORT", "22"))                       # a port that IS listening on the target (minipc's sshd)
AS = E("V_AS", "sudo -u enclave-control-tunnel").split()
WHO = E("V_USER", "enc-ctl-tunnel")


def gateway():
    if E("V_GW"): return E("V_GW")
    r = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True).stdout
    m = re.search(r"^default via (\d+\.\d+\.\d+\.\d+)", r, re.M)
    return m.group(1) if m else None


GW = gateway()
BASE = AS + ["ssh", "-v", "-p", PORT, "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
             "-o", f"UserKnownHostsFile={KNOWN}", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "HostKeyAlias=minipc-hyperv",
             "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5"]
DEST = f"{WHO}@{GW}"
AUTH = re.compile(r"Authenticated to |Authentication succeeded")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def run(opts, cmd=(), timeout=20):
    """-> (rc or None on timeout, stdout, stderr, timed_out); a timeout kills the WHOLE group (sudo and its ssh)"""
    p = subprocess.Popen(BASE + opts + [DEST] + list(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        o, e = p.communicate(timeout=timeout); return p.returncode, o.decode(errors="replace"), e.decode(errors="replace"), False
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid, 15)
        except ProcessLookupError: pass
        o, e = p.communicate(); return None, o.decode(errors="replace"), e.decode(errors="replace"), True


def owns(port, pid):
    """is the ONLY listener on 127.0.0.1:port a process of OUR tree (sudo may sit between us and ssh: walk all levels)?"""
    r = subprocess.run(["ss", "-Hltnp", f"sport = :{port}"], capture_output=True, text=True).stdout
    pids = {int(x) for x in re.findall(r"pid=(\d+)", r)}
    tree, todo = {pid}, [pid]
    while todo:
        for x in subprocess.run(["pgrep", "-P", str(todo.pop())], capture_output=True, text=True).stdout.split():
            if int(x) not in tree: tree.add(int(x)); todo.append(int(x))
    return bool(pids) and pids <= tree


res = {}


def check_authenticated():
    rc, o, e, to = run(["-N", "-o", "ExitOnForwardFailure=yes"], timeout=8)
    res["authenticated"] = "PASS" if (to and AUTH.search(e)) else "ERROR"


def check_command(name, opts, marker):
    rc, o, e, to = run(opts, ("echo", marker))
    if not AUTH.search(e): res[name] = "ERROR"; return
    res[name] = "FAIL" if marker in o else ("PASS" if (not to and rc not in (0, 255)) or "PTY allocation request failed" in e else "FAIL")


def check_remote(name, spec):
    rc, o, e, to = run(["-N", "-o", "ExitOnForwardFailure=yes", "-R", spec], timeout=20)
    if not AUTH.search(e): res[name] = "ERROR"; return
    res[name] = "PASS" if (not to and "remote port forwarding failed" in e.lower()) else "FAIL"


def check_channel(name, kind):
    lp = free_port()
    fwd = ["-L", f"127.0.0.1:{lp}:127.0.0.1:{DPORT}"] if kind == "L" else ["-D", f"127.0.0.1:{lp}"]
    p = subprocess.Popen(BASE + ["-N"] + fwd + [DEST], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    try:
        for _ in range(60):
            if owns(lp, p.pid) or p.poll() is not None: break
            time.sleep(0.2)
        if p.poll() is not None or not owns(lp, p.pid):
            res[name] = "ERROR"; return
        got = b""
        try:
            with socket.create_connection(("127.0.0.1", lp), timeout=5) as s:
                s.settimeout(5)
                if kind == "D":
                    s.sendall(b"\x05\x01\x00"); s.recv(2)
                    s.sendall(b"\x05\x01\x00\x01\x7f\x00\x00\x01" + struct.pack(">H", DPORT)); got = s.recv(2)
                else:
                    try: got = s.recv(16)
                    except socket.timeout: got = b""
        except OSError: got = b""
        time.sleep(1)
    finally:
        try: os.killpg(p.pid, 15)
        except ProcessLookupError: pass
        err = p.stderr.read().decode(errors="replace") if p.stderr else ""
    if not AUTH.search(err): res[name] = "ERROR"; return
    allowed = got.startswith(b"SSH-") if kind == "L" else (len(got) == 2 and got[1] == 0)
    denied = "open failed" in err
    res[name] = "FAIL" if allowed else ("PASS" if denied else "ERROR")


if not GW:
    print("authenticated=ERROR"); print("overall=FAIL"); sys.exit(1)
check_authenticated()
check_command("noShell", [], "SHELL-REACHED")
check_command("noPty", ["-tt"], "PTY-REACHED")
check_remote("noOtherRemote1", f"127.0.0.1:{free_port()}:127.0.0.1:{DPORT}")
check_remote("noOtherRemote2", f"0.0.0.0:{free_port()}:127.0.0.1:{DPORT}")
check_channel("noLocal", "L")
check_channel("noDynamic", "D")
for k, v in res.items(): print(f"{k}={v}")
ok = res and all(v == "PASS" for v in res.values()) and len(res) == 7
print(f"overall={'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
