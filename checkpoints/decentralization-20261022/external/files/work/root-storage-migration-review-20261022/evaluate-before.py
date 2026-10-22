#!/usr/bin/env python3
"""Offline evaluator for vm-preflight.sh output (KEY=VALUE). Expected values come ONLY from root's capture receipts and
the production-copy rehearsals (never invented):
  binary 2d7a637e (v0.6.0-enclave2 = v0.6.0 ddaf24b + enclave-small.patch; outputs/storage-retirement-snapshot.json),
  db_version 26 and schema sha 27d75078 (work/indexd-prod-rehearsal + indexd-c2-production-rehearsal results, snapshot
  AND 2026-10-20 live dump), PostgreSQL image postgres@sha256:74935e72 (outputs/indexd-recovery-runbook.txt),
  GeoLite 18bf1695, and the controller's own preconditions (replicactl.py ce63951e: secret modes, geoip, C2 durability).
-> verdict READY_FOR_FRESH_BACKUP | BLOCKED (reasons) | UNKNOWN (missing evidence). READY only means the facts match what
was rehearsed; it authorizes nothing.
  evaluate-preflight.py <preflight.out>"""
import json, re, sys
EXPECT = {"binary.path_sha256": "2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc",
          "db.version": "26", "db.schema_sha256": "27d75078b4891d1ece0c76c7b6fd4c198dcabcde84e7a6a20bc969582dcb67d0",
          "pg.container_config_image": "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336",
          "geoip_sha256": "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933",
          "unit.execstart": "path=/opt/enclave-indexd/indexd", "unit.active": "active", "allow_live_start": "present",
          "db.fence_columns": "0", "db.invalid_constraints": "0", "db.invalid_indexes": "0", "db.tables": "33", "db.count.accounts": "1",
          "app.fence_status": "404", "pg.fsync": "on", "pg.running": "true"}
REHEARSED_COUNTS = {"objects": 1491, "slabs": 559, "contracts": 71}          # the 2026-10-20 live dump (L0)
NEED = list(EXPECT) + ["pg.synchronous_commit", "config.stat", "disk.var_lib_free_bytes", "state.du_bytes", "db.size_bytes", "binary.is_symlink",
                       "releases_dir", "unit.dropins", "db.count.objects", "db.count.slabs", "db.count.contracts", "pg.server_version", "mem.available_mib"]

def parse(text):
    kv = {}
    for line in text.splitlines():
        if "=" in line: k, v = line.split("=", 1); kv[k.strip()] = v.strip()
    return kv

def evaluate(kv):
    missing = [k for k in NEED if k not in kv or (kv[k] == "" and k != "unit.dropins")]       # no drop-ins is a legitimate empty value
    blockers, notes = [], []
    for k, v in EXPECT.items():
        if k in kv and kv[k] != "" and kv[k] != v: blockers.append(f"{k} = {kv[k]!r}, rehearsed/required {v!r}")
    sc = kv.get("pg.synchronous_commit")
    if sc and sc not in ("on", "local", "remote_apply"): blockers.append(f"pg.synchronous_commit = {sc!r}: C2 (upgrade-c2) refuses; needs on|local|remote_apply")
    m = re.match(r"^([0-7]{3,4}) (\S+):(\S+) (\d+)$", kv.get("config.stat", ""))
    if kv.get("config.stat") and not m: blockers.append(f"config.stat unreadable: {kv.get('config.stat')!r}")
    elif m and int(m.group(1), 8) & 0o077: blockers.append(f"indexd.yml mode {m.group(1)}: replicactl check_secret_modes refuses group/other bits (ROLLOUT.md section 5 says 0640): fix the mode/owner first")
    if kv.get("binary.is_symlink") == "yes" or kv.get("releases_dir") == "present" or kv.get("unit.dropins"):
        notes.append("release layout / drop-ins already present: a previous upgrade attempt may exist; root inspects before any step")
    try:
        need = 4 * (int(kv["state.du_bytes"]) + int(kv["db.size_bytes"])) + (1 << 30)
        if int(kv["disk.var_lib_free_bytes"]) < need: blockers.append(f"free {kv['disk.var_lib_free_bytes']} B < {need} B (4 quiesced controller backups incl. consensus.db + 1 GiB)")
    except (KeyError, ValueError): pass
    for t, n in REHEARSED_COUNTS.items():
        try:
            c = int(kv[f"db.count.{t}"])
            if c < n: blockers.append(f"db.count.{t} {c} < the rehearsed live dump's {n}: data may have been lost or this is another database")
            elif c > n: notes.append(f"db.count.{t} {c} > rehearsed {n}: newer data; the fresh quiesced backup re-baselines")
        except (KeyError, ValueError): pass
    if not kv.get("digest.objects"): notes.append("no digest lines (run with digest.sql on stdin to record the live baseline)")
    verdict = "BLOCKED" if blockers else "UNKNOWN" if missing else "READY_FOR_FRESH_BACKUP"
    return {"verdict": verdict, "blockers": blockers, "missing": missing, "notes": notes,
            "observed": {k: kv.get(k) for k in ("binary.path_sha256", "db.version", "pg.server_version", "pg.synchronous_commit", "config.stat", "mem.available_mib")}}

if __name__ == "__main__":
    r = evaluate(parse(open(sys.argv[1]).read())); print(json.dumps(r, indent=1)); sys.exit(0 if r["verdict"] == "READY_FOR_FRESH_BACKUP" else 3 if r["verdict"] == "UNKNOWN" else 1)
