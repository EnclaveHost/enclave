#!/usr/bin/env python3
"""hook-selftest.py -- the pre-push hook, run for real, judges a push by the PUSHED commit's .gitleaks.toml.

The layout is the one this machine uses: core.hooksPath is an ABSOLUTE path into the main checkout's .githooks, and pushes
come from linked worktrees on other branches. A throwaway repository (with its own bare remote) gets this repository's
hook, pre-commit and crypto scanner; the main checkout's config and a branch's config each carry their own canary rule,
so which config judged a push is visible in the push's result, not inferred:
  1. a linked worktree pushes its branch canary              -> REFUSED (the pushed commit's config governs)
  2. the same worktree pushes only the MAIN canary            -> allowed (the main checkout's config does not govern it)
  3. a pushed config that gitleaks cannot load + MAIN canary -> REFUSED (scanned again with the hook's own config)
  4. a generated, labelled private key under a config with no key rules -> REFUSED (the crypto scanner always runs)
  5. the main checkout pushes its own canary                 -> REFUSED (its own config governs)
Every push runs with TMPDIR pointed at a directory of its own, which must be EMPTY afterwards: the hook's temporary copies of
the pushed config and its logs are all removed (they once leaked, made inside a subshell the cleanup never saw).
Then the hooks are run directly, each copied ALONE into a fresh repository (the review's reproduction, 2026-09-25):
  6. no crypto-key scanner anywhere: pre-commit and pre-push REFUSE (a missing scanner once skipped every check, exit 0);
     a delete-only push, with nothing to scan, still passes
  7. the scanner only beside the hook, or only in the worktree's .githooks: a clean commit and push pass
The canaries and the key are generated for this run and live only in the throwaway repositories, deleted on exit.

  python3 .githooks/hook-selftest.py [--gitleaks PATH]
Exit status: 0 every case as expected; 1 a case was not; 2 gitleaks or git could not be used.
"""
import os, secrets, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK_FILES = ["pre-push", "pre-commit", "scan-crypto-keys.py", "bip39-english.txt", "known-addresses.txt"]


def find_gitleaks():
    a = sys.argv[1:]
    given = a[a.index("--gitleaks") + 1] if "--gitleaks" in a and a.index("--gitleaks") + 1 < len(a) else None
    for c in (given, os.environ.get("GITLEAKS"), shutil.which("gitleaks"), os.path.expanduser("~/.local/bin/gitleaks")):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def canary_config(rule_id, prefix):
    return f"""title = "{rule_id}"
[[rules]]
id = "{rule_id}"
description = "hook-selftest canary"
regex = '''{prefix}-[0-9a-f]{{16}}'''
"""


