#!/usr/bin/env python3
"""repeat-r2 runner. It is the pinned r1 runner (../sdk_regression_runner.py 8138486d, loaded read-only from its
verified bytes) with exactly FOUR overrides and nothing else:
  1. case-group.sh is this directory's r2 copy, pinned by config-r2.json caseGroupSha256 (the only change: HOSTS).
  2. Verdicts use parser-r2 libtest_r2.parse (pinned c8521b52), the strict serial libtest parser root accepted. The r1
     parser reports every --nocapture case as missing.
  3. Evidence also keeps the harness's own zap log (<group dir>/harness.log): a bounded tail of 8 MiB, redacted like
     driver.log, plus its full size and sha256. A future contract-formation failure is then diagnosable; r1 kept only
     the harness's stdout.
  4. Each group passes its configured HOSTS (12..20) to case-group.sh; preflight refuses any other value before docker.
Everything else is r1 and, through it, root's accepted contracts runner ed8e0fdd:
  - container ownership, isolation verification, IPv6 and driver checks;
  - stop-after-uncertain-end, cleanup and its confirmations, and exit codes.
  runner_r2.py --config config-r2.json --dry-run | --check | --run | --cleanup JOURNAL"""
import hashlib, importlib.util, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
R1 = HERE.parent / "sdk_regression_runner.py"; R1_SHA = "8138486dcb6eb2e13b229c3d296f618c082fa3f19485989fb6778ca0fa6e6b9e"
P2 = HERE.parent / "parser-r2" / "libtest_r2.py"; P2_SHA = "c8521b525cf3a93fba3b0a8be39b1c6cd6063cd56f8159a75143f3064e3b606e"
TAIL = 8 << 20


def load_pinned(path, want, name):
    data = path.read_bytes(); got = hashlib.sha256(data).hexdigest()
    if got != want: raise SystemExit(f'{{"refused": "{path} is {got[:16]}, not the pinned {want[:16]}"}}')
    spec = importlib.util.spec_from_loader(name, loader=None); m = importlib.util.module_from_spec(spec); m.__file__ = str(path)
    exec(compile(data, str(path), "exec"), m.__dict__)
    return m


def build():
    r1 = load_pinned(R1, R1_SHA, "sdk_regression_runner_r1_pinned")
    p2 = load_pinned(P2, P2_SHA, "libtest_r2_pinned")
    r1.HERE = HERE                                                    # override 1: this dir's case-group.sh

    def parse_libtest(text, cases):                                   # override 2: parser-r2
        r = p2.parse(text, cases)
        return r["ok"], {"cases": r["cases"], "resultLine": r["summary"], "unexpected": sorted(set(r["cases"]) - set(cases)),
                         "parserErrors": r["errors"], "parserWarnings": r["warnings"], "tally": r["tally"], "failed": r["failed"]}
    r1.parse_libtest = parse_libtest

    r1_copy = r1.copy_evidence
    def copy_evidence(scratch, gid, results):                         # override 3: + bounded harness zap log
        dst = r1_copy(scratch, gid, results)
        src = pathlib.Path(scratch) / "work" / "runs" / gid / "harness.log"
        if src.is_file() and not src.is_symlink():
            data = src.read_bytes(); tail = data[-TAIL:]
            (dst / "harness-zap.tail.log").write_text(r1.REDACT.sub(lambda m: m.group(1) + "=<redacted>", tail.decode(errors="replace")))
            (dst / "harness-zap.meta.json").write_text(f'{{"bytes": {len(data)}, "sha256": "{hashlib.sha256(data).hexdigest()}", "tailBytes": {len(tail)}}}\n')
        return dst
    r1.copy_evidence = copy_evidence

    r1_make = r1.make_runner_class
    def make_runner_class(B):                                         # override 4: per-group HOSTS
        Base = r1_make(B)
        class R2(Base):
            def preflight(self):                                      # same HOSTS rule, refused before any docker change
                for g in self.cfg["groups"]:
                    h = g.get("hosts")
                    if not isinstance(h, int) or isinstance(h, bool) or not 12 <= h <= 20: raise B.Refused(f"group {g['id']} hosts {h!r} not an integer 12..20")
                return super().preflight()

            def group_exec(self, g, envfile, run_id):
                argv = super().group_exec(g, envfile, run_id)
                h = g.get("hosts")
                if not isinstance(h, int) or not 12 <= h <= 20: raise B.Refused(f"group {g['id']} hosts {h!r} not an integer 12..20")
                i = argv.index(self.cid or "<container-id>")
                return argv[:i] + ["-e", f"HOSTS={h}"] + argv[i:]
        return R2
    r1.make_runner_class = make_runner_class
    return r1


if __name__ == "__main__":
    sys.exit(build().main())
