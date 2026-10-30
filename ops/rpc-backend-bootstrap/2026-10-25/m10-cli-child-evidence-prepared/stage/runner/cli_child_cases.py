#!/usr/bin/env python3
"""cli_child_cases.py <test-binary COPY> <pins.json> <out-dir>: runs INSIDE the bounded transient unit (run-cli-child-
supplement.sh). It only RECORDS; it never judges (checker/check_compound.py does, from the saved bytes).

Runs, each its own process, never in parallel, each with a 60 s timeout:
  1. every one of the 45 non-ignored cases of run 2's `node::` filter: `<bin> --exact <name>`;
  2. the ignored child three times, exactly as the original wrapper spawns it (node.rs validates_sequencer_key_from_env:
     `--exact <child> --ignored`), with the environment of each original case (raw_key, key_path, remote_endpoint);
  3. the NEGATIVE CONTROL: the same child invocation with NO signer variable (it must fail its own assertion).

Environment: a clean env (PATH, LANG, HOME only), plus the case variables. That is stricter than the wrapper, which
removes only the four signer variables from an inherited env; the child reads nothing else (SignerArgs::parse_from).
stdout/stderr are saved byte-exact. results.json records argv, env KEYS, sha256 of every env VALUE (never the raw-key
fixture itself), rc, the timeout flag and output hashes."""
import hashlib, json, os, pathlib, subprocess, sys

binary, pins_p, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
pins = json.load(open(pins_p)); C = pins["cases"]; FX = pins["fixtures"]
out.mkdir(parents=True, exist_ok=False)
sha = lambda b: hashlib.sha256(b).hexdigest()


def raw_key_fixture():
    # node.rs case::raw_key value: an UPSTREAM PUBLIC TEST FIXTURE, assembled from chunks and checked against its pin
    v = "".join(FX["rawKeyChunks"])
    if sha(v.encode()) != FX["rawKeySha256"]:
        sys.exit("fixture hash mismatch: refusing")
    return v


CASE_ENV = {   # node.rs validates_sequencer_key_from_env #[case]s, verbatim except the fixture assembly
    "raw_key": lambda: {"BASE_NODE_P2P_SEQUENCER_KEY": raw_key_fixture()},
    "key_path": lambda: {"BASE_NODE_P2P_SEQUENCER_KEY_PATH": "/tmp/key.hex"},
    "remote_endpoint": lambda: {"BASE_NODE_P2P_SIGNER_ENDPOINT": "http://localhost:8080",
                                "BASE_NODE_P2P_SIGNER_ADDRESS": "0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a"},
}
BASE_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": os.environ.get("HOME", "/nonexistent")}
results = []


def run(label, kind, name, argv, extra):
    env = {**BASE_ENV, **extra}
    rec = {"label": label, "kind": kind, "name": name, "argv": argv, "envKeys": sorted(env),
           "envValueSha256": {k: sha(v.encode()) for k, v in sorted(extra.items())}}
    try:
        p = subprocess.run([binary, *argv], env=env, capture_output=True, timeout=60, cwd=str(out))
        so, se, rc, to = p.stdout, p.stderr, p.returncode, False
    except subprocess.TimeoutExpired as e:
        so, se, rc, to = e.stdout or b"", e.stderr or b"", None, True
    (out / f"{label}.stdout").write_bytes(so); (out / f"{label}.stderr").write_bytes(se)
    rec.update(rc=rc, timedOut=to, stdoutSha256=sha(so), stderrSha256=sha(se))
    results.append(rec)


for i, name in enumerate(C["nonIgnored"], 1):
    run(f"case-{i:02d}", "nonIgnored", name, ["--exact", name], {})
for case in C["childEnvCases"]:
    run(f"child-{case}", "child", C["child"], ["--exact", C["child"], "--ignored"], CASE_ENV[case]())
run("control-no-env", "control", C["child"], ["--exact", C["child"], "--ignored"], {})
(out / "results.json").write_text(json.dumps({"format": "m10-cli-child-supplement-results/v1", "binary": binary,
                                               "binarySha256": sha(pathlib.Path(binary).read_bytes()), "runs": results}, indent=1))
print(f"recorded {len(results)} runs")
