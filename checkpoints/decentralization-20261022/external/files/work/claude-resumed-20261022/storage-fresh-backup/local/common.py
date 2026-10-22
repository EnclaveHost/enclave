"""Shared workstation helpers for the fresh coupled backup. The pipeline is the EXISTING one
(work/storage-vm/backup-encrypt.py + verify-encrypted-backup.py): ssh -> sudo tar on the VM -> local gpg --symmetric
AES256 with the existing protected passphrase file -> an archive in the protected local private directory. Nothing here
reads the passphrase or any plaintext member's content into output; gpg/ssh stderr goes to a 0600 private log only."""
import hashlib, json, os, subprocess, time

REMOTE_PARENT = "/var/lib/enclave-indexd/fresh-backup"
MEMBERS = ["indexd.pgdump", "consensus.db", "indexd", "indexd.yml", "GeoLite2-City.mmdb", "counts.json"]
# the existing transport to the VM (backup-encrypt.py), plus explicit liveness bounds
SSH = [os.environ.get("FB_SSH", "ssh"), "-p", "32422", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
       "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
       "-o", "UserKnownHostsFile=work/storage-vm/known_hosts", "-i", "/home/steven/.ssh/minipc", "storageadmin@127.0.0.1"]
GPG = os.environ.get("FB_GPG", "gpg")


def gpg_encrypt(passphrase_file):
    return [GPG, "--batch", "--pinentry-mode", "loopback", "--passphrase-file", passphrase_file, "--symmetric",
            "--cipher-algo", "AES256", "--compress-algo", "ZLIB", "--output", "-"]


def gpg_decrypt(passphrase_file, archive):
    return [GPG, "--batch", "--pinentry-mode", "loopback", "--passphrase-file", passphrase_file, "--decrypt", archive]


def utc():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_path(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def write_new(path, data, mode=0o600):
    """Create `path` exclusively (never overwrite) and write `data`."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.write(fd, data); os.fsync(fd)
    finally:
        os.close(fd)


def write_json_new(path, obj):
    write_new(path, (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode(), 0o644 if "/outputs/" in "/" + path else 0o600)


def remote(cmd, timeout):
    """One bounded ssh command; returns (rc, stdout bytes). stderr is discarded (it can carry no plaintext member)."""
    try:
        r = subprocess.run(SSH + [cmd], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
        return r.returncode, r.stdout
    except subprocess.TimeoutExpired:
        return "timeout", b""


def private_log(private_dir, name):
    fd = os.open(os.path.join(private_dir, name), os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    return os.fdopen(fd, "ab")


def check_private_dir(d):
    st = os.lstat(d)
    import stat as S
    if not S.S_ISDIR(st.st_mode) or S.S_IMODE(st.st_mode) != 0o700 or st.st_uid != os.getuid():
        raise SystemExit(f"refused: {d} must be an existing 0700 directory owned by you (not a symlink)")


def wait_all(procs, deadline):
    """Wait for every process; on the wall deadline kill all and report 'timeout'."""
    while True:
        if all(p.poll() is not None for p in procs):
            return [p.returncode for p in procs]
        if time.monotonic() > deadline:
            for p in procs:
                if p.poll() is None:
                    p.kill()
            for p in procs:
                p.wait()
            return ["timeout"] * len(procs)
        time.sleep(0.2)
