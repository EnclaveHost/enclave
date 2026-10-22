"""Run under the shared memory guard. Actual Caddy routing plus exact production-config validation."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

from transform import transform, FRAGMENT, ANCHOR

HERE = Path(__file__).resolve().parent
CADDY = HERE.parent / "directory-https-activation/test/bin/caddy-2.11.4"
HOSTS = {"us-west": "134.199.235.187", "eu-central": "134.209.248.172",
         "ap-southeast": "165.245.191.129", "ca-east": "146.190.246.39"}


class Routes(unittest.TestCase):
    def test_exact_transform_and_real_config_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, XDG_DATA_HOME=tmp + "/data", XDG_CONFIG_HOME=tmp + "/config")
            for host, ip in HOSTS.items():
                with self.subTest(host=host):
                    original = (HERE / "baseline" / (host + ".Caddyfile")).read_text()
                    result = transform(original, ip)
                    self.assertEqual(result.replace(FRAGMENT, "", 1), original)
                    self.assertEqual(transform(result, ip), result)
                    self.assertEqual(result.count(FRAGMENT), 1)
                    dest = Path(tmp) / (host + ".Caddyfile")
                    dest.write_text(result)
                    run = subprocess.run([str(CADDY), "validate", "--config", str(dest), "--adapter", "caddyfile"],
                                         env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(run.returncode, 0, run.stderr[-2000:])

    def test_transform_refuses_conflicts(self):
        source = "\nhttps://127.0.0.1 {\n" + ANCHOR + "}\n"
        for bad in [source + source, source.replace(ANCHOR, ""), source + "# /platform-policy\n",
                    transform(source, "127.0.0.1").replace('header Cache-Control "no-cache"', 'header Cache-Control "public"')]:
            with self.subTest(source=bad[:100]):
                with self.assertRaises(ValueError):
                    transform(bad, "127.0.0.1")

    def test_actual_http_routing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "public"
            root.mkdir()
            ready = b'{"format":"enclave-platform-policy-mirror/v1","policyActivated":false}\n'
            (root / "ready.json").write_bytes(ready)
            (root / "secret.txt").write_text("must never be exposed")
            name = "0x" + hashlib.sha256(b"fixture only").hexdigest() + ".json"
            # Synthetic transport payload: no valid signature or chain anchor is implied.
            body = b'{"document":"fixture","signature":"invalid"}\n'
            (root / name).write_bytes(body)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            config = Path(tmp) / "Caddyfile"
            config.write_text("{\n admin off\n auto_https off\n}\nhttp://127.0.0.1:" + str(port) + " {\n"
                              + FRAGMENT.replace("/var/lib/enclave-platform-policy", str(root))
                              + '    handle /v1/network/records {\n respond "directory fixture" 200\n }\n'
                              + '    handle {\n respond "legacy fixture" 418\n }\n}\n')
            env = dict(os.environ, XDG_DATA_HOME=tmp + "/data", XDG_CONFIG_HOME=tmp + "/config")
            with (Path(tmp) / "caddy.log").open("w+") as log:
                child = subprocess.Popen([str(CADDY), "run", "--config", str(config), "--adapter", "caddyfile"],
                                         env=env, stdout=log, stderr=log)
                def request(method, path, headers=None):
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                    try:
                        conn.request(method, path, headers=headers or {})
                        res = conn.getresponse()
                        return res.status, dict(res.getheaders()), res.read()
                    finally:
                        conn.close()
                try:
                    for _ in range(100):
                        try:
                            request("GET", "/platform-policy/ready.json")
                            break
                        except OSError:
                            if child.poll() is not None:
                                log.seek(0)
                                self.fail(log.read()[-3000:])
                            time.sleep(.05)
                    status, headers, data = request("GET", "/platform-policy/ready.json", {"Origin": "https://other.example"})
                    self.assertEqual((status, data), (200, ready))
                    self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
                    self.assertNotIn("Access-Control-Allow-Credentials", headers)
                    self.assertEqual(request("GET", "/platform-policy/" + name)[2], body)
                    self.assertEqual(request("HEAD", "/platform-policy/" + name)[0::2], (200, b""))
                    self.assertEqual(request("OPTIONS", "/platform-policy/" + name,
                                             {"Origin": "https://other.example", "Access-Control-Request-Method": "GET"})[0], 204)
                    for method, path in [("POST", name), ("PUT", name), ("DELETE", name),
                                         ("GET", "secret.txt"), ("GET", "latest.json"), ("GET", "0xBAD.json"),
                                         ("GET", "nested/" + name), ("GET", ""), ("GET", "%2e%2e%2fsecret.txt")]:
                        with self.subTest(method=method, path=path):
                            status, _, content = request(method, "/platform-policy/" + path)
                            self.assertNotEqual(status, 200)
                            self.assertNotIn(b"must never be exposed", content)
                    self.assertEqual(request("GET", "/v1/network/records")[0::2], (200, b"directory fixture"))
                    self.assertEqual(request("GET", "/legacy")[0::2], (418, b"legacy fixture"))
                finally:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()


if __name__ == "__main__":
    unittest.main(verbosity=2)
