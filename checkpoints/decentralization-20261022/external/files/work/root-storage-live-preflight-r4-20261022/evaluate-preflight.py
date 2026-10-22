#!/usr/bin/env python3
"""r3 offline evaluator (r2 2be8a972 plus the production config access model) for vm-preflight.sh r3 output.
r2 captures are parsed too, but they lack the access-model facts, so they are UNKNOWN at best.

r3 change: indexd.yml is NOT required to have zero group bits. Production deliberately runs it as 0640
root:enclave-indexd (work/storage-vm/stage-production.py), so the unprivileged unit (User=/Group=enclave-indexd) can
read it and cannot write it. The evaluator requires exactly that model, the same one the r3 controller's explicit
config_file_access profile entry enforces:
  - a regular file with 1 link; mode 640; owner root (uid 0); group enclave-indexd, its gid equal to the group's gid (not 0);
  - the group has no supplementary members, and only the user enclave-indexd has it as primary group;
  - the unit runs User=enclave-indexd, Group=enclave-indexd, with no SupplementaryGroups;
  - /etc/enclave-indexd is root-owned and not group/other writable.
Any deviation -> BLOCKED; missing or failed reads -> UNKNOWN. Blind chmod 0600 would break the service, and a
service-owned file would give it write access it does not have today; both are BLOCKED.

r2 docstring follows.
r2 offline evaluator for vm-preflight.sh r2 output. It repairs root review R2 of r1 152fe44c, which accepted
unreadable or non-numeric sizes, counts and memory as READY.

Expected values come ONLY from root's capture receipts, the production-copy rehearsals and the controller's own
preconditions (unchanged from r1, never invented):
  - binary 2d7a637e (v0.6.0-enclave2; outputs/storage-retirement-snapshot.json);
  - db_version 26 and schema sha 27d75078 (indexd production and C2 rehearsals: snapshot AND 2026-10-20 live dump);
  - postgres@sha256:74935e72 (outputs/indexd-recovery-runbook.txt) and GeoLite 18bf1695;
  - replicactl.py ce63951e preconditions: secret modes and C2 durability;
  - the backup sizing 4 x (state + db) + 1 GiB.

Fail-closed rules:
  - The input must be a complete r2 capture:
    - header first and preflight.complete=yes last;
    - every line KEY=VALUE with a strict key;
    - printable ASCII, no blank or duplicate keys.
    A parse error -> UNKNOWN. A duplicated key's values are both discarded.
  - Every required fact needs KEY.status=ok. A failed, timed-out, skipped or missing read -> UNKNOWN.
  - Numeric facts must be canonical ASCII decimal integers (no sign, space, exponent, NaN, inf, hex, leading zero
    or non-ASCII digit) and at most 2**63-1. They must also be coherent:
    - free <= total disk; available <= total memory;
    - consensus.db <= du(state); db size > 0; counts <= cap + 1; HTTP status 100-599.
    Anything else -> UNKNOWN.
  - The session must prove its own bounds (read-only on, 5s statement and 1s lock timeout), else UNKNOWN.
  - A definite mismatch with a rehearsed pin or a controller precondition -> BLOCKED.
  - Table counts are drift evidence, never data-loss proof:
    - deletes, slab/contract pruning and renewals legitimately change them;
    - a decrease -> REVIEW_REQUIRED: root compares with the 2026-10-20 baseline, and the fresh quiesced backup
      re-baselines;
    - an increase or capped count -> note.

Verdict: READY_FOR_FRESH_BACKUP (0) | BLOCKED (1) | REVIEW_REQUIRED (2) | UNKNOWN (3).
  - READY only means the facts match what was rehearsed; it authorizes nothing.
  - Parse errors override everything; else BLOCKED > UNKNOWN > REVIEW_REQUIRED > READY.
    evaluate-preflight.py <preflight.out>
    evaluate-preflight.py --digest <digest.out>"""
import json, re, sys

EXPECT = {"binary.path_sha256": "2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc",
          "db.version": "26", "db.schema_sha256": "27d75078b4891d1ece0c76c7b6fd4c198dcabcde84e7a6a20bc969582dcb67d0",
          "pg.container_config_image": "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336",
          "geoip_sha256": "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933",
          "unit.execstart": "path=/opt/enclave-indexd/indexd", "unit.active": "active", "allow_live_start": "present",
          "db.fence_columns": "0", "db.invalid_constraints": "0", "db.invalid_indexes": "0", "db.tables": "33",
          "app.fence_status": "404", "pg.fsync": "on", "pg.running": "true"}
