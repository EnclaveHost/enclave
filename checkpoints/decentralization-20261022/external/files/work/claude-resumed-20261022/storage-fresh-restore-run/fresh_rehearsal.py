#!/usr/bin/env python3
"""Run the storage-enclave-rehearsal (20 phases, unchanged) on root's FRESH, quiesced, COUPLED production backup
20261022T075011Z-bee519f1 instead of the old captures. ROOT ONLY; nothing here was run against a database.

Reuse, not a fork:
  - The rehearsal module is storage-enclave-rehearsal/rehearse/rehearse-c2.py, loaded READ-ONLY from its verified bytes
    (sha256 BASE_SHA); its rhfx.py (RHFX_SHA) and through it the reviewed c2fx.py r3 (ff1b092c, checked by rhfx).
  - Every phase, assertion, helper, pin, cleanup and refusal is the module's own. This wrapper rebinds exactly FIVE
    module globals before calling the module's main():
        INP   -> the fresh rehearsal input directory (root-prepared, 0700, config secrets NOT extracted)
        SNAP  -> INP/retirement-snapshot
        LIVE  -> INP/live-indexd-<run>.pgdump (for a coupled backup: the same quiesced dump)
        BINARIES["indexd-original"] -> (SNAP/indexd, the module's own ORIG_SHA 2d7a637e) - same hash, new source
        RUNS  -> work/fr-runs/ (r2; journals/stages/results never land in the other worker's package). NOT this package's
                 runs/: the stage holds PostgreSQL's unix socket, which indexd (pgx, Go) dials on the HOST side as
                 <RUNS>/<16-hex run id>/sock/.s.PGSQL.5432, and Go refuses an AF_UNIX name longer than 107 bytes with
                 EINVAL (syscall_linux.go SockaddrUnix.sockaddr, Path [108]int8). Under the package that path was 138
                 bytes: root-run1 (aaee0cac7170551d) failed at S1 exactly there. socket_path_problem() gates it.
  - It adds "inputProvenance" to the module's results (written by the module) - setup's own literal
    "freshQuiescedCutoverBackup": false is the unchanged base return value; the provenance block is the validated fact.
Fresh-input gate (before ANY module action, in --plan and --execute): the receipt chain
  backup receipt (pinned sha) -> integrity result (pinned sha, pass) -> archive bytes (sha == receipt) ->
  extraction receipts in INP (runId, authenticated archive name, persisted hashes == the archive manifest's hashes,
  counts/capturedAt == the manifest, config not extracted, coupled-quiesced live dump == the archive's indexd.pgdump)
  -> the input bytes themselves (sha == receipts), modes 0700/0600, no indexd.yml anywhere in INP.
  It refuses the OLD captures (work/indexd-production-rehearsal): they carry no run id / coupled-quiesced receipts.
Modes:  --plan | --execute <manifest> | --recover <run id>       (the manifest covers base pins + fresh pins + this file)
"""
import hashlib
import json
import os
import stat
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = next(p for p in HERE.parents if p.name == "work")
ROOTDIR = WORK.parent                                                     # the workspace (outputs/ lives here)
RUN_ID = "20261022T075011Z-bee519f1"
BASE = WORK / "claude-resumed-20261022" / "storage-enclave-rehearsal" / "rehearse" / "rehearse-c2.py"
BASE_SHA = "b12b9fde91f56494e5e2e8a0d5d68df11bd0fd1ef611a9a31cf46d4174c4a31b"
RHFX_SHA = "b3c2c62b53e5162e8f3c191b7a87139af06a4772bebcca75725c40be9c29ac4e"
ORIG_SHA = "2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc"
FRESH = {
    "inputDir": WORK / "private" / f"indexd-fresh-rehearsal-{RUN_ID}",
    "backupReceipt": (ROOTDIR / "outputs" / f"storage-fresh-backup-{RUN_ID}.json", "3a04c1d5979d3897a545bdacf59026f8cd87cbca713ed93bedf24248f136b0e8"),
    "integrity": (ROOTDIR / "outputs" / f"storage-fresh-backup-{RUN_ID}-integrity.json", "9e017242b7db905e6b2c0cb26d75d3927f9cbdf0ceb79e0e9ae550aa84e6ab01"),
    "archiveDir": WORK / "private" / "indexd-recovery",
}
PERSIST = ["GeoLite2-City.mmdb", "consensus.db", "indexd", "indexd.pgdump"]
RUNS = WORK / "fr-runs"                                                   # short: see socket_path_problem()
RUN_ID_HEX = 16                                                           # c2fx.Run: secrets.token_hex(8)
SOCK_SUFFIX = "/sock/.s.PGSQL.5432"                                       # base bind_stage SOCK = W/"sock"; indexd.yml port 5432
SUN_PATH_MAX = 107                                                        # sizeof(sockaddr_un.sun_path) 108 minus the NUL


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def load_base(path=BASE, want=BASE_SHA, rhfx_want=RHFX_SHA):
    """Load the rehearsal module from bytes verified against `want`; its rhfx.py must be rhfx_want before AND after."""
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != want:
        raise SystemExit(f"refused: {path} is not the pinned rehearsal module {want[:8]}")
    rhfx_path = Path(path).parent / "rhfx.py"
    if sha(rhfx_path) != rhfx_want:
        raise SystemExit(f"refused: {rhfx_path} is not the pinned rhfx {rhfx_want[:8]}")
    mod = types.ModuleType("rehearse_c2")
    mod.__file__ = str(Path(path).resolve())                # HERE/PKG/pins() resolve to the ORIGINAL package, read-only
    sys.modules["rehearse_c2"] = mod
    exec(compile(data, mod.__file__, "exec"), mod.__dict__)
    if sha(Path(sys.modules["rhfx"].__file__)) != rhfx_want:
        raise SystemExit("refused: rhfx changed while loading")
    if mod.ORIG_SHA != ORIG_SHA:
        raise SystemExit("refused: the module's ORIG_SHA is not the deployed v0.6.0 binary")
    return mod


