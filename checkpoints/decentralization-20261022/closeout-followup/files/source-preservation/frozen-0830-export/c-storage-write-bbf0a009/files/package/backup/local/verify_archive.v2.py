#!/usr/bin/env python3
"""Authenticated-decryption + completeness check of one fresh-backup archive (the existing verify-encrypted-backup.py,
parameterized and stricter). Streams; persists NO plaintext; prints booleans, counts and hashes only.
  python3 .../local/verify_archive.py --run-id R --passphrase-file work/private/indexd-recovery/backup.pass
PASS needs: gpg exit 0 after the stream is consumed to its authenticated end; every member a regular file named in the
expected set, each exactly once, no other member; the archive's manifest == the manifest recorded at pull time; every
member's sha256 == the manifest; the archive's sha256 == the pull receipt. Writes outputs/storage-fresh-backup-<R>-integrity.json
(exclusive).

v2 (storage-write-release; the pinned b4f71bbb is unchanged): the integrity result also carries what the AUTHENTICATED
in-archive manifest says about the capture - capturedAt, runId, source, quiesced/writerWasActive, stoppedSeconds and the
bundled binary's sha256 - and PASS additionally needs the manifest bound to this run id and a well-formed capture time.
`verifiedAt` stays the time of THIS verification: a re-verification of an old archive never makes the capture look fresh
(root's cutover review, 2026-10-23). Output format "storage-fresh-backup-integrity/v2"; written beside v1's name with a
"-v2" suffix so neither overwrites the other."""
import argparse, datetime, hashlib, json, os, re, subprocess, sys, tarfile, time
# the pinned shared module of the fresh-backup tools (storage-fresh-backup/local/common.py be0a9b0c), used as it is
COMMON_SHA256 = "be0a9b0cd45ebcc5df1691c7169ceb7eb83c1e0ff1973d3cb56a60124fff9ba3"
FRESH_LOCAL = os.environ.get("FB_LOCAL") or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                         *[".."] * 5, "claude-resumed-20261022", "storage-fresh-backup", "local"))
with open(os.path.join(FRESH_LOCAL, "common.py"), "rb") as _f:
    if hashlib.sha256(_f.read()).hexdigest() != COMMON_SHA256:
        sys.exit(f"refused: {FRESH_LOCAL}/common.py is not the pinned be0a9b0c")
sys.path.insert(0, FRESH_LOCAL)
from common import MEMBERS, check_private_dir, gpg_decrypt, private_log, sha256_path, utc, write_json_new


def capture_time(v):
    """the manifest's capturedAt ('%Y-%m-%dT%H:%M:%SZ', UTC as the runner writes it) -> the same string, or None"""
    if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", v):
        return None
    try:
        datetime.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None
    return v


def walk(archive, passphrase_file, log, on_member, deadline):
    """Decrypt `archive` and call on_member(name, fileobj) for each member; returns (gpg_rc, names, manifest, problems)."""
    proc = subprocess.Popen(gpg_decrypt(passphrase_file, archive), stdout=subprocess.PIPE, stderr=log)
    names, manifest, problems = [], None, []
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
            for m in tar:
                if time.monotonic() > deadline:
                    problems.append("deadline"); break
                if not m.isfile() or m.name not in MEMBERS + ["manifest.json"] or m.name in names:
                    problems.append("unexpected member " + re.sub(r"[^ -~]", "?", m.name)[:80]); break
                names.append(m.name)
                f = tar.extractfile(m)
                if m.name == "manifest.json":
                    manifest = json.loads(f.read(1 << 20))
                else:
                    on_member(m.name, f)
        proc.stdout.read()                       # consume to the authenticated end of the GPG stream
    except (tarfile.TarError, json.JSONDecodeError, OSError) as e:
        problems.append(type(e).__name__)
    finally:
        proc.stdout.close()
        try:
            rc = proc.wait(timeout=max(1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(); rc = "timeout"
    return rc, names, manifest, problems


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
    rp = os.path.join(a.outputs_dir, f"storage-fresh-backup-{a.run_id}.json")
    outp = os.path.join(a.outputs_dir, f"storage-fresh-backup-{a.run_id}-integrity-v2.json")
    if os.path.lexists(outp):
        sys.exit("refused: integrity result already exists")
    r = json.loads(open(rp).read())
    archive = os.path.join(a.private_dir, r["file"])
    archive_ok = sha256_path(archive) == r["sha256"]
    seen = {}

    def hash_member(name, f):
        h = hashlib.sha256()
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
        seen[name] = h.hexdigest()

    log = private_log(a.private_dir, f"fresh-backup-{a.run_id}-verify.log")
    rc, names, manifest, problems = walk(archive, a.passphrase_file, log, hash_member, time.monotonic() + a.deadline)
    log.close()
    files = (manifest or {}).get("files", {})
    checks = {
        "archiveSha256MatchesReceipt": archive_ok,
        "authenticatedDecryptionPassed": rc == 0 and not problems,
        "membersExactlyExpected": sorted(names) == sorted(MEMBERS + ["manifest.json"]),
        "manifestEqualsPullTimeManifest": manifest == r["sourceSnapshot"],
        "allMemberHashesMatch": bool(files) and set(seen) == set(files) and all(seen[n] == files[n]["sha256"] for n in seen),
        "coupledAndResumed": bool(manifest) and manifest.get("coupled") is True and manifest.get("sourceResumed") is True,
        "manifestBoundToRun": bool(manifest) and manifest.get("runId") == a.run_id and r.get("runId") == a.run_id,
        "captureTimeAuthenticated": capture_time((manifest or {}).get("capturedAt")) is not None,
    }
    m = manifest or {}
    result = {"format": "storage-fresh-backup-integrity/v2", "verifiedAt": utc(), "runId": a.run_id, "archive": r["file"], "archiveSha256": r["sha256"], **checks,
              "problems": problems, "plaintextPersistedLocally": False, "dbVersion": m.get("dbVersion"),
              "counts": m.get("counts"),
              # from the AUTHENTICATED manifest only (never the local pull receipt): what was captured, when and where
              "capturedAt": capture_time(m.get("capturedAt")), "manifestRunId": m.get("runId"), "source": m.get("source"),
              "quiesced": m.get("quiesced"), "writerWasActive": m.get("writerWasActive"), "stoppedSeconds": m.get("stoppedSeconds"),
              "binarySha256": (m.get("files") or {}).get("indexd", {}).get("sha256"),
              "pass": all(checks.values())}
    write_json_new(outp, result)
    print(json.dumps({k: result[k] for k in ("pass", *checks)}))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