SVC = "enclave-indexd"
ACCESS = ["config.ids", "config.type", "config.nlink", "config.dir_stat", "unit.user", "unit.group", "unit.supplementary_groups",
          "group.service", "group.primary_users"]
INFO = ["unit.started", "unit.fragment_sha256", "pg.unit.fragment_sha256", "disk.opt_free_bytes", "swap.total_kib", "pg.container_image"]
SESSION = {"pg.session.default_transaction_read_only": "on", "pg.session.statement_timeout": "5s", "pg.session.lock_timeout": "1s"}
REHEARSED_COUNTS = {"objects": 1491, "slabs": 559, "contracts": 71, "accounts": 1}    # the 2026-10-20 live dump (L0)
INTS = ["disk.var_lib_free_bytes", "disk.var_lib_total_bytes", "state.du_bytes", "db.size_bytes", "mem.available_mib",
        "mem.total_mib", "db.version", "db.tables", "db.invalid_constraints", "db.invalid_indexes",
        "db.fence_columns", "app.fence_status"] + [f"db.count.{t}" for t in REHEARSED_COUNTS]
SHAS = ["binary.path_sha256", "db.schema_sha256", "geoip_sha256"]
NEED = sorted(set(EXPECT) | set(SESSION) | set(INTS) | {
    "pg.synchronous_commit", "config.stat", "state.consensus_bytes", "binary.is_symlink", "releases_dir", "unit.dropins_dir",
    "unit.dropins", "pg.server_version", "pg.inner_timeout"} | set(ACCESS))
EMPTY_OK = {"unit.dropins", "unit.supplementary_groups", "group.primary_users"}
PLAIN = {"preflight.version", "preflight.started", "preflight.budget_s", "preflight.sql_statement_timeout_ms",
         "preflight.sql_lock_timeout_ms", "preflight.elapsed_s", "preflight.complete", "preflight.error", "db.count_cap"}
KEY = re.compile(r"[a-z][a-z0-9_]*(\.[a-z0-9_]+)*", re.ASCII)
INT = re.compile(r"0|[1-9][0-9]{0,18}", re.ASCII)
MAX_INT = (1 << 63) - 1

def parse(text):
    """-> (kv, errors). Strict: any deviation is an error; duplicated keys are dropped entirely."""
    kv, errors, dups = {}, [], set()
    if isinstance(text, bytes):
        try: text = text.decode("ascii")
        except UnicodeDecodeError: return {}, ["input is not ASCII"]
    lines = text.split("\n")
    if lines and lines[-1] == "": lines.pop()
    for i, line in enumerate(lines, 1):
        if not line: errors.append(f"line {i}: blank line"); continue
        if not all(" " <= c <= "~" for c in line): errors.append(f"line {i}: non-printable or non-ASCII character"); continue
        if "=" not in line: errors.append(f"line {i}: not KEY=VALUE"); continue
        k, v = line.split("=", 1)
        if not KEY.fullmatch(k): errors.append(f"line {i}: malformed key {k[:40]!r}"); continue
        if v != v.strip(): errors.append(f"line {i}: {k} value has leading/trailing whitespace"); continue
        if k in kv or k in dups: errors.append(f"line {i}: duplicate key {k}"); dups.add(k); kv.pop(k, None); continue
        kv[k] = v
    if not lines or lines[0] not in ("preflight.version=r2", "preflight.version=r3"): errors.append("first line is not preflight.version=r3 (or r2): not a bounded capture")
    if not lines or lines[-1] != "preflight.complete=yes": errors.append("last line is not preflight.complete=yes (capture truncated or aborted)")
    if "preflight.error" in kv: errors.append(f"preflight.error={kv['preflight.error']}")
    return kv, errors

def as_int(v):
    return int(v) if v is not None and INT.fullmatch(v) and int(v) <= MAX_INT else None

