#!/usr/bin/env python3
"""Stream one COMPLETE fresh-backup run off the VM into a new locally encrypted archive (the existing backup-encrypt.py
pipeline, parameterized by run id). ROOT ONLY; run from the workspace root (/home/steven/Documents/Codex/2026-10-18/wo).
  python3 .../local/pull_encrypt.py --run-id R --passphrase-file work/private/indexd-recovery/backup.pass
Refuses unless the VM receipt says outcome=complete, backupComplete, coupled, sourceResumed, and its manifest names exactly
the expected members with the same hashes. Exclusive outputs only: the archive and receipt names must not exist; the
partial file is created O_EXCL and published by link() (never overwriting). On any failure the own partial is removed
(same inode as created) and nothing is published; a lost transport never yields a receipt."""
import argparse, json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (MEMBERS, REMOTE_PARENT, SSH, check_private_dir, gpg_encrypt, private_log, remote, sha256_path,
                    utc, wait_all, write_json_new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--passphrase-file", required=True)
    ap.add_argument("--private-dir", default="work/private/indexd-recovery")
    ap.add_argument("--outputs-dir", default="outputs")
    ap.add_argument("--deadline", type=int, default=1800)
    a = ap.parse_args()
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", a.run_id):
        sys.exit("refused: bad run id")
    check_private_dir(a.private_dir)
    if not os.path.isfile(a.passphrase_file):
        sys.exit("refused: passphrase file missing (path checked only, never read here)")
    out = os.path.join(a.private_dir, f"indexd-minipc-fresh-{a.run_id}.tar.gpg")
    partial = out + ".partial"
    receipt_path = os.path.join(a.outputs_dir, f"storage-fresh-backup-{a.run_id}.json")
    for p in (out, partial, receipt_path):
        if os.path.lexists(p):
            sys.exit(f"refused: {p} already exists (outputs are never reused or overwritten)")

    rc, raw = remote(f"sudo cat {REMOTE_PARENT}/{a.run_id}.receipt.json", 60)
    if rc != 0:
        sys.exit(f"refused: VM receipt unreadable (rc {rc}); a missing receipt means the run's outcome is UNKNOWN - use `status`")
    vm = json.loads(raw)
    if not (vm.get("outcome") == "complete" and vm.get("backupComplete") is True and vm.get("coupled") is True
            and vm.get("sourceResumed") is True and sorted(vm.get("files", {})) == sorted(MEMBERS)):
        sys.exit("refused: the VM run is not a complete, coupled backup with the source restored")
    d = vm["directory"]
    if d != f"{REMOTE_PARENT}/{a.run_id}":
        sys.exit("refused: unexpected VM directory")
    rc, raw = remote(f"sudo cat {d}/manifest.json", 60)
    if rc != 0:
        sys.exit("refused: VM manifest unreadable")
    manifest = json.loads(raw)
    if manifest.get("files") != vm["files"] or manifest.get("runId") != a.run_id:
        sys.exit("refused: VM manifest and receipt disagree")

    log = private_log(a.private_dir, f"fresh-backup-{a.run_id}.log")
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    ident = os.fstat(fd).st_ino
    ok = False
    try:
        src = subprocess.Popen(SSH + [f"sudo tar -C {d} -cf - " + " ".join(MEMBERS + ["manifest.json"])],
                               stdout=subprocess.PIPE, stderr=log)
        dst = subprocess.Popen(gpg_encrypt(a.passphrase_file), stdin=src.stdout, stdout=fd, stderr=log)
        src.stdout.close()
        rcs = wait_all([src, dst], time.monotonic() + a.deadline)
        os.fsync(fd)
        if rcs != [0, 0]:
            print(json.dumps({"encrypted": False, "transportRc": rcs[0], "gpgRc": rcs[1],
                              "note": "nothing published; VM plaintext untouched"}))
            return 1
        os.link(partial, out)                       # fails if `out` appeared meanwhile: never overwrite
        ok = True
    finally:
        os.close(fd)
        try:
            if os.lstat(partial).st_ino == ident:       # only the file this run created
                os.unlink(partial)
        except FileNotFoundError:
            pass
        log.close()
    h = sha256_path(out)
    receipt = {"encryptedAt": utc(), "file": os.path.basename(out), "bytes": os.path.getsize(out), "sha256": h,
               "runId": a.run_id, "vmReceipt": {k: vm[k] for k in ("outcome", "writerWasActive", "sourceResumed", "coupled", "elapsedSeconds")},
               "sourceSnapshot": manifest, "replicas": [], "decryptionKeyReplicated": False,
               "location": "local workstation " + a.private_dir, "verified": False,
               "next": "local/verify_archive.py --run-id " + a.run_id}
    write_json_new(receipt_path, receipt)
    print(json.dumps({"encrypted": ok, "file": receipt["file"], "bytes": receipt["bytes"], "sha256": h}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
