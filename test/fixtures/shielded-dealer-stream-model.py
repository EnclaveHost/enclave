#!/usr/bin/env python3
"""Explicit opt-in real CPU/MTP lifecycle check, never an operator GPU test."""
import ctypes
import hashlib
import os
from pathlib import Path
import secrets
import select
import shutil
import struct
import subprocess
import sys
import time

binary, model, original_calib, backend, cpu, root, compare = sys.argv[1:]
root = Path(root)
calib = root / "model.calib"
shutil.copyfile(original_calib, calib)
assert b"nextn.eh_proj.weight" in calib.read_bytes(), "this real MTP fixture requires calibration covering the MTP head"
bank = root / "bank with spaces"
baseline = root / "baseline"
bank.mkdir(); baseline.mkdir()
env = {k: v for k, v in os.environ.items() if not k.startswith("SHIELDED_")}
env.update(SHIELDED_SO=backend, GGML_CPU_SO=cpu, SHIELDED_CALIB=str(calib), SHIELDED_MINT_THREADS="2")
stream_env = env.copy()
if os.environ.get("DEALER_TEST_BALANCE") == "1":
    env["SHIELDED_MINT_THREADS"] = stream_env["SHIELDED_MINT_THREADS"] = "16"
    stream_env["SHIELDED_MINT_BALANCE"] = "1"
ctypes.CDLL(str(Path(cpu).with_name("libggml.so")), mode=ctypes.RTLD_GLOBAL)
library = ctypes.CDLL(backend)
sk = secrets.token_bytes(32)
pk = ctypes.create_string_buffer(32)
assert library.crypto_scalarmult_curve25519_tweet_base(pk, sk) == 0
seed, sid = secrets.token_hex(32), secrets.token_hex(16)
calib_digest = hashlib.sha512(calib.read_bytes()).digest()[:32].hex()

def line(pipe, seconds=60):
    deadline = time.monotonic() + seconds
    output = bytearray()
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        assert remaining > 0 and select.select([pipe], [], [], remaining)[0], "protocol timeout"
        b = os.read(pipe.fileno(), 1)
        assert b, "unexpected protocol EOF"
        if b == b"\n": return output.decode("ascii")
        output += b
        assert len(output) < 256, "oversized response"
    raise AssertionError("protocol deadline")

def send(child, sequence, start, request_seed=seed, request_sid=sid):
    message = f"{sequence}\t{request_seed}\t{request_sid}\t{pk.raw.hex()}\t{start}\t1\n".encode()
    # Explicitly fragmented writes to the real, initialized frontend.
    for at in range(0, len(message), 7):
        assert child.stdin.write(message[at:at+7]) == len(message[at:at+7])

def table(path, expected_start, expected_count):
    with path.open("rb") as f:
        header = f.read(256)
        assert header[:8] == b"ENCLPAD1" and struct.unpack_from("<I", header, 8)[0] == 2
        groups = struct.unpack_from("<I", header, 12)[0]
        assert 0 < groups <= 1024
        assert header[16:48].hex() == calib_digest
        assert header[48:64].hex() == sid
        assert struct.unpack_from("<QQ", header, 64) == (expected_start, expected_count)
        wire = f.read(80 * groups)
    names = [wire[i*80+16:i*80+80].split(b"\0", 1)[0] for i in range(groups)]
    assert any(b"nextn.eh_proj.weight" in name for name in names), "MTP head groups absent"
    return wire, groups

with (root / "stream.stderr").open("wb") as log:
    child = subprocess.Popen([binary, model, "--jobs-stdin", str(bank), "--mtp", "1"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, env=stream_env, bufsize=0)
    try:
        assert line(child.stdout) == f"PADS-READY 1 mtp=1 calib={calib_digest}"
        for sequence, start in [(1, 0), (2, 1)]:
            send(child, sequence, start)
            assert line(child.stdout) == f"PADS-DONE {sequence} {sid} {start} 1"
            wire, groups = table(bank / f"{sid}-{start}-1.pads", start, 1)
        # Same seed, key and cells through the existing one-shot path. Ciphertext
        # varies with file keys; authenticated opened u must be byte-equivalent.
        path = baseline / f"{sid}-0-2.pads"
        with (root / "oneshot.stderr").open("wb") as other_log:
            subprocess.run([binary, model, "--out", str(path), "--seed", seed, "--seed-id", sid,
                            "--pk", pk.raw.hex(), "--index0", "0", "--count", "2", "--mtp", "1"],
                           env=env, stdout=subprocess.DEVNULL, stderr=other_log, check=True, timeout=60)
        assert table(path, 0, 2)[0] == wire
        result = subprocess.run([compare, sk.hex(), sid, str(bank), str(baseline)], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=True)
        assert result.stdout.decode() == f"{groups*2} opened cells exactly equal\n"
        other_seed, other_sid = secrets.token_hex(32), secrets.token_hex(16)
        send(child, 3, 0, other_seed, other_sid)
        assert line(child.stdout) == f"PADS-DONE 3 {other_sid} 0 1"
        assert (bank / f"{other_sid}-0-1.pads").is_file()
        # Mutate only a fixture copy, after successful jobs in this process.
        stamp = calib.stat()
        os.utime(calib, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1_000_000_000))
        send(child, 4, 2)
        assert line(child.stdout) == "PADS-ERROR 4 asset-changed"
        assert child.wait(timeout=10) == 1
        assert not (bank / f"{sid}-2-1.pads").exists()
    finally:
        if child.poll() is None: child.kill()
        child.wait(timeout=10)
        child.stdin.close(); child.stdout.close()
assert seed.encode() not in (root / "stream.stderr").read_bytes()
print(f"real persistent MTP lifecycle: PASS; {groups} groups, all {groups*2} opened cells equal one-shot")
if os.environ.get("DEALER_TEST_BALANCE") == "1":
    print("balanced16-thread stream cells equal unbalanced16-thread one-shot cells")
