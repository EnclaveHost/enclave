"""Root-only read-only export; private encrypted local recovery, no provider upload."""
from pathlib import Path
import datetime, hashlib, io, json, os, secrets, socket, subprocess, tarfile, time
import http.client, http.server, threading, urllib.parse

ROOT = Path(__file__).resolve().parents[3]
os.chdir(ROOT)
os.umask(0o077)
old = ROOT / 'work/private/sia-direct-recovery'
binary = ROOT / 'work/enclave-apps-sia-recovery/sia-s3/target/x86_64-unknown-linux-gnu/release/sia-s3'
assert hashlib.sha256(binary.read_bytes()).hexdigest() == 'bcb2025e218fb99c8e98f1af1300627b223138f438b31e24f5cd989fb4ee70d1'
rid = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4)
private = old / rid
private.mkdir(mode=0o700)
snapshot = private / 'snapshot.json'
sock = socket.socket()
sock.bind(('127.0.0.1', 0))
port = sock.getsockname()[1]
sock.close()
ssh = ['ssh', '-N', '-p', '32422', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
       '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
       '-o', 'UserKnownHostsFile=work/storage-vm/known_hosts', '-i', '/home/steven/.ssh/minipc',
       '-L', f'127.0.0.1:{port}:127.0.0.1:9982', 'storageadmin@127.0.0.1']
# The indexer signs requests for its configured hostname, not the tunnel's IP.
# This local GET-only proxy retains that hostname in the SDK signature while
# carrying every request through the authenticated SSH tunnel; no DNS/public hop.
class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # signed request URLs must never enter logs

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.scheme != 'http' or url.netloc != 'sia.enclave.host' or url.fragment:
            self.send_error(403)
            return
        upstream = http.client.HTTPConnection('127.0.0.1', port, timeout=45)
        try:
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in ('host', 'connection', 'proxy-connection', 'proxy-authorization')}
            headers['Host'] = 'sia.enclave.host'
            upstream.request('GET', urllib.parse.urlunsplit(('', '', url.path, url.query, '')), headers=headers)
            response = upstream.getresponse()
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() not in ('connection', 'transfer-encoding'):
                    self.send_header(k, v)
            self.send_header('Connection', 'close')
            self.end_headers()
            while chunk := response.read(65536):
                self.wfile.write(chunk)
        except (OSError, http.client.HTTPException):
            self.close_connection = True
        finally:
            upstream.close()

proxy = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
thread = threading.Thread(target=proxy.serve_forever, daemon=True)
thread.start()
with (private / 'tunnel.stderr').open('wb') as diagnostics:
    tunnel = subprocess.Popen(ssh, stdout=subprocess.DEVNULL, stderr=diagnostics)
    try:
        deadline = time.monotonic() + 15
        while True:
            assert tunnel.poll() is None, 'owned tunnel exited; protected diagnostics retained'
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=1):
                    break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError('owned tunnel did not become ready')
                time.sleep(0.2)
        env = {k: v for k, v in os.environ.items() if k not in (
            'ENCLAVE_CONFIG', 'SIAS3_CONFIG', 'ENCLAVE_EGRESS', 'HTTP_PROXY', 'HTTPS_PROXY',
            'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')}
        env['SIA_RECOVERY_KEY_FILE'] = str(old / 'app.seed')
        env['HTTP_PROXY'] = f'http://127.0.0.1:{proxy.server_port}'
        env['http_proxy'] = env['HTTP_PROXY']
        env['NO_PROXY'] = env['no_proxy'] = ''
        export = subprocess.run([str(binary), 'recovery', 'export', 'http://sia.enclave.host', str(snapshot)],
                                env=env, capture_output=True, timeout=180)
        (private / 'export.stderr').write_bytes(export.stderr)
        if export.returncode:
            raise RuntimeError(f'export failed ({export.returncode}); protected diagnostics retained at {rid}')
        report = json.loads(export.stdout)
    finally:
        proxy.shutdown()
        proxy.server_close()
        thread.join(timeout=5)
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill()
            tunnel.wait(timeout=5)

raw = snapshot.read_bytes()
assert report['readOnlyExport'] is True
assert report['snapshotSha256'] == hashlib.sha256(raw).hexdigest()
assert report['snapshotBytes'] == len(raw)
files = {'snapshot.json': raw, 'app.seed': (old / 'app.seed').read_bytes(), 'sia-s3-linux': binary.read_bytes()}
manifest = {'sourceCommit': '446ac5f43b5e30413875ed33341241ea3120b63c', 'export': report,
            'files': {n: {'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()} for n, b in files.items()},
            'limitations': 'Point-in-time observed keys, not a transactional mutable-bucket backup. Recovery reads only; funding and contract expiry still matter.'}
files['manifest.json'] = json.dumps(manifest, indent=2).encode()
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w') as tar:
    for name, data in files.items():
        entry = tarfile.TarInfo(name)
        entry.mode = 0o600
        entry.size = len(data)
        tar.addfile(entry, io.BytesIO(data))
encrypted = private / ('sia-direct-recovery-' + rid + '.tar.gpg')
gpg = ['gpg', '--no-options', '--batch', '--no-symkey-cache', '--pinentry-mode', 'loopback',
       '--passphrase-file', str(old / 'backup.pass')]
subprocess.run(gpg + ['--symmetric', '--cipher-algo', 'AES256', '--output', str(encrypted)],
               input=archive.getvalue(), capture_output=True, check=True, timeout=60)
decrypted = subprocess.run(gpg + ['--decrypt', str(encrypted)], capture_output=True, check=True, timeout=60).stdout
with tarfile.open(fileobj=io.BytesIO(decrypted)) as tar:
    assert set(tar.getnames()) == set(files)
    for name, data in files.items():
        assert tar.extractfile(name).read() == data
assert encrypted.stat().st_mode & 0o777 == 0o600
receipt = {'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'runId': rid,
           'export': report, 'encryptedArchive': encrypted.name,
           'archiveSha256': hashlib.sha256(encrypted.read_bytes()).hexdigest(), 'archiveBytes': encrypted.stat().st_size,
           'authenticatedDecryptionAndAllMembersVerified': True, 'storedOffDigitalOcean': 'local workstation',
           'providerCopiesCreated': 0, 'liveWrites': False, 'funding': False, 'ownedTunnelStopped': tunnel.poll() is not None,
           'limitations': manifest['limitations'], 'privateSnapshotRetained': True}
out = ROOT / 'outputs/decentralization-audit/storage-cold-recovery-refresh-20261022.json'
out.write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
