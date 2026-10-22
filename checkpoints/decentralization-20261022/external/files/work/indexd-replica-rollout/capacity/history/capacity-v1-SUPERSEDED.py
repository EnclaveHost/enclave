#!/usr/bin/env python3
"""Capacity decision for independent indexd metadata replicas, computed ONLY from measured inputs:
  outputs/storage-indexd-review/provider-capacity.json   root's read-only probe of the four provider servers
  outputs/storage-destination-assessment.json            measured live indexd/PostgreSQL footprint (cgroup peaks)
Writes capacity/capacity.json. No cap is lowered below a measurement: PostgreSQL keeps the live
shared_buffers=128MB configuration whose peak was measured; indexd's cap is 1.6x its measured peak."""
import json
import math
from pathlib import Path

wo = Path(__file__).resolve().parents[3]
prov = json.loads((wo / "outputs/storage-indexd-review/provider-capacity.json").read_text())
live = json.loads((wo / "outputs/storage-destination-assessment.json").read_text())["nan"]
MiB = 1 << 20

indexd_peak = live["indexdMemoryPeakBytes"] / MiB          # measured, live v0.6.0 single writer
pg_peak = live["postgresMemoryPeakBytes"] / MiB            # measured, shared_buffers=128MB
indexd_cap = math.ceil(indexd_peak * 1.6 / 32) * 32        # headroom for a replica forming its own contracts
pg_cap = math.ceil(pg_peak * 1.3 / 32) * 32
host_margin = 64                                           # no swap on providers: keep a margin before the OOM killer
need_mem = indexd_cap + pg_cap + host_margin
state_mib = live["indexdDiskMiB"] + live["postgresDiskMiB"]
need_disk = math.ceil((state_mib * 2 + 650 + 1024) / 256) * 256  # state x2 (growth + one local backup) + PG image + 1 GiB

nodes = {}
for name, p in prov.items():
    avail = p["memoryKiB"]["MemAvailable"] / 1024
    disk = p["diskFree"] / MiB
    nodes[name] = {
        "memTotalMiB": round(p["memoryKiB"]["MemTotal"] / 1024, 1),
        "memAvailableMiB": round(avail, 1),
        "swapMiB": p["memoryKiB"]["SwapTotal"] // 1024,
        "diskFreeMiB": round(disk),
        "fitsMeasuredPeaksAlone": avail >= indexd_peak + pg_peak,
        "fitsRequired": avail >= need_mem and disk >= need_disk,
        "memShortfallMiB": round(max(0, need_mem - avail), 1),
    }
result = {
    "inputs": {"providerProbe": "outputs/storage-indexd-review/provider-capacity.json",
               "liveFootprint": "outputs/storage-destination-assessment.json (nan.*, cgroup MemoryPeak)"},
    "measured": {"indexdPeakMiB": round(indexd_peak, 1), "postgresPeakMiB": round(pg_peak, 1),
                 "indexdStateDiskMiB": live["indexdDiskMiB"], "postgresDiskMiB": live["postgresDiskMiB"]},
    "perReplicaRequirement": {"indexdMemoryMaxMiB": indexd_cap, "indexdGOMEMLIMITMiB": indexd_cap - 64,
                              "postgresMemoryMaxMiB": pg_cap, "hostMarginMiB": host_margin,
                              "memAvailableMiB": need_mem, "diskFreeMiB": need_disk},
    "providers": nodes,
    "providersThatFit": [n for n, v in nodes.items() if v["fitsRequired"]],
    "verdict": None,
}
fit = result["providersThatFit"]
result["verdict"] = ("INSUFFICIENT: no existing provider can host an independent replica (indexd + its own PostgreSQL) "
                     "without overcommitting memory; activation of replicas awaits capacity" if len(fit) < 2 else
                     f"SUFFICIENT on {fit}")
out = Path(__file__).resolve().parent / "capacity.json"
out.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