def rebind(mod, inp, runs=RUNS):
    """The five overrides; everything else stays the module's own."""
    mod.INP = Path(inp)
    mod.SNAP = mod.INP / "retirement-snapshot"
    mod.LIVE = mod.INP / f"live-indexd-{RUN_ID}.pgdump"
    mod.BINARIES = {**mod.BINARIES, "indexd-original": (mod.SNAP / "indexd", mod.ORIG_SHA)}
    mod.RUNS = Path(runs)
    return mod


def socket_path_problem(runs, base_source):
    """None if indexd's host-side PostgreSQL socket path fits AF_UNIX for every run id; else the reason. The constants are
    re-derived from the base module's own source, so a change there cannot silently invalidate this gate."""
    if 'SOCK, MIG = W / "secrets", W / "state", W / "sock", W / "migration"' not in base_source or "  host: {SOCK}\n  port: 5432\n" not in base_source:
        return "base module no longer binds SOCK=W/sock with database host {SOCK} port 5432: re-derive the socket gate"
    n = len(str(Path(runs))) + 1 + RUN_ID_HEX + len(SOCK_SUFFIX)
    if n > SUN_PATH_MAX:
        return f"PostgreSQL socket path would be {n} bytes (> {SUN_PATH_MAX}, AF_UNIX limit): indexd cannot connect"
    p = Path(runs)
    if p.is_symlink() or (p.exists() and not p.is_dir()):
        return f"{runs} is not a plain directory"
    return None


def _mode(p):
    return stat.S_IMODE(os.lstat(p).st_mode)


