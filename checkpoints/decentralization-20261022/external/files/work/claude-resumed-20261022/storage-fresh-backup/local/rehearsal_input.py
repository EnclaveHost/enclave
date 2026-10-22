#!/usr/bin/env python3
"""Make the restore-check INPUT for the existing offline rehearsal (indexd-c2-production-rehearsal/preflight-fresh-backup.sh
and run.sh) from one VERIFIED fresh-backup archive. Persists only what the rehearsal reads - indexd.pgdump, consensus.db,
indexd, GeoLite2-City.mmdb - plus, because the backup is COUPLED, the same quiesced dump as the "live dump". indexd.yml
(wallet/config secrets) is hashed in the stream and NEVER written (configAndOperationsSecretsExtracted=false).
  python3 .../local/rehearsal_input.py --run-id R --passphrase-file work/private/indexd-recovery/backup.pass --out-dir DIR
DIR must not exist; it is created 0700, files 0600. Refuses unless the integrity result for R passed. On any failure the
files this run created are removed only from the directory it created (same dev/inode); otherwise the directory is kept
and reported UNKNOWN."""
import argparse, hashlib, json, os, re, stat, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import check_private_dir, private_log, utc
from verify_archive import walk

PERSIST = ["indexd.pgdump", "consensus.db", "indexd", "GeoLite2-City.mmdb"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--passphrase-file", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--private-dir", default="work/private/indexd-recovery")
    ap.add_argument("--outputs-dir", default="outputs")
    ap.add_argument("--deadline", type=int, default=1800)
    a = ap.parse_args()
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", a.run_id):
        sys.exit("refused: bad run id")
    check_private_dir(a.private_dir)
    r = json.load(open(os.path.join(a.outputs_dir, f"storage-fresh-backup-{a.run_id}.json")))
    integ = json.load(open(os.path.join(a.outputs_dir, f"storage-fresh-backup-{a.run_id}-integrity.json")))
    if integ.get("pass") is not True or integ.get("archiveSha256") != r["sha256"]:
        sys.exit("refused: the archive has no passing integrity result")
    os.mkdir(a.out_dir, 0o700)                          # exclusive: FileExistsError if it exists
    st = os.lstat(a.out_dir); ident = (st.st_dev, st.st_ino)
    snap = os.path.join(a.out_dir, "retirement-snapshot"); os.mkdir(snap, 0o700)
    live_name = f"live-indexd-{a.run_id}.pgdump"
    created = [snap]
    seen = {}

    def keep(name, f):
        h = hashlib.sha256()
        targets = []
        if name in PERSIST:
            targets.append(os.path.join(snap, name))
        if name == "indexd.pgdump":
            targets.append(os.path.join(a.out_dir, live_name))
        fds = []
        for t in targets:
            fds.append(os.open(t, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)); created.append(t)
        try:
            for c in iter(lambda: f.read(1 << 20), b""):
                h.update(c)
                for fd in fds:
                    os.write(fd, c)
            for fd in fds:
                os.fsync(fd)
        finally:
            for fd in fds:
                os.close(fd)
        seen[name] = h.hexdigest()

    log = private_log(a.private_dir, f"fresh-backup-{a.run_id}-extract.log")
    rc, names, manifest, problems = walk(os.path.join(a.private_dir, r["file"]), a.passphrase_file, log, keep, time.monotonic() + a.deadline)
    log.close()
    files = (manifest or {}).get("files", {})
    good = rc == 0 and not problems and manifest == r["sourceSnapshot"] and set(seen) == set(files) \
        and all(seen[n] == files[n]["sha256"] for n in seen)
    if not good:
        st = os.lstat(a.out_dir)
        if (st.st_dev, st.st_ino) == ident and stat.S_ISDIR(st.st_mode):
            for t in reversed(created):
                (os.rmdir if t == snap else os.unlink)(t)
            os.rmdir(a.out_dir)
            print(json.dumps({"extracted": False, "removedOwnPartial": True, "problems": problems}))
        else:
            print(json.dumps({"extracted": False, "removedOwnPartial": False, "UNKNOWN": "output directory identity changed; kept"}))
        return 1
    def put(name, obj):
        fd = os.open(os.path.join(a.out_dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode()); os.close(fd)
    put("retirement-extraction-receipt.json", {
        "at": utc(), "authenticatedArchive": r["file"], "allArchiveMembersVerified": True,
        "persistedOnly": {n: seen[n] for n in PERSIST}, "configAndOperationsSecretsExtracted": False,
        "snapshotCounts": manifest["counts"], "snapshotCapturedAt": manifest["capturedAt"], "runId": a.run_id})
    put("live-dump-receipt.json", {
        "at": utc(), "source": f"coupled fresh backup {a.run_id} (the same quiesced dump)", "mode": "coupled-quiesced",
        "bytes": files["indexd.pgdump"]["bytes"], "sha256": seen["indexd.pgdump"], "file": live_name,
        "sourceRestarted": manifest.get("sourceResumed") is True})
    print(json.dumps({"extracted": True, "dir": a.out_dir, "persisted": PERSIST + [live_name], "configExtracted": False,
                      "next": f"work/indexd-c2-production-rehearsal/preflight-fresh-backup.sh {a.out_dir}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
