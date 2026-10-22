#!/usr/bin/env python3
"""storage-sdk-regressions: Phase A2 REAL SDK + REAL indexd interop for the accepted enclave snapshots.

The REAL harness (indexd compiled in from the accepted snapshot; built by build-harness.sh) and the REAL Rust SDK driver
(prebuilt sdk-c2-4-driver, reused by pinned provenance) run in ONE disposable container together with this run's own
PostgreSQL 18.6 (pinned image 74935e72, --pull never). The container has:
  - --network none, no published ports, and IPv6 loopback enabled (the harness hosts listen on [::1]);
  - the memory/CPU/pids caps from config.json, a read-only rootfs and no-new-privileges.
Container ownership, isolation verification, readiness and cleanup are root's accepted contracts runner, loaded
read-only from its pinned bytes (storage-contracts-pg/contracts_pg_runner.py ed8e0fdd): unchanged semantics.
  - Owned only by a fresh run label + exact name + image. The label lookup runs only after this run's own create.
  - Removal is `rm -f -v <full id>` and must then be confirmed: an explicit "no such" answer for the container and its
    recorded anonymous volumes. Only then is the scratch removed, by its mkdtemp identity (dev/inode/owner).
  - Anything unconfirmed preserves the state and the journal (exit 3). `--cleanup <journal>` resumes in a second process.
Added here (SDK specifics only): the mounts, the IPv6 loopback check, the driver's case list check, the case groups,
evidence copy-out with the old redaction, and libtest result parsing.
Group scheduling stops at the first UNCERTAIN `docker exec` end, and the remaining groups are NOT_RUN:
  - certain ends: 0 pass, 101 libtest failure, 3 harness not ready, 4 harness exited early, 124 inner timeout;
  - uncertain ends: an outer timeout, an OSError, a signal, or rc 125/126/127/137.
A group PASSES only if:
  - the driver rc is 0;
  - every configured case is reported `... ok` exactly once and `test result: ok. N passed; 0 failed` has N == the case
    count, so a filter matching nothing cannot pass;
  - the harness exited 0.
Exit: 0 all groups PASS + cleanup confirmed | 1 group failure(s)/NOT_RUN, cleanup confirmed | 2 refused before any
docker change | 3 cleanup unconfirmed (state preserved) | 4 error before the groups, cleanup confirmed.
  sdk_regression_runner.py --config config.json --dry-run | --check | --run | --cleanup JOURNAL"""