def validate_fresh(inp, backup_receipt, integrity, archive_dir, run_id=RUN_ID, hash_inputs=True):
    """-> (facts, problems). Metadata, hashes and booleans only; no row, config or key is read."""
    bad, facts = [], {}
    inp = Path(inp)
    def need(cond, what):
        if not cond:
            bad.append(what)
        return cond
    (bp, bh), (ip, ih) = backup_receipt, integrity
    if not need(Path(bp).is_file() and sha(bp) == bh, f"backup receipt {Path(bp).name} is not the pinned {bh[:8]}"):
        return facts, bad
    if not need(Path(ip).is_file() and sha(ip) == ih, f"integrity result {Path(ip).name} is not the pinned {ih[:8]}"):
        return facts, bad
    b, i = json.loads(Path(bp).read_text()), json.loads(Path(ip).read_text())
    snap = b.get("sourceSnapshot", {})
    vm = b.get("vmReceipt", {})
    need(b.get("runId") == run_id and snap.get("runId") == run_id and i.get("runId") == run_id, "run id differs across receipts")
    need(vm.get("outcome") == "complete" and vm.get("coupled") is True and vm.get("sourceResumed") is True, "VM receipt is not complete+coupled+resumed")
    need(snap.get("quiesced") is True and snap.get("coupled") is True and snap.get("sourceResumed") is True and snap.get("writerWasActive") is True,
         "source snapshot is not a quiesced, coupled capture of the running writer with the source resumed")
    need(snap.get("dbVersion") == 26, "backup schema is not v26")
    need(snap.get("binarySha256") == ORIG_SHA, "backup binary is not the deployed v0.6.0 2d7a637e")
    need(b.get("decryptionKeyReplicated") is False and b.get("replicas") == [], "receipt records replicas or a replicated key")
    checks = ("pass", "archiveSha256MatchesReceipt", "authenticatedDecryptionPassed", "membersExactlyExpected",
              "manifestEqualsPullTimeManifest", "allMemberHashesMatch", "coupledAndResumed")
    need(all(i.get(k) is True for k in checks) and i.get("problems") == [], "integrity result did not pass every check")
    need(i.get("archiveSha256") == b.get("sha256") and i.get("archive") == b.get("file"), "integrity result names another archive")
    arch = Path(archive_dir) / str(b.get("file"))
    if hash_inputs:
        need(arch.is_file() and sha(arch) == b.get("sha256"), "encrypted archive bytes differ from the receipt")
    files = snap.get("files", {})
    # the decrypted rehearsal input: exactly what the extraction tool persists, bound to the archive manifest
    need(inp.is_dir() and not inp.is_symlink() and _mode(inp) == 0o700, "input dir is not a 0700 directory")
    rrp, lrp = inp / "retirement-extraction-receipt.json", inp / "live-dump-receipt.json"
    if not need(rrp.is_file() and lrp.is_file(), "input dir lacks the extraction receipts"):
        return facts, bad
    rr, lr = json.loads(rrp.read_text()), json.loads(lrp.read_text())
    need(rr.get("runId") == run_id and rr.get("authenticatedArchive") == b.get("file") and rr.get("allArchiveMembersVerified") is True,
         "extraction receipt is not this run's authenticated archive")
    need(rr.get("configAndOperationsSecretsExtracted") is False, "configuration/operations secrets were extracted")
    po = rr.get("persistedOnly", {})
    need(sorted(po) == sorted(PERSIST), "persisted set is not exactly the four rehearsal files")
    need(all(po.get(n) == files.get(n, {}).get("sha256") for n in PERSIST), "persisted hashes differ from the archive manifest")
    need(rr.get("snapshotCounts") == snap.get("counts") and rr.get("snapshotCapturedAt") == snap.get("capturedAt"),
         "extraction counts/capturedAt differ from the archive manifest")
    live_name = f"live-indexd-{run_id}.pgdump"
    need(lr.get("mode") == "coupled-quiesced" and lr.get("file") == live_name and lr.get("sourceRestarted") is True,
         "live-dump receipt is not this run's coupled quiesced dump")
    need(lr.get("sha256") == files.get("indexd.pgdump", {}).get("sha256") and lr.get("bytes") == files.get("indexd.pgdump", {}).get("bytes"),
         "the live dump is not the archive's quiesced indexd.pgdump")
    names = sorted(str(p.relative_to(inp)) for p in inp.rglob("*"))
    need(names == sorted(["live-dump-receipt.json", "retirement-extraction-receipt.json", live_name, "retirement-snapshot"]
                         + [f"retirement-snapshot/{n}" for n in PERSIST]), "input dir holds other entries (e.g. indexd.yml)")
    need(all(_mode(inp / n) == 0o600 for n in names if (inp / n).is_file()) and _mode(inp / "retirement-snapshot") == 0o700,
         "input files are not 0600 (or the snapshot dir not 0700)")
    if hash_inputs:
        for n in PERSIST:
            need(sha(inp / "retirement-snapshot" / n) == po.get(n), f"input {n} bytes differ from the receipt")
        need(sha(inp / live_name) == lr.get("sha256"), "live dump bytes differ from its receipt")
    facts = {"runId": run_id, "freshQuiescedCoupledBackup": not bad, "capturedAt": snap.get("capturedAt"), "stoppedSeconds": snap.get("stoppedSeconds"),
             "sourceResumed": snap.get("sourceResumed"), "dbVersion": snap.get("dbVersion"), "counts": snap.get("counts"),
             "archive": {"file": b.get("file"), "sha256": b.get("sha256"), "location": b.get("location")},
             "receiptSha256": {"backup": bh, "integrity": ih, "extraction": sha(rrp), "liveDump": sha(lrp)},
             "inputSha256": {**po, live_name: lr.get("sha256")}, "liveDumpIsSnapshotDump": lr.get("sha256") == po.get("indexd.pgdump"),
             "configSecretsExtracted": False, "oldCapturesUsed": False}
    return facts, bad


