#!/usr/bin/env python3
"""Local, loopback-only tests of vm/enclave-control-tunnel-minipc.sh and of the restriction set the minipc receiver uses,
against a throwaway NON-ROOT sshd (this machine's portable OpenSSH) on a random port. Throwaway keys in a temp dir.
Nothing leaves loopback; no production key, host or file is touched.

The receiver config mirrors minipc's planned Match block and authorized_keys options exactly, except two platform paths:
ForceCommand /usr/bin/false here vs cmd.exe /c exit 1 there, and the AuthorizedKeysFile location. The Windows 9.5 binary's
acceptance of the same keywords is checked separately on minipc (tunnel_install.py minipc-candidate-check).
"""
import os, pathlib, shutil, signal, socket, struct, subprocess, sys, tempfile, threading, time, unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "vm" / "enclave-control-tunnel-minipc.sh"
SSHD = shutil.which("sshd") or "/usr/bin/sshd"
ME = os.environ.get("USER") or subprocess.run(["id", "-un"], capture_output=True, text=True).stdout.strip()


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def dns_query(name="app.enclave.host", qtype=16, qid=0x5151):
    q = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(l)]) + l.encode() for l in name.split(".")) + b"\0" + struct.pack(">HH", qtype, 1)
    return struct.pack(">H", len(q)) + q


def ask(port, timeout=3.0):
    """one framed TCP DNS query -> the answer's (id, ancount) or None"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
            s.settimeout(timeout); s.sendall(dns_query()); b = b""
            while len(b) < 2 or len(b) < 2 + struct.unpack(">H", b[:2])[0]:
                c = s.recv(4096)
                if not c: return None
                b += c
            m = b[2:]; return struct.unpack(">H", m[:2])[0], struct.unpack(">H", m[6:8])[0]
    except OSError:
        return None


class FakeDNS:
    """TCP DNS server answering every query with ONE TXT record (the challenge daemon's stand-in)."""
    def __init__(self):
        self.sock = socket.socket(); self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0)); self.sock.listen(16); self.port = self.sock.getsockname()[1]
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            try: c, _ = self.sock.accept()
            except OSError: return
            threading.Thread(target=self.serve, args=(c,), daemon=True).start()

    def serve(self, c):
        with c:
            b = b""
            while len(b) < 2 or len(b) < 2 + struct.unpack(">H", b[:2])[0]:
                d = c.recv(4096)
                if not d: return
                b += d
            q = b[2:]; o = 12
            while q[o]: o += 1 + q[o]
            qsec = q[12:o + 5]; val = b"V" * 43
            rr = b"\xc0\x0c" + struct.pack(">HHIH", 16, 1, 60, len(val) + 1) + bytes([len(val)]) + val
            m = q[:2] + struct.pack(">HHHHH", 0x8400, 1, 1, 0, 0) + qsec + rr
            c.sendall(struct.pack(">H", len(m)) + m)


