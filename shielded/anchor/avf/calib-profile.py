#!/usr/bin/env python3
"""Create an experimental CPU/GPU placement calibration shared by APK and dealer.

Only removes complete calibrated activation groups; retained calibration lines
are byte-for-byte unchanged. Never alter SHIELDED_LOCAL_SITES to implement these
profiles: importer and dealer must enumerate the same PRF group ordinals.
"""
import argparse
import hashlib
from pathlib import Path
import re

PROFILES = {
    "local-output": {"attn_output", "ssm_out", "ffn_down", "token_embd"},
    "gpu-ffn": None,  # retain only ffn_gate (the group also includes ffn_up)
}


def profile(source: bytes, mode: str) -> tuple[bytes, int, int]:
    if mode not in PROFILES:
        raise ValueError("unknown profile")
    lines = source.decode("ascii").splitlines(keepends=True)
    if not lines or lines[0].strip() != "# shielded-calib 2":
        raise ValueError("expected shielded-calib 2")
    sites, retained, seen = [], [], set()
    for line in lines[1:]:
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        fields = text.split()
        if len(fields) < 4 or fields[0] != "site":
            raise ValueError("malformed site line")
        name = fields[1]
        match = re.fullmatch(r"(?:blk\.[0-9]+\.)?([a-z][a-z0-9_]*)\.weight", name)
        if not match or name in seen:
            raise ValueError("noncanonical or duplicate site")
        seen.add(name)
        af, count = int(fields[2]), int(fields[3])
        indices = [int(x) for x in fields[4:]]
        if count < 0 or len(indices) != count or any(x < 0 for x in indices):
            raise ValueError("invalid outlier list")
        family = match[1]
        if family in {"attn_k", "attn_v", "ffn_up", "attn_gate", "ssm_alpha", "ssm_beta", "ssm_ba"}:
            raise ValueError("calibration must name group representatives")
        sites.append(name)
        keep = family == "ffn_gate" if mode == "gpu-ffn" else family not in PROFILES[mode]
        if keep:
            retained.append(line if line.endswith("\n") else line + "\n")
    if not retained or len(retained) == len(sites):
        raise ValueError("profile must retain and remove at least one group")
    header = ("# shielded-calib 2\n"
              f"# placement-profile {mode}; source-sha256 {hashlib.sha256(source).hexdigest()}\n"
              f"# {len(retained)} retained / {len(sites)} original groups; use identical bytes in APK and dealer\n")
    return (header + "".join(retained)).encode("ascii"), len(retained), len(sites)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error("output must differ from source")
    try:
        result, kept, total = profile(args.source.read_bytes(), args.profile)
    except (ValueError, UnicodeError) as exc:
        parser.error(str(exc))
    args.output.write_bytes(result)
    print(f"{args.profile}: {kept}/{total} calibrated groups retained; sha256={hashlib.sha256(result).hexdigest()}")


if __name__ == "__main__":
    main()
