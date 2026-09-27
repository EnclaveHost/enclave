#!/usr/bin/env python3
"""Independent resource-policy derivation from RESOURCE-POLICY.md.

Reads [{memMb, config}, ...] on stdin and writes [{result}|{error}, ...].
This is a verifier/test reference, not a host capability or deployment parser.
"""
import json
import math
import sys


def resource_policy(memory, config=""):
    # The catalog ABI supplies an unsigned integer. Decimal strings are
    # accepted because JSON RPC libraries often represent ABI integers so.
    if isinstance(memory, str) and memory.isascii() and memory.isdecimal():
        memory = int(memory)
    if type(memory) not in (int, float) or not math.isfinite(memory) or memory != int(memory) or not 0 <= memory <= 65536:
        raise ValueError("invalid catalog memory")
    memory = int(memory)
    if config is None or config == "":
        config = {}
    elif isinstance(config, str):
        config = json.loads(config)
    profile = config.get("_isolationPolicy") if isinstance(config, dict) else None
    present = isinstance(config, dict) and "_isolationPolicy" in config
    if present:
        if not isinstance(profile, dict) or set(profile) != {"rule", "vcpus"}:
            raise ValueError("invalid explicit profile fields")
        if profile["rule"] != "enclave-isolation-policy/2":
            raise ValueError("unsupported rule")
        cpus = profile["vcpus"]
        if type(cpus) not in (int, float) or not math.isfinite(cpus) or cpus != int(cpus) or not 1 <= cpus <= 16:
            raise ValueError("invalid vCPU count")
    cpus = int(profile["vcpus"]) if present else 1
    return {"rule": "enclave-isolation-policy/2" if present else "enclave-isolation-policy/1",
            "policy": {"cpuPercent": 100 * cpus, "memMiB": max(128, memory), "vcpus": cpus}}


if __name__ == "__main__":
    output = []
    for case in json.load(sys.stdin):
        try:
            output.append({"result": resource_policy(case.get("memMb"), case.get("config", ""))})
        except (ValueError, TypeError):
            output.append({"error": True})
    json.dump(output, sys.stdout, sort_keys=True)
    print()