def access_model(ok, m, blockers, unknown):
    """the production model 0640 root:enclave-indexd read by the unit's own restricted group (see module docstring)"""
    mode, owner, group = m.group(1), m.group(2), m.group(3)
    want = f"640 root:{SVC}"
    if (mode, owner, group) != ("640", "root", SVC):
        hint = (" (blind chmod 0600 root would stop the unit reading it)" if mode in ("600", "400") and owner == "root" else
                " (a service-owned config gives the unit write access it does not have today)" if owner == SVC else "")
        blockers.append(f"indexd.yml is {mode} {owner}:{group}; the production access model is {want}{hint}")
    missing = [k for k in ACCESS if k not in ok]
    if missing: unknown.append(f"access-model facts missing or failed: {missing} (an r2 capture has none: re-run the r3 preflight)"); return
    g = re.fullmatch(r"gid=(0|[1-9][0-9]*) members=([a-z_][a-z0-9_.-]*(?:,[a-z_][a-z0-9_.-]*)*)?", ok["group.service"], re.ASCII)
    ids = re.fullmatch(r"(0|[1-9][0-9]*):(0|[1-9][0-9]*)", ok["config.ids"], re.ASCII)
    d = re.fullmatch(r"([0-7]{3,4}) (0|[1-9][0-9]*)", ok["config.dir_stat"], re.ASCII)
    if not (g and ids and d): unknown.append(f"access-model facts unparseable: group.service={ok['group.service'][:60]!r} config.ids={ok['config.ids'][:30]!r} config.dir_stat={ok['config.dir_stat'][:30]!r}"); return
    gid, members = g.group(1), g.group(2) or ""
    checks = [
        (ok["config.type"] == "regular file", f"indexd.yml type {ok['config.type']!r}: must be a regular file (no symlink)"),
        (ok["config.nlink"] == "1", f"indexd.yml has {ok['config.nlink']!r} hard links: must be 1"),
        (ids.group(1) == "0", f"indexd.yml owner uid {ids.group(1)}: must be 0 (root)"),
        (ids.group(2) == gid, f"indexd.yml gid {ids.group(2)} != group {SVC} gid {gid}"),
        (gid != "0", f"group {SVC} is gid 0"),
        (members == "", f"group {SVC} has supplementary members {members!r}: the group must be the unit's alone"),
        (ok["group.primary_users"] == SVC, f"users with primary group {SVC}: {ok['group.primary_users']!r}, must be exactly {SVC!r}"),
        (ok["unit.user"] == SVC and ok["unit.group"] == SVC, f"unit runs User={ok['unit.user']!r} Group={ok['unit.group']!r}: must be {SVC}/{SVC}"),
        (ok["unit.supplementary_groups"] == "", f"unit SupplementaryGroups={ok['unit.supplementary_groups']!r}: must be empty"),
        (d.group(2) == "0" and not int(d.group(1), 8) & 0o022, f"/etc/enclave-indexd mode {d.group(1)} owner uid {d.group(2)}: must be root-owned, not group/other writable")]
    blockers.extend(msg for good, msg in checks if not good)


