#!/usr/bin/python3 -I
"""guest-state-install-stage/r1 (HOST, read-only): bind the KEPT host-fetched archive to its r3 fetch record and to a sha256 of its
exact bytes, so the guest copy can be proven identical after a local transfer (no second WAN fetch). Never writes the r3 work dir.
  python3 -I archive_provenance.py --work-dir /mnt/usb/enclave-rpc-production/state-recovery-r3 --manifest <pinned manifest> \
      --manifest-sha256 1f0c4e6c... --out <new provenance.json>
Refuses unless fetch-complete.json exists (format/url/manifest/total), total == manifest state size == archive size, and the archive
is a regular single-link file; re-checks size/mtime/inode after hashing (no concurrent writer). Transport identity only: the
content integrity is the BLAKE3 of the extracted outputs (guest install phase)."""
import argparse, hashlib, json, os, stat, sys, time

def main(argv=None):
    ap = argparse.ArgumentParser()
    for k in ('--work-dir', '--manifest', '--manifest-sha256', '--out'):
        ap.add_argument(k, required=True)
    a = ap.parse_args(argv)
    raw = open(a.manifest, 'rb').read()
    if hashlib.sha256(raw).hexdigest() != a.manifest_sha256:
        print(json.dumps({'refused': 'manifest sha256 is not the pin'})); return 2
    size = json.loads(raw)['components']['state']['size']
    done_p, arch = os.path.join(a.work_dir, 'fetch-complete.json'), os.path.join(a.work_dir, 'state.tar.zst')
    done_b = open(done_p, 'rb').read(); done = json.loads(done_b)
    st = os.lstat(arch)
    if done.get('manifestSha256') != a.manifest_sha256 or done.get('total') != size or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 \
            or st.st_size != size or not str(done.get('url', '')).endswith('/1792886410/state.tar.zst'):
        print(json.dumps({'refused': 'fetch-complete record, manifest size and archive do not agree'})); return 2
    if os.path.exists(a.out):
        print(json.dumps({'refused': f'{a.out} exists (never overwritten)'})); return 2
    h = hashlib.sha256()
    with open(arch, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    st2 = os.lstat(arch)
    if (st2.st_size, st2.st_mtime_ns, st2.st_ino) != (st.st_size, st.st_mtime_ns, st.st_ino):
        print(json.dumps({'refused': 'archive changed while hashing'})); return 2
    rec = {'format': 'enclave-host-archive-provenance/r1', 'manifestSha256': a.manifest_sha256, 'size': size, 'sha256': h.hexdigest(),
           'fetchComplete': done, 'fetchCompleteSha256': hashlib.sha256(done_b).hexdigest(), 'hostPath': arch,
           'hostIno': st.st_ino, 'hostMtimeNs': st.st_mtime_ns, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, 'w') as f:
        json.dump(rec, f, indent=1, sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())
    print(json.dumps({'provenance': a.out, 'sha256': rec['sha256']})); return 0

if __name__ == '__main__':
    sys.exit(main())