class Receiver:
    """a non-root sshd with minipc's planned restrictions for ONE user (this user) and ONE listen port"""
    def __init__(self, d, listen_port):
        self.d, self.port, self.listen_port = d, free_port(), listen_port
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(d / "hostkey")], check=True)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(d / "client")], check=True)
        pub = (d / "client.pub").read_text().strip()
        # NEGATIVE CONTROL: TUNNEL_TEST_MUTANT=open drops every restriction; the enforcement tests must then FAIL
        self.mutant = os.environ.get("TUNNEL_TEST_MUTANT") == "open"
        opts = "" if self.mutant else f'restrict,port-forwarding,permitlisten="127.0.0.1:{listen_port}",command="/usr/bin/false" '
        (d / "authorized_keys").write_text(f'{opts}{pub}\n')
        os.chmod(d / "authorized_keys", 0o600)
        (d / "sshd_config").write_text(
            f"Port {self.port}\nListenAddress 127.0.0.1\nHostKey {d}/hostkey\nPidFile none\nUsePAM no\nStrictModes no\n"
            f"PasswordAuthentication no\nKbdInteractiveAuthentication no\nLogLevel VERBOSE\nAuthorizedKeysFile none\n"
            f"Match User {ME}\n    AuthorizedKeysFile {d}/authorized_keys\n    AuthenticationMethods publickey\n    PasswordAuthentication no\n"
            + ("" if self.mutant else
               f"    AllowTcpForwarding remote\n    PermitListen 127.0.0.1:{listen_port}\n    PermitOpen none\n    PermitTTY no\n    X11Forwarding no\n"
               f"    AllowAgentForwarding no\n    GatewayPorts no\n    ForceCommand /usr/bin/false\n"))
        self.proc = None; self.start()

    def start(self):
        self.log = open(self.d / "sshd.log", "a")
        self.proc = subprocess.Popen([SSHD, "-D", "-e", "-f", str(self.d / "sshd_config")], stdout=self.log, stderr=self.log)
        for _ in range(100):
            try: socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close(); return
            except OSError: time.sleep(0.05)
        raise RuntimeError("test sshd did not start: " + (self.d / "sshd.log").read_text()[-800:])

    def descendants(self, root):
        kids = {}
        for st in pathlib.Path("/proc").glob("[0-9]*/stat"):
            try: f = st.read_text().rsplit(")", 1)[1].split(); kids.setdefault(int(f[1]), []).append(int(st.parent.name))
            except (OSError, IndexError, ValueError): pass
        out, todo = [], [root]
        while todo:
            for c in kids.get(todo.pop(), []): out.append(c); todo.append(c)
        return out

    def stop(self):
        # the listener AND its per-connection session processes (sshd-session), as a host sshd restart ends them
        if self.proc and self.proc.poll() is None:
            sessions = self.descendants(self.proc.pid)
            self.proc.terminate()
            try: self.proc.wait(5)
            except subprocess.TimeoutExpired: self.proc.kill()
            for pid in sessions:
                try: os.kill(pid, signal.SIGTERM)
                except ProcessLookupError: pass
        if getattr(self, "log", None): self.log.close()
        time.sleep(0.3)

    def known_hosts(self, alias="minipc-hyperv", key=None):
        k = key or (self.d / "hostkey.pub").read_text().split()[:2]
        p = self.d / "known_hosts"; p.write_text(f"{alias} {k[0]} {k[1]}\n"); return p


class TunnelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="tunnel-test-")); self.procs = []
        self.dns = FakeDNS(); self.listen = free_port()
        self.rx = Receiver(self.tmp, self.listen)
        # a fake `ip` first on PATH: the script's gateway resolution reads `ip -4 route show default`
        self.bin = self.tmp / "bin"; self.bin.mkdir()
        self.set_route("default via 127.0.0.1 dev lo proto static metric 100")

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                try: os.killpg(p.pid, signal.SIGTERM)
                except ProcessLookupError: pass
        self.rx.stop(); self.dns.sock.close(); shutil.rmtree(self.tmp, ignore_errors=True)

    def set_route(self, line):
        f = self.bin / "ip"; f.write_text(f"#!/bin/sh\nprintf '%s\\n' '{line}'\n" if line else "#!/bin/sh\nexit 0\n"); f.chmod(0o755)

    def env(self, known=None):
        return {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "TUNNEL_KEY": str(self.tmp / "client"),
                "TUNNEL_KNOWN_HOSTS": str(known or self.rx.known_hosts()), "TUNNEL_USER": ME, "TUNNEL_PORT": str(self.rx.port),
                "TUNNEL_REMOTE_LISTEN": f"127.0.0.1:{self.listen}", "TUNNEL_LOCAL_TARGET": f"127.0.0.1:{self.dns.port}"}

    def run_script(self, env, wait=None):
        p = subprocess.Popen([str(SCRIPT)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.procs.append(p)
        if wait is not None:
            out, err = p.communicate(timeout=wait); return p.returncode, err.decode()
        return p

    def wait_listen(self, ok=True, secs=10):
        end = time.time() + secs
        while time.time() < end:
            a = ask(self.listen, timeout=1)
            if (a is not None) == ok: return a
            time.sleep(0.2)
        return ask(self.listen, timeout=1)

    def client(self, *opts, cmd=(), timeout=8):
        """ssh as the tunnel identity: options, THEN the destination, THEN any remote command (ssh's own order)"""
        base = ["ssh", "-p", str(self.rx.port), "-i", str(self.tmp / "client"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={self.rx.known_hosts()}", "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "HostKeyAlias=minipc-hyperv", "-o", "ConnectTimeout=5"]
        try: return subprocess.run(base + list(opts) + [f"{ME}@127.0.0.1"] + list(cmd), capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as e:    # still connected = the server ACCEPTED what was asked
            return subprocess.CompletedProcess(e.cmd, 0, (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or ""),
                                               "timeout: session stayed up")

    # ---- positive ----
    def test_forward_carries_dns_to_the_daemon(self):
        self.run_script(self.env())
        a = self.wait_listen(True)
        self.assertEqual(a, (0x5151, 1), "a TCP DNS query through the remote listen reaches the challenge daemon")

    def test_no_default_gateway_refuses(self):
        self.set_route("")
        rc, err = self.run_script(self.env(), wait=10)
        self.assertEqual(rc, 1); self.assertIn("no IPv4 default gateway", err)
        self.set_route("default dev wg0 scope link")
        rc, err = self.run_script(self.env(), wait=10)
        self.assertEqual(rc, 1, "a default route without an IPv4 gateway is refused, not guessed")

    def test_wrong_pinned_host_key_refuses(self):
        other = self.tmp / "otherhost"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(other)], check=True)
        k = (other.with_suffix(".pub")).read_text().split()[:2]
        rc, err = self.run_script(self.env(known=self.rx.known_hosts(key=k)), wait=15)
        self.assertNotEqual(rc, 0); self.assertIn("Host key verification failed", err)
        self.assertIsNone(ask(self.listen, timeout=1))

    def test_reconnects_after_the_receiver_restarts_and_the_gateway_moves(self):
        # the unit's Restart=always, as a loop: every exit is followed by a fresh start (fresh gateway resolution)
        loop = subprocess.Popen(["sh", "-c", f"while true; do '{SCRIPT}'; sleep 1; done"], env=self.env(),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.procs.append(loop)
        self.assertIsNotNone(self.wait_listen(True))
        self.rx.stop()                                   # minipc sshd restart / host reboot: the session ends
        self.assertIsNone(self.wait_listen(False, secs=8))
        self.set_route("default via 127.0.0.1 dev eth0 proto dhcp src 172.19.137.173 metric 100")   # new DHCP lease shape
        self.rx.start()
        self.assertEqual(self.wait_listen(True, secs=20), (0x5151, 1), "the tunnel comes back on its own")

    # ---- negative enforcement (what minipc's receiver must refuse) ----
    def test_no_shell_no_command(self):
        r = self.client(cmd=("echo", "SHELL-REACHED"))
        self.assertNotEqual(r.returncode, 0); self.assertNotIn("SHELL-REACHED", r.stdout)

    def test_no_pty(self):
        r = self.client("-tt", cmd=("echo", "PTY-REACHED"))
        self.assertNotIn("PTY-REACHED", r.stdout); self.assertNotEqual(r.returncode, 0)

    def test_no_other_remote_listen(self):
        for spec in [f"127.0.0.1:{free_port()}:127.0.0.1:{self.dns.port}", f"0.0.0.0:{self.listen}:127.0.0.1:{self.dns.port}"]:
            r = self.client("-N", "-o", "ExitOnForwardFailure=yes", "-R", spec, timeout=15)
            self.assertNotEqual(r.returncode, 0, spec); self.assertIn("forwarding failed", r.stderr.lower() + r.stdout.lower(), spec)

    def _local_listener_refused(self, *fwd):
        lp = free_port()
        p = subprocess.Popen(["ssh", "-N", "-p", str(self.rx.port), "-i", str(self.tmp / "client"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                              "-o", f"UserKnownHostsFile={self.rx.known_hosts()}", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "HostKeyAlias=minipc-hyperv",
                              *[x.replace("LP", str(lp)) for x in fwd], f"{ME}@127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                             start_new_session=True)
        self.procs.append(p)
        got = None
        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", lp), timeout=1) as s:
                    s.settimeout(2)
                    if fwd[0] == "-D": s.sendall(b"\x05\x01\x00"); s.recv(2); s.sendall(b"\x05\x01\x00\x01\x7f\x00\x00\x01" + struct.pack(">H", self.rx.port))
                    else: s.sendall(b"SSH-2.0-probe\r\n")
                    try: got = s.recv(64)
                    except OSError: got = b""
                break
            except OSError: time.sleep(0.1)
        os.killpg(p.pid, signal.SIGTERM)
        return got

    def test_no_local_forward(self):
        got = self._local_listener_refused("-L", f"127.0.0.1:LP:127.0.0.1:{self.rx.port}")
        self.assertFalse(got and got.startswith(b"SSH-"), f"a local forward must not reach anything: {got!r}")

    def test_no_dynamic_forward(self):
        got = self._local_listener_refused("-D", "127.0.0.1:LP")
        self.assertFalse(got and len(got) >= 2 and got[1] == 0, f"a SOCKS CONNECT must be refused: {got!r}")

    # ---- the VM's negative verifier (B4): denial only counts with an authenticated session of the SAME identity ----
    def verifier(self, key=None, port=None):
        """run the verifier tunnel_install.py verify runs on the VM against this receiver. VERIFIER=old runs v1's fixture
        (test/old/verify-negative.acfdf2aa.sh) instead: the wrong-key and closed-port tests must then FAIL."""
        env = {**os.environ, "V_AS": "", "V_KEY": str(key or self.tmp / "client"), "V_KNOWN": str(self.rx.known_hosts()),
               "V_PORT": str(port or self.rx.port), "V_DPORT": str(self.rx.port), "V_USER": ME, "V_GW": "127.0.0.1"}
        cmd = (["bash", str(HERE / "old" / "verify-negative.acfdf2aa.sh")] if os.environ.get("VERIFIER") == "old"
               else [sys.executable, str(HERE.parent / "vm" / "verify-negative.py")])
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=240)
        res = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
        # v1 printed no overall line: its verdict was "every line PASS"
        res.setdefault("overall", "PASS" if res and set(res.values()) == {"PASS"} else "FAIL")
        return res, r

    def test_the_vm_verifier_passes_the_restricted_receiver(self):
        res, r = self.verifier()
        self.assertEqual(sorted(k for k in res if k != "overall"),
                         ["authenticated", "noDynamic", "noLocal", "noOtherRemote1", "noOtherRemote2", "noPty", "noShell"], r.stdout + r.stderr)
        self.assertEqual(set(res.values()), {"PASS"}, res)

    def test_the_vm_verifier_does_not_pass_with_a_wrong_key(self):
        """an identity the receiver does not know is refused at AUTH: nothing has been shown to be denied -> not PASS"""
        other = self.tmp / "unknown-client"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(other)], check=True)
        res, r = self.verifier(key=other)
        self.assertNotEqual(res["overall"], "PASS", res)
        self.assertNotIn("PASS", {v for k, v in res.items() if k != "overall"}, f"no check may PASS without authentication: {res}")

    def test_the_vm_verifier_does_not_pass_against_a_closed_port(self):
        res, r = self.verifier(port=free_port())
        self.assertNotEqual(res["overall"], "PASS", res)
        self.assertNotIn("PASS", {v for k, v in res.items() if k != "overall"}, f"a transport error is not a denial: {res}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