def evaluate(kv, errors=()):
    errors, blockers, unknown, review, notes = list(errors), [], [], [], []
    ok = {}
    for k in NEED:
        st = kv.get(f"{k}.status")
        if k not in kv or st is None: unknown.append(f"{k}: not reported")
        elif st != "ok": unknown.append(f"{k}: read failed ({st}{'; ' + kv[k + '.err'] if k + '.err' in kv else ''})")
        elif kv[k] == "" and k not in EMPTY_OK: unknown.append(f"{k}: status ok but value empty")
        else: ok[k] = kv[k]
    n = {}
    for k in INTS:
        if k in ok:
            n[k] = as_int(ok[k])
            if n[k] is None: unknown.append(f"{k} = {ok[k][:40]!r}: not a canonical non-negative integer"); del ok[k]
    cap = as_int(kv.get("db.count_cap"))
    if cap is None or cap == 0: unknown.append("db.count_cap missing or invalid: capped counts cannot be interpreted")
    for k in SHAS:
        if k in ok and ok[k] != "absent" and not re.fullmatch(r"[0-9a-f]{64}", ok[k]): unknown.append(f"{k} = {ok[k][:70]!r}: not a sha256"); del ok[k]
    # coherence
    def bad(msg, *keys):
        unknown.append("incoherent: " + msg)
        for k in keys: ok.pop(k, None); n.pop(k, None)
    g = n.get
    if g("disk.var_lib_total_bytes") == 0: bad("disk total 0", "disk.var_lib_total_bytes", "disk.var_lib_free_bytes")
    elif None not in (g("disk.var_lib_free_bytes"), g("disk.var_lib_total_bytes")) and g("disk.var_lib_free_bytes") > g("disk.var_lib_total_bytes"):
        bad("disk free > disk total", "disk.var_lib_free_bytes", "disk.var_lib_total_bytes")
    if g("mem.total_mib") == 0: bad("memory total 0", "mem.total_mib", "mem.available_mib")
    elif None not in (g("mem.available_mib"), g("mem.total_mib")) and g("mem.available_mib") > g("mem.total_mib"):
        bad("MemAvailable > MemTotal", "mem.available_mib", "mem.total_mib")
    if g("db.size_bytes") == 0: bad("pg_database_size 0 for a database with a schema", "db.size_bytes")
    if g("state.du_bytes") == 0: bad("state directory size 0", "state.du_bytes")
    cb = ok.get("state.consensus_bytes")
    if cb is not None and cb != "absent":
        c = as_int(cb)
        if c is None: bad(f"state.consensus_bytes {cb[:40]!r} not an integer", "state.consensus_bytes")
        elif g("state.du_bytes") is not None and c > g("state.du_bytes"): bad("consensus.db larger than du(state)", "state.consensus_bytes", "state.du_bytes")
    if g("app.fence_status") is not None and not 100 <= g("app.fence_status") <= 599: bad("HTTP status outside 100-599", "app.fence_status")
    for t in REHEARSED_COUNTS:
        k = f"db.count.{t}"
        if cap and g(k) is not None and g(k) > cap + 1: bad(f"{k} {g(k)} exceeds cap+1 {cap + 1}", k)
    # session bounds actually applied by PostgreSQL (PGOPTIONS reached the server)
    for k, v in SESSION.items():
        if k in ok and ok[k] != v: unknown.append(f"{k} = {ok[k]!r}, required {v!r}: session bounds not proven")
    # definite mismatches with rehearsed pins / controller preconditions
    for k, v in EXPECT.items():
        if k in ok and ok[k] != v: blockers.append(f"{k} = {ok[k]!r}, rehearsed/required {v!r}")
    sc = ok.get("pg.synchronous_commit")
    if sc is not None and sc not in ("on", "local", "remote_apply"): blockers.append(f"pg.synchronous_commit = {sc!r}: upgrade-c2 refuses; needs on|local|remote_apply")
    if ok.get("state.consensus_bytes") == "absent": blockers.append("consensus.db absent: the coupled backup (database + consensus.db + binary + config) cannot be taken")
    cs = ok.get("config.stat")
    if cs is not None:
        m = re.fullmatch(r"([0-7]{3,4}) (\S+):(\S+) (0|[1-9][0-9]*)", cs, re.ASCII)
        if cs == "absent": blockers.append("indexd.yml absent")
        elif not m: unknown.append(f"config.stat {cs[:60]!r} unparseable")
        else:
            if m.group(4) == "0": blockers.append("indexd.yml is empty (0 bytes)")
            access_model(ok, m, blockers, unknown)
    for k in ("binary.is_symlink",):
        if k in ok and ok[k] not in ("yes", "no"): unknown.append(f"{k} = {ok[k]!r}")
    for k in ("releases_dir", "unit.dropins_dir"):
        if k in ok and ok[k] not in ("present", "absent"): unknown.append(f"{k} = {ok[k]!r}")
    if ok.get("binary.is_symlink") == "yes" or ok.get("releases_dir") == "present" or ok.get("unit.dropins"):
        notes.append("release layout / drop-ins already present: a previous upgrade attempt may exist; root inspects before any step")
    # backup capacity (MIGRATION-PLAN B2 + replicactl: 4 quiesced controller backups incl. consensus.db, + 1 GiB)
    if all(g(k) is not None for k in ("state.du_bytes", "db.size_bytes", "disk.var_lib_free_bytes")):
        need = 4 * (g("state.du_bytes") + g("db.size_bytes")) + (1 << 30)
        if g("disk.var_lib_free_bytes") < need: blockers.append(f"free {g('disk.var_lib_free_bytes')} B < {need} B (4 quiesced controller backups incl. consensus.db + 1 GiB)")
    else: unknown.append("backup capacity not decidable: state/db size or free disk not a valid reading")
    # count drift: review, never a data-loss claim
    for t, base in REHEARSED_COUNTS.items():
        c = g(f"db.count.{t}")
        if c is None: continue
        if cap and c > cap: notes.append(f"db.count.{t} >= {cap + 1} (capped read; exact count not taken by default)")
        elif c < base: review.append(f"db.count.{t} {c} < {base} in the 2026-10-20 live dump: deletes/pruning/renewal can legitimately lower it; this is drift, not proof of loss. Root reviews (or it is another database), and the fresh quiesced backup re-baselines")
        elif c > base: notes.append(f"db.count.{t} {c} > {base} (2026-10-20): newer data; the fresh quiesced backup re-baselines")
    known = set(NEED) | set(INFO) | PLAIN | {f"{k}.{x}" for k in set(NEED) | set(INFO) for x in ("status", "err")}
    extra = sorted(k for k in kv if k not in known and not k.rsplit(".", 1)[0] in known)
    if extra: notes.append(f"unexpected keys ignored: {extra[:10]}")
    if errors: verdict = "UNKNOWN"
    elif blockers: verdict = "BLOCKED"
    elif unknown: verdict = "UNKNOWN"
    elif review: verdict = "REVIEW_REQUIRED"
    else: verdict = "READY_FOR_FRESH_BACKUP"
    return {"verdict": verdict, "parseErrors": errors, "blockers": blockers, "unknown": unknown, "review": review, "notes": notes,
            "observed": {k: ok.get(k) for k in ("binary.path_sha256", "db.version", "pg.server_version", "pg.synchronous_commit", "config.stat", "mem.available_mib")}}