def main():
    gl = find_gitleaks()
    if not gl:
        print("hook-selftest: gitleaks not found (install it, or pass --gitleaks PATH)", file=sys.stderr)
        return 2
    tmp = tempfile.mkdtemp(prefix="hook-selftest-")
    gcfg = os.path.join(tmp, "gitconfig")
    open(gcfg, "w").close()
    hook_tmp = os.path.join(tmp, "hook-tmpdir")   # the hooks' TMPDIR: must be empty after every run
    os.makedirs(hook_tmp)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": gcfg, "GIT_CONFIG_NOSYSTEM": "1", "GITLEAKS": gl, "TMPDIR": hook_tmp,
           "GIT_AUTHOR_NAME": "hook-selftest", "GIT_AUTHOR_EMAIL": "hook-selftest@example.invalid",
           "GIT_COMMITTER_NAME": "hook-selftest", "GIT_COMMITTER_EMAIL": "hook-selftest@example.invalid"}

    def git(cwd, *args, check=True):
        p = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True)
        if check and p.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {p.stderr.strip()[-300:]}")
        return p

    def commit(cwd, files, msg):
        for name, text in files.items():
            path = os.path.join(cwd, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text)
        git(cwd, "add", "-A")
        # the pre-commit hook runs too; a case that plants a key commits with it disabled, so the PRE-PUSH is what is tested
        git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", msg)

    failures = []
    try:
        main_dir, remote, wt = os.path.join(tmp, "main"), os.path.join(tmp, "remote.git"), os.path.join(tmp, "wt")
        git(tmp, "init", "-q", "--bare", remote)
        git(tmp, "init", "-q", "-b", "main", main_dir)
        os.makedirs(os.path.join(main_dir, ".githooks"))
        for f in HOOK_FILES:
            shutil.copy2(os.path.join(HERE, f), os.path.join(main_dir, ".githooks", f))
        commit(main_dir, {".gitleaks.toml": canary_config("main-canary", "MAIN-CANARY"), "README": "hook-selftest\n"}, "main")
        git(main_dir, "remote", "add", "origin", remote)
        git(main_dir, "config", "core.hooksPath", os.path.join(main_dir, ".githooks"))   # ABSOLUTE, as on this machine
        first = git(main_dir, "push", "-q", "origin", "main", check=False)
        if first.returncode != 0:
            raise RuntimeError(f"the initial push was refused: {first.stderr.strip()[-400:]}")
        git(main_dir, "worktree", "add", "-q", "-b", "feature", wt)
        commit(wt, {".gitleaks.toml": canary_config("branch-canary", "BRANCH-CANARY")}, "the branch's own config")

        def push(cwd, branch):
            # forced, so each case is judged on its own even when an earlier case was wrongly allowed (the hook still sees
            # the pushed range; a forced update is no way around it)
            return git(cwd, "push", "--force", "origin", branch, check=False)

        def expect(name, p, refused, stderr_has=()):
            ok = (p.returncode != 0) == refused and all(s in p.stderr for s in stderr_has)
            if not ok:
                failures.append(f"{name}: expected {'REFUSED' if refused else 'allowed'}"
                                f"{' mentioning ' + repr(stderr_has) if stderr_has else ''}; got exit {p.returncode}: {p.stderr.strip()[-500:]}")
            left = os.listdir(hook_tmp)   # ANY leftover counts, whatever its name (the leaked copy was a default mktemp tmp.*)
            if left:
                failures.append(f"{name}: {len(left)} temporary file(s) left behind in TMPDIR ({', '.join(sorted(n.split('.')[0] for n in left))})")
                for f in left:
                    p = os.path.join(hook_tmp, f)
                    shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)

        # 1. the branch's canary, from the linked worktree: the pushed commit's config governs
        commit(wt, {"a.txt": f"BRANCH-CANARY-{secrets.token_hex(8)}\n"}, "branch canary")
        expect("1 branch canary from the linked worktree", push(wt, "feature"), True, ("the pushed commit's .gitleaks.toml", "branch-canary"))
        git(wt, "reset", "-q", "--hard", "HEAD~1")

        # 2. only the MAIN canary, from the linked worktree: the main checkout's config does not judge this branch
        commit(wt, {"b.txt": f"MAIN-CANARY-{secrets.token_hex(8)}\n"}, "main canary on the branch")
        expect("2 main canary from the linked worktree", push(wt, "feature"), False, ("the pushed commit's .gitleaks.toml",))

        # 3. a pushed config gitleaks cannot load, plus the MAIN canary: scanned again with the hook's own config
        commit(wt, {".gitleaks.toml": "this is [not toml\n", "c.txt": f"MAIN-CANARY-{secrets.token_hex(8)}\n"}, "broken config")
        expect("3 unloadable pushed config", push(wt, "feature"), True, ("did not load", "scanning again with the hook's own config", "main-canary"))
        git(wt, "reset", "-q", "--hard", "HEAD~1")

        # 4. a generated, labelled private key under a branch config that has no key rules: the crypto scanner refuses it
        key = secrets.token_hex(32)
        commit(wt, {"d.js": f'const operatorKey = "0x{key}";\n'}, "a generated key")
        del key
        expect("4 generated key under a config with no key rules", push(wt, "feature"), True)
        git(wt, "reset", "-q", "--hard", "HEAD~1")

        # 5. the main checkout pushes its own canary: its own config governs
        commit(main_dir, {"e.txt": f"MAIN-CANARY-{secrets.token_hex(8)}\n"}, "main canary on main")
        expect("5 main canary from the main checkout", push(main_dir, "main"), True, ("the pushed commit's .gitleaks.toml", "main-canary"))

        # 6-7. each hook copied ALONE into a fresh repository and run directly, as a reviewer would
        def lone_repo(name, hook_has_scanner, worktree_has_scanner):
            r = os.path.join(tmp, name)
            git(tmp, "init", "-q", "-b", "main", r)
            hooks = os.path.join(tmp, name + "-hooks")
            os.makedirs(hooks)
            for f in ("pre-commit", "pre-push"):
                shutil.copy2(os.path.join(HERE, f), os.path.join(hooks, f))
            if hook_has_scanner:
                for f in ("scan-crypto-keys.py", "bip39-english.txt", "known-addresses.txt"):
                    shutil.copy2(os.path.join(HERE, f), os.path.join(hooks, f))
            if worktree_has_scanner:
                os.makedirs(os.path.join(r, ".githooks"))
                for f in ("scan-crypto-keys.py", "bip39-english.txt", "known-addresses.txt"):
                    shutil.copy2(os.path.join(HERE, f), os.path.join(r, ".githooks", f))
            with open(os.path.join(r, "clean.txt"), "w") as f:
                f.write("nothing secret here\n")
            git(r, "add", "clean.txt")   # the scanner copy stays untracked: the hook reads it as a file, and it is not what is pushed
            return r, hooks

        def run_hook(r, hooks, hook, stdin=""):
            return subprocess.run(["bash", os.path.join(hooks, hook), *(["origin"] if hook == "pre-push" else [])], cwd=r, env=env,
                                  input=stdin, capture_output=True, text=True)

        z40 = "0" * 40
        r, hooks = lone_repo("lone-none", False, False)
        expect("6 pre-commit with no scanner anywhere", run_hook(r, hooks, "pre-commit"), True, ("no crypto-key scanner found",))
        git(r, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "clean")
        sha = git(r, "rev-parse", "HEAD").stdout.strip()
        expect("6 pre-push with no scanner anywhere", run_hook(r, hooks, "pre-push", f"refs/heads/main {sha} refs/heads/main {z40}\n"), True, ("no crypto-key scanner found",))
        expect("6 a delete-only push, nothing to scan", run_hook(r, hooks, "pre-push", f"(delete) {z40} refs/heads/gone {sha}\n"), False)
        for label, hook_sc, wt_sc in (("7 scanner only beside the hook", True, False), ("7 scanner only in the worktree", False, True)):
            r, hooks = lone_repo("lone-" + label.split()[-1], hook_sc, wt_sc)
            expect(f"{label}: pre-commit on a clean change", run_hook(r, hooks, "pre-commit"), False)
            git(r, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "clean")
            sha = git(r, "rev-parse", "HEAD").stdout.strip()
            expect(f"{label}: pre-push on a clean commit", run_hook(r, hooks, "pre-push", f"refs/heads/main {sha} refs/heads/main {z40}\n"), False)
    except RuntimeError as e:
        print(f"hook-selftest: could not set up: {e}", file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if failures:
        print("hook-selftest: FAILED", file=sys.stderr)
        for m in failures:
            print(f"  {m}", file=sys.stderr)
        return 1
    print("hook-selftest: 5 real pushes through an absolute core.hooksPath, no temporary file left behind; a missing scanner refuses in both hooks; "
          "the scanner beside the hook or in the worktree suffices; "
          "an unloadable config falls back to the hook's own, and the crypto scanner refuses a generated key whatever the config")
    return 0


if __name__ == "__main__":
    sys.exit(main())
