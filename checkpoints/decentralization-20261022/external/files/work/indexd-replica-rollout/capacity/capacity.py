#!/usr/bin/env python3
"""Capacity decision for independent indexd metadata replicas (v2, conservative), from MEASURED inputs only:
  outputs/storage-indexd-review/live-footprint.json      root's read-only live measurement (2026-10-20T09:54Z)
  outputs/storage-indexd-review/provider-capacity.json   root's read-only probe of the four provider servers
  outputs/storage-indexd-review/provider-services.json   what the provider memory is used by (none may be stopped)
v1 (capacity/history/) used an earlier, understated indexd peak (199.6 MiB) and proposed a 320 MiB cap BELOW the
live high-water (cgroup MemoryPeak 380 MiB, VmHWM 424 MiB). v2 keeps the live primary's caps (indexd MemoryMax 1 GiB,
GOMEMLIMIT 512 MiB; PostgreSQL container 1 GiB) because no representative mainnet recovery/sync/load measurement
substantiates a smaller budget. Measured high-water is reported as a FLOOR, not a budget."""
import json
import math
from pathlib import Path

wo = Path(__file__).resolve().parents[3]
rev = wo / "outputs/storage-indexd-review"
live = json.loads((rev / "live-footprint.json").read_text())["measurement"]
prov = json.loads((rev / "provider-capacity.json").read_text())
svc = json.loads((rev / "provider-services.json").read_text())
MiB = 1 << 20
kib = lambda s: int(s.split()[1]) / 1024  # "VmHWM:\t 434400 kB" -> MiB

idx = live["enclave-indexd"]
hwm = next(kib(l) for l in idx["processMemory"] if l.startswith("VmHWM"))
floor = {
    "indexdCgroupMemoryPeakMiB": round(int(idx["MemoryPeak"]) / MiB, 1),
    "indexdVmHWMMiB": round(hwm, 1),
    "postgresContainerMiB": float(live["postgres"]["MemUsage"].split("MiB")[0]),
    "postgresEarlierPeakMiB": 147.2,  # outputs/storage-destination-assessment.json (2026-10-19)
}
floor["measuredFloorMiB"] = round(floor["indexdVmHWMMiB"] + floor["postgresEarlierPeakMiB"], 1)
caps = {"indexdMemoryMaxMiB": int(idx["MemoryMax"]) // MiB, "indexdGOMEMLIMITMiB": 512, "postgresMemoryMaxMiB": 1024}
host_margin = 256
need_mem = caps["indexdMemoryMaxMiB"] + caps["postgresMemoryMaxMiB"] + host_margin
state = sum(int(x.split()[0]) for x in live["stateBytes"].strip().splitlines()) / MiB
need_disk = math.ceil((state * 3 + 650 + 1024) / 256) * 256  # state x3 (growth, local backup, restore scratch) + PG image + 1 GiB

nodes = {}
for name, p in prov.items():
    avail = p["memoryKiB"]["MemAvailable"] / 1024
    nodes[name] = {
        "memTotalMiB": round(p["memoryKiB"]["MemTotal"] / 1024, 1), "memAvailableMiB": round(avail, 1),
        "swapMiB": p["memoryKiB"]["SwapTotal"] // 1024, "diskFreeMiB": round(p["diskFree"] / MiB),
        "residentServices": [s["unit"] for s in svc["hosts"].get(name, {}).get("serviceMemory", [])],
        "fitsMeasuredFloor": avail >= floor["measuredFloorMiB"],
        "fitsRequired": avail >= need_mem and p["diskFree"] / MiB >= need_disk,
        "memShortfallMiB": round(max(0, need_mem - avail), 1),
    }
fit = [n for n, v in nodes.items() if v["fitsRequired"]]
liveVm = {l.split(":")[0]: int(l.split()[1]) // 1024 for l in live["memory"]}
result = {
    "version": 2,
    "inputs": [str(p.relative_to(wo)) for p in (rev / "live-footprint.json", rev / "provider-capacity.json", rev / "provider-services.json")],
    "measuredFloor": floor,
    "measuredFloorNote": "point-in-time idle observation plus process high-water history; NOT a production load envelope",
    "perReplicaCaps": caps,
    "perReplicaRequirement": {"memAvailableMiB": need_mem, "hostMarginMiB": host_margin, "diskFreeMiB": need_disk,
                              "basis": "the live primary's caps (MemoryMax 1G + container 1g) are not overcommitted; "
                                       "a smaller budget needs a representative mainnet recovery/sync/load measurement"},
    "livePrimaryVm": {"memTotalMiB": liveVm["MemTotal"], "memAvailableMiB": liveVm["MemAvailable"], "swapMiB": liveVm["SwapTotal"]},
    "providers": nodes,
    "providersThatFit": fit,
    "verdict": ("INSUFFICIENT: no existing provider can host an independent replica; even the measured floor "
                f"({floor['measuredFloorMiB']} MiB) exceeds every provider's available memory, and the conservative "
                f"requirement is {need_mem} MiB. Provider memory is used by resident services that must not be stopped.")
               if len(fit) < 2 else f"SUFFICIENT on {fit}",
}
out = Path(__file__).resolve().parent / "capacity.json"
out.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
