#!/usr/bin/env python3
"""Compare calling-thread C++ allocations in the real Shield scheduler fixture.

Requires a local ggml checkout/libraries (GGML_SRC/GGML_LIB). Compiles an old
backend source and the current source against the same current headers, core
objects, fixture and libraries. Uses a bound, non-listening loopback port so no
GPU worker is contacted: products run through the trusted exact fallback. This
tiny graph measures allocation churn; it is not a model throughput benchmark.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import statistics
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", required=True)
    parser.add_argument("--repetitions", type=int, default=7)
    args = parser.parse_args()
    assert args.repetitions > 0
    repo = Path(__file__).resolve().parents[2]
    src = repo / "wasm/ggml-shielded"
    headers = Path(os.environ.get("GGML_SRC", Path.home() / "Projects/llama.cpp"))
    libs = Path(os.environ.get("GGML_LIB", Path.home() / "Projects/llamacpp-lib"))
    commit = subprocess.check_output(["git", "rev-parse", "--verify", "--end-of-options",
                                      args.baseline_ref + "^{commit}"], cwd=repo, text=True).strip()
    with tempfile.TemporaryDirectory(prefix="shield-scheduler-") as temp:
        work = Path(temp)
        baseline = work / "baseline.cpp"
        baseline.write_bytes(subprocess.check_output(["git", "show", commit + ":wasm/ggml-shielded/ggml-shielded.cpp"], cwd=repo))
        flags = ["-O2", "-ffunction-sections", "-fdata-sections"]
        objects = []
        for name in ("shielded-field", "shielded-wire", "shielded-tee", "shielded-parwork", "shielded-pads",
                     "shielded-bank", "shielded-http", "tweetnacl", "poly1305-donna", "shielded-simd"):
            obj = work / (name + ".o")
            subprocess.run(["cc", "-std=c11", *flags, "-ffp-contract=off", "-c", str(src / (name + ".c")), "-o", str(obj)], check=True)
            objects.append(str(obj))
        fast = work / "fast.o"
        arch = (["-march=armv8.2-a+dotprod", "-DSH_SIMD_NEON"] if os.uname().machine == "aarch64" else
                ["-mavx512f", "-mavx512bw", "-mavx512dq", "-mavx512vl", "-mavx512vnni", "-DSH_SIMD_AVX512"])
        subprocess.run(["cc", *flags, *arch, "-c", str(src / "shielded-simd.c"), "-o", str(fast)], check=True)
        objects.append(str(fast))
        for name, backend in (("baseline", baseline), ("improved", src / "ggml-shielded.cpp")):
            subprocess.run(["c++", "-std=c++17", *flags, "-DSH_SCHEDULER_ALLOC_BENCH",
                            "-I" + str(src), "-I" + str(headers / "ggml/include"), "-I" + str(headers / "ggml/src"),
                            str(backend), str(repo / "test/fixtures/shielded-fusion-scheduler.cpp"), *objects,
                            "-Wl,--gc-sections", "-L" + str(libs), "-lggml", "-lggml-cpu", "-lggml-base",
                            "-lpthread", "-lm", "-Wl,-rpath," + str(libs), "-o", str(work / name)], check=True)
        calib = work / "attn.calib"
        calib.write_text("# shielded-calib 1\n" + "".join("site blk.3." + n + ".weight 8 0\n"
                         for n in ("attn_output", "ssm_out", "ffn_gate", "ffn_up")))
        env = {k: v for k, v in os.environ.items() if not k.startswith("SHIELDED_")}
        env.update(SHIELDED_CALIB=str(calib), SHIELDED_HOST="127.0.0.1", SHIELDED_MIN_MACS="0",
                   SHIELDED_MAX_M="16", SHIELDED_LOCAL_EXACT="1", SHIELDED_NO_SIMD="1",
                   SHIELDED_LOCAL_THREADS="1", SHIELDED_REFILL_THREADS="1", OMP_NUM_THREADS="1")
        runs, summary = [], []
        with socket.socket() as hold:
            hold.bind(("127.0.0.1", 0))  # Hold the port without accepting connections.
            env["SHIELDED_PORT"] = str(hold.getsockname()[1])
            for fused in (0, 1):
                env["SHIELDED_FUSE_LOCAL"] = str(fused)
                for m in (1, 8, 16):
                    samples = {"baseline": [], "improved": []}
                    expected = None
                    for trial in range(args.repetitions):
                        order = ("baseline", "improved") if trial % 2 == 0 else ("improved", "baseline")
                        for name in order:
                            result = subprocess.run([str(work / name), str(m), "attn"], env=env,
                                                    text=True, capture_output=True, check=True, timeout=30)
                            stats, outputs = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
                            if expected is None:
                                expected = outputs
                            assert outputs == expected, (name, m, fused, outputs, expected)
                            samples[name].append(stats)
                    row = {"rows": m, "fused": bool(fused)}
                    for name, values in samples.items():
                        row[name] = {key: statistics.median(v[key] for v in values)
                                     for key in ("iterations", "allocations", "allocated_bytes", "us_per_graph")}
                    summary.append(row)
                    runs.append({"rows": m, "fused": bool(fused), "samples": samples, "outputs": expected})
        print(json.dumps({"baseline_commit": commit, "repetitions": args.repetitions,
                          "scope": "Calling-thread C++ allocations in a tiny real-scheduler graph using exact CPU fallback; no inference speed or retained RAM claim",
                          "compiler_flags": "-O2 -std=c++17", "order": "alternating fresh processes after all builds finish",
                          "summary": summary, "runs": runs}, indent=2))


if __name__ == "__main__":
    main()