def manifest(base_got, fresh_facts):
    return hashlib.sha256(json.dumps({"base": base_got, "fresh": fresh_facts.get("receiptSha256"), "inputs": fresh_facts.get("inputSha256"),
                                      "archive": fresh_facts.get("archive", {}).get("sha256"), "wrapper": sha(Path(__file__))},
                                     sort_keys=True).encode()).hexdigest()


def main(argv):
    mod = rebind(load_base(), FRESH["inputDir"])
    if argv[:1] == ["--recover"] and len(argv) == 2:
        return mod.main(argv)                                  # the module's own identity-checked recovery, on our RUNS
    facts, bad = validate_fresh(FRESH["inputDir"], FRESH["backupReceipt"], FRESH["integrity"], FRESH["archiveDir"])
    sp = socket_path_problem(RUNS, BASE.read_text())
    if sp:
        bad.append(sp)
    facts["pgSocketPathMaxBytes"] = len(str(RUNS)) + 1 + RUN_ID_HEX + len(SOCK_SUFFIX)
    got, base_bad = mod.pins()
    m = manifest(got, facts)
    if argv in ([], ["--plan"]):
        print(json.dumps({"mode": "plan (no side effects)", "manifest": m, "baseManifest": mod.manifest(got), "freshInput": facts,
                          "freshProblems": bad, "basePins": got, "baseProblems": base_bad, "runsDir": str(RUNS),
                          "execute": f"--execute {m}"}, indent=1))
        return 0 if not (bad or base_bad) else 2
    if argv != ["--execute", m]:
        print(json.dumps({"ok": False, "error": "usage: --plan | --execute <manifest> | --recover <run id>", "manifest": m}))
        return 2
    if bad:
        print(json.dumps({"ok": False, "error": "fresh input not validated", "problems": bad}))
        return 2
    mod.results["inputProvenance"] = {**facts, "wrapper": sha(Path(__file__)), "manifest": m,
                                      "note": "setup()'s literal freshQuiescedCutoverBackup:false is the unchanged base return value; "
                                              "this block is the validated provenance of this run's inputs"}
    return mod.main(["--execute", mod.manifest(got)])         # every remaining refusal (pins, isolation, queue scope) is the module's


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