def evaluate_digest(text):
    """vm-digest-optin.sh output -> COMPLETE (0) | UNKNOWN (3). A baseline record, not a gate."""
    kv, errors = {}, []
    lines = text.split("\n")
    if lines and lines[-1] == "": lines.pop()
    for i, line in enumerate(lines, 1):
        k, sep, v = line.partition("=")
        if not sep or not KEY.fullmatch(k): errors.append(f"line {i}: malformed"); continue
        if k in kv: errors.append(f"line {i}: duplicate {k}")
        kv[k] = v
    rows = {k[7:]: v for k, v in kv.items() if k.startswith("digest.") and "|" in v}
    for t, v in rows.items():
        if not re.fullmatch(r"(0|[1-9][0-9]*)\|([0-9a-f]{32})?", v, re.ASCII): errors.append(f"digest.{t} malformed")
    if kv.get("digest.status") != "ok": errors.append(f"digest.status = {kv.get('digest.status')!r}")
    if not lines or lines[0] not in ("digest.version=r2", "digest.version=r3") or lines[-1] != "digest.complete=yes": errors.append("not a complete r3 (or r2) digest capture")
    if len(rows) != 13: errors.append(f"{len(rows)} digest lines, digest.sql 7f4b137f has 13 statements")
    return {"verdict": "UNKNOWN" if errors else "COMPLETE", "errors": errors, "tables": sorted(rows)}

def main(argv):
    digest = argv[:1] == ["--digest"]
    path = argv[1] if digest else (argv[0] if argv else None)
    try: data = open(path, "rb").read()
    except (OSError, TypeError) as e:
        print(json.dumps({"verdict": "UNKNOWN", "parseErrors": [f"cannot read input: {e}"]})); return 3
    if digest:
        try: r = evaluate_digest(data.decode("ascii"))
        except UnicodeDecodeError: r = {"verdict": "UNKNOWN", "errors": ["input is not ASCII"]}
        print(json.dumps(r, indent=1)); return 0 if r["verdict"] == "COMPLETE" else 3
    r = evaluate(*parse(data)); print(json.dumps(r, indent=1))
    return {"READY_FOR_FRESH_BACKUP": 0, "BLOCKED": 1, "REVIEW_REQUIRED": 2}.get(r["verdict"], 3)

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