import argparse, hashlib, importlib.util, json, os, re, secrets, shutil, signal, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CERTAIN_GROUP_RC = {0, 101, 3, 4, 124}
REDACT = re.compile(r"(sc|ss|sf)=[A-Za-z0-9%_=-]+")
TEST_LINE = re.compile(r"^test (\S+) \.\.\. (ok|FAILED|ignored)\s*$", re.M)
RESULT_LINE = re.compile(r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed;", re.M)


def load_base(cfg):
    """root's accepted contracts runner, executed from the exact bytes whose hash was verified"""
    p = Path(cfg["baseRunner"]["path"]); data = p.read_bytes()
    if hashlib.sha256(data).hexdigest() != cfg["baseRunner"]["sha256"]:
        raise SystemExit(json.dumps({"refused": f"base runner {p} is not the accepted {cfg['baseRunner']['sha256'][:16]}"}))
    spec = importlib.util.spec_from_loader("contracts_pg_runner_pinned", loader=None); m = importlib.util.module_from_spec(spec)
    m.__file__ = str(p)
    exec(compile(data, str(p), "exec"), m.__dict__)
    return m


def parse_libtest(text, cases):
    seen = {}
    for name, res in TEST_LINE.findall(text): seen.setdefault(name, []).append(res)
    results = [(r, int(p), int(f)) for r, p, f in RESULT_LINE.findall(text)]
    per = {c: (seen.get(c) or ["missing"]) for c in cases}
    ok = all(v == ["ok"] for v in per.values()) and len(results) == 1 and results[0] == ("ok", len(cases), 0) and set(seen) <= set(cases)
    return ok, {"cases": per, "resultLine": results, "unexpected": sorted(set(seen) - set(cases))}


def make_runner_class(B):
    class SdkRunner(B.Runner):
        def plan(self, run_id, scratch, envfile):
            c, lim = self.cfg, self.cfg["limits"]
            name = f"{c['namePrefix']}-{run_id}"
            mounts = [f"type=bind,src={h['path']},dst=/harness/harness-{k},readonly" for k, h in sorted(c["harnesses"].items())]
            mounts += [f"type=bind,src={c['driver']['path']},dst=/driver/sdk-driver,readonly",
                       f"type=bind,src={c['geoip']['path']},dst=/geoip/GeoLite2-City.mmdb,readonly",
                       f"type=bind,src={HERE / 'case-group.sh'},dst=/tools/case-group.sh,readonly",
                       f"type=bind,src={scratch}/work,dst=/scratch"]
            argv = ["run", "-d", "--pull", "never", "--name", name, "--label", f"{B.LABEL_KIND}=storage-sdk-regressions", "--label", f"{B.LABEL_RUN}={run_id}",
                    "--network", "none", "--sysctl", "net.ipv6.conf.all.disable_ipv6=0", "--sysctl", "net.ipv6.conf.lo.disable_ipv6=0",
                    "--memory", lim["memory"], "--memory-swap", lim["memory"], "--cpus", str(lim["cpus"]), "--cpuset-cpus", lim["cpuset"],
                    "--pids-limit", str(lim["pids"]), "--read-only", "--tmpfs", "/var/run/postgresql:rw,size=16m", "--tmpfs", "/tmp:rw,size=64m",
                    "--security-opt", "no-new-privileges", "--env-file", str(envfile)]
            for m in mounts: argv += ["--mount", m]
            return name, argv + [c["imageId"], "postgres"]

        def group_exec(self, g, envfile, run_id):
            c = self.cfg; t = c["timeouts"]
            env = {"GROUP": g["id"], "RUNID": f"{g['id']}{run_id[-6:]}", "MODE": g["mode"], "HARNESS": f"/harness/harness-{g['harness']}",
                   "CASES": " ".join(g["cases"]), "READY_SECONDS": str(t["harnessReady"]), "HARNESS_GOMEMLIMIT": c["limits"]["harnessGoMemLimit"],
                   "HOME": "/scratch", "TMPDIR": "/scratch/tmp", "PATH": "/usr/local/bin:/usr/bin:/bin"}
            argv = ["exec", "--user", f"{self.uid}:{self.gid}", "--workdir", "/scratch", "--env-file", str(envfile)]
            for k, v in env.items(): argv += ["-e", f"{k}={v}"]
            return argv + [self.cid or "<container-id>", "timeout", "-k", "10", str(t["groupInner"]), "bash", "/tools/case-group.sh"]

        def preflight(self):
            c = self.cfg; S = B.sha256_file; res = {}
            for k, h in c["harnesses"].items():
                if not re.fullmatch(r"[0-9a-f]{64}", h["sha256"]): raise B.Refused(f"harness {k} is not built/pinned yet ({h['sha256']}): root schedules build-harness.sh first")
                if not os.path.isfile(h["path"]) or S(h["path"]) != h["sha256"]: raise B.Refused(f"harness {k} {h['path']} differs from its pin")
            d = c["driver"]
            if S(d["path"]) != d["sha256"]: raise B.Refused("SDK driver differs from its pin")
            if S(d["snapshotManifest"]) != d["snapshotManifestSha256"]: raise B.Refused("SDK snapshot manifest differs from its pin")
            if S(d["buildLog"]) != d["buildLogSha256"] or d["sha256"] not in Path(d["buildLog"]).read_text(): raise B.Refused("driver build log does not record this driver")
            if S(c["geoip"]["path"]) != c["geoip"]["sha256"]: raise B.Refused("GeoLite file differs from its pin")
            if S(HERE / "case-group.sh") != c["caseGroupSha256"]: raise B.Refused("case-group.sh differs from its pin")
            for s in c["snapshots"]:
                got, want = B.tree_inventory(s["snapshot"]), B.expected_inventory(s)
                if got != want: raise B.Refused(f"snapshot {s['name']} differs from the accepted inventory")
                res[s["name"]] = len(got)
            r = self.dk(["image", "inspect", "--format", "{{.Id}}", c["imageId"]], check=False)
            if r.returncode != 0 or r.stdout.strip() != c["imageId"]: raise B.Refused(f"pinned image {c['imageId']} not present locally (no pull)")
            return res

        def in_container_checks(self):
            r = self.dk(["exec", self.cid, "cat", "/proc/net/if_inet6"], check=False)
            if r.returncode != 0 or not re.search(r"^0{31}1 \S+ \S+ \S+ \S+\s+lo$", r.stdout, re.M):
                raise B.RunError("IPv6 loopback (::1 on lo) missing in the container: the harness hosts cannot listen on [::1]")
            r = self.dk(["exec", "--user", f"{self.uid}:{self.gid}", "-e", "HOME=/scratch", self.cid, "/driver/sdk-driver", "--list", "--ignored"], timeout=60, check=False)
            listed = {l.rsplit(": ", 1)[0] for l in r.stdout.splitlines() if l.endswith(": test")}
            want = {x for g in self.cfg["groups"] for x in g["cases"]}
            if r.returncode != 0 or not want <= listed:
                raise B.RunError(f"SDK driver not runnable in the container or lacks cases: rc={r.returncode} missing={sorted(want - listed)[:5]} {r.stderr.strip()[-200:]}")
            self.jset(driverCasesListed=len(listed))
    return SdkRunner


def copy_evidence(scratch, gid, results):
    src = Path(scratch) / "work" / "runs"; dst = results / gid; dst.mkdir()
    for p in [src / gid / n for n in ("driver.log", "events.jsonl", "evidence.json", "resources.txt")] + [src / f"{gid}.harness.log"]:
        if p.is_file() and not p.is_symlink():
            (dst / p.name).write_text(REDACT.sub(lambda m: m.group(1) + "=<redacted>", p.read_text(errors="replace")))
    return dst


def run(cfg, base):
    B = load_base(cfg); R = make_runner_class(B)
    run_id = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-" + secrets.token_hex(6)
    runs = base / "runs"; runs.mkdir(exist_ok=True); results = runs / f"{run_id}-results"; results.mkdir()
    r = R(cfg, runs / f"{run_id}.journal.json"); name = f"{cfg['namePrefix']}-{run_id}"
    r.jset(runId=run_id, name=name, stage="preflight", startedAt=B.now(), pid=os.getpid(), resultsDir=str(results))
    summary = {"runId": run_id, "groups": {}, "cleanup": None}; scratch_id = None; code = 0

    def on_signal(signum, frame): raise B.RunError(f"interrupted by signal {signum}")
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, on_signal)
    try:
        summary["preflight"] = r.preflight()
        scratch_id = B.make_scratch(runs); r.jset(stage="scratch-created", scratch=scratch_id)
        for sub in ("work", "work/tmp", "work/runs", "secrets"): os.mkdir(os.path.join(scratch_id["path"], sub), 0o700)
        envfile = Path(scratch_id["path"]) / "secrets" / "pg.env"
        fd = os.open(envfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"POSTGRES_USER=pgt_{secrets.token_hex(4)}\nPOSTGRES_PASSWORD={secrets.token_urlsafe(32)}\nPOSTGRES_DB=pgt_{run_id[-12:]}\n")
        _, argv = r.plan(run_id, scratch_id["path"], envfile)
        clash = r.dk(["ps", "-a", "--no-trunc", "--filter", f"name=^/{name}$", "--format", "{{.ID}}"]).stdout.strip() + \
                r.dk(["ps", "-a", "--no-trunc", "--filter", f"label={B.LABEL_RUN}={run_id}", "--format", "{{.ID}}"]).stdout.strip()
        if clash: raise B.Refused(f"name/run label already in use by {clash}: not touching it")
        r.create_attempted = True; r.jset(stage="create-intent", createAttempted=True)
        try:
            cr = r.dk(argv, timeout=cfg["timeouts"]["create"], check=False)
            cid = cr.stdout.strip().splitlines()[-1] if cr.returncode == 0 and cr.stdout.strip() else ""
            if re.fullmatch(r"[0-9a-f]{64}", cid): r.cid = cid
            else: r.jset(createResponse=f"rc={cr.returncode} {cr.stderr.strip()[-200:]}")
        except B.RunError as e:
            r.jset(createResponse=str(e))
        if r.cid is None:
            r.cid = r.owned_by_label(run_id, name); r.jset(containerAdoptedByRunLabel=r.cid)
            if r.cid is None: raise B.RunError("container was not created")
        r.verify_container(run_id, name)
        r.wait_ready(); r.jset(stage="ready")
        r.in_container_checks(); r.jset(stage="checks-ok")
        stop = None
        for g in cfg["groups"]:
            if stop:
                summary["groups"][g["id"]] = {"verdict": "NOT_RUN", "reason": stop}; code = 1; continue
            r.jset(stage=f"group-{g['id']}"); t0 = time.monotonic()
            with open(results / f"{g['id']}.out", "w") as fo:
                try:
                    p = subprocess.run([r.docker] + r.group_exec(g, envfile, run_id), stdout=fo, stderr=subprocess.STDOUT, timeout=cfg["timeouts"]["groupOuter"]); rc = p.returncode
                except subprocess.TimeoutExpired: rc = "outer-timeout"
                except OSError as e: rc = f"exec-error: {e}"
            if rc not in CERTAIN_GROUP_RC:
                stop = f"previous group {g['id']} ended uncertainly ({rc}): processes may still exist in the container; going straight to container removal"
            ev = copy_evidence(scratch_id["path"], g["id"], results)
            text = (ev / "driver.log").read_text() if (ev / "driver.log").exists() else ""
            ok, detail = parse_libtest(text, g["cases"])
            out = (results / f"{g['id']}.out").read_text(errors="replace")
            hm = re.search(r"GROUP-RESULT driver=(\d+) harness=(\d+)", out)
            harness_ok = bool(hm) and hm.group(2) == "0"
            verdict = "PASS" if rc == 0 and ok and harness_ok else "FAIL"
            summary["groups"][g["id"]] = {"harness": g["harness"], "mode": g["mode"], "groupReturnCode": rc, "harnessExit": hm.group(2) if hm else None,
                                          "verdict": verdict, "seconds": round(time.monotonic() - t0), **detail}
            r.jset(**{f"group_{g['id']}": summary["groups"][g["id"]]})
            if verdict != "PASS": code = 1
    except B.Refused as e:
        summary["refused"] = str(e); code = 2; r.jset(refused=str(e))
    except B.RunError as e:
        summary["error"] = str(e); code = 4 if not summary["groups"] else 1
    finally:
        for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s, signal.SIG_IGN)
        ok, d = r.cleanup(run_id, name, scratch_id)
        summary["cleanup"] = {"confirmed": ok, **d}
        if not ok: code = 3
        (results / "summary.json").write_text(json.dumps(summary, indent=1) + "\n"); print(json.dumps(summary, indent=1))
    return code


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--config", required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true"); g.add_argument("--check", action="store_true"); g.add_argument("--run", action="store_true"); g.add_argument("--cleanup", metavar="JOURNAL")
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text()); base = Path(a.config).resolve().parent
    B = load_base(cfg); R = make_runner_class(B)
    if a.dry_run:
        r = R(cfg); r.cid = "<container-id>"; _, argv = r.plan("<run-id>", "<scratch>", "<scratch>/secrets/pg.env")
        print(json.dumps({"create": [cfg["docker"]] + argv, "groups": {x["id"]: [cfg["docker"]] + r.group_exec(x, "<scratch>/secrets/pg.env", "000000000000") for x in cfg["groups"]}}, indent=1)); return 0
    if a.check:
        try: print(json.dumps({"preflight": R(cfg).preflight()}, indent=1)); return 0
        except (B.Refused, B.RunError) as e: print(json.dumps({"refused": str(e)})); return 2
    if a.cleanup:
        B.Runner = R                                 # same accepted cleanup; journal format is the base runner's
        return B.cleanup_from_journal(cfg, a.cleanup)
    return run(cfg, base)


if __name__ == "__main__":
    sys.exit(main())
