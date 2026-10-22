#!/usr/bin/env python3
"""Capacity model: can each regional node host ONE independent durable indexer (indexd + its own PostgreSQL and chain
state)? Inputs are MEASURED: inventory.json (read-only node inventory, this work) and the live primary's footprint
(outputs/storage-indexd-review/live-footprint.json, root's read-only measurement; package ROLLOUT.md section 1).
Nothing here is a load test; every requirement figure is a measured value or the tested package's declared caps."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
inv = json.load(open(os.path.join(HERE, "inventory.json")))
live = json.load(open(os.path.join(HERE, "..", "..", "outputs", "storage-indexd-review", "live-footprint.json")))
MiB = 1024 * 1024
m = live["measurement"]
indexd_peak_cg = int(m["enclave-indexd"]["MemoryPeak"]) / MiB                                   # 380.4
indexd_hwm = int(m["enclave-indexd"]["processMemory"][1].split()[1]) / 1024                      # 424.2 (VmHWM kB)
indexd_idle_rss = int(m["enclave-indexd"]["processMemory"][2].split()[1]) / 1024                 # 119.1
pg_container_now = 114.5                                                                          # docker stats MemUsage
pg_earlier_peak = 147.2                                                                           # ROLLOUT.md section 1
pg_postmaster_rss = int(m["enclave-indexd-postgres"]["processMemory"][2].split()[1]) / 1024      # host-side wrapper only
state_bytes = 561190789 + 87669144
MARGIN = 256  # the package's margin for a node that must keep its existing services alive (no swap)

req = {
    "package_caps_not_overcommitted": {"MiB": 1024 + 1024 + MARGIN, "basis": "tested package: indexd MemoryMax 1G (GOMEMLIMIT 512MiB) + PostgreSQL --memory 1g + 256 MiB margin"},
    "measured_high_water_plus_margin": {"MiB": round(indexd_hwm + pg_earlier_peak + MARGIN, 1), "basis": "live primary indexd VmHWM + PostgreSQL earlier peak + 256 MiB margin"},
    "measured_high_water_no_margin": {"MiB": round(indexd_hwm + pg_earlier_peak, 1), "basis": "live primary indexd VmHWM + PostgreSQL earlier peak, NO margin"},
    "idle_lower_bound_no_margin": {"MiB": round(indexd_idle_rss + pg_container_now, 1), "basis": "live primary IDLE indexd RSS + PostgreSQL container now; a floor, NOT a sizing (no peak, no margin)"},
}
hosts = {}
for h, v in inv["hosts"].items():
    budget_peak = v["headroomAtSystemSlicePeakMiB"]     # total minus the existing services' measured cgroup peak
    budget_now = v["memAvailableMiB"]                   # what the kernel says is available now (optimistic)
    fits = {k: {"vsHeadroomAtPeak": round(budget_peak - r["MiB"], 1), "vsMemAvailableNow": round(budget_now - r["MiB"], 1)} for k, r in req.items()}
    hosts[h] = {
        "memTotalMiB": v["memTotalMiB"], "memAvailableMiB": budget_now, "existingServicesPeakMiB": v["systemSlicePeakMiB"],
        "headroomAtPeakMiB": budget_peak, "vcpus": v["vcpus"], "docker": v["docker"][0], "diskAvailGB": round(v["rootDisk"]["availBytes"] / 1e9, 2),
        "gatewayAtItsCap": any(u["unit"] == "enclave-bootstrap-gateway.service" and u["memoryPeakMiB"] and u["memoryMaxMiB"] == u["memoryPeakMiB"] for u in v["enclaveUnits"]),
        "slackMiB_per_requirement": fits,
        "verdict": "DOES NOT FIT" if all(f["vsHeadroomAtPeak"] < 0 for k, f in fits.items() if k != "idle_lower_bound_no_margin") else "check",
    }
# Option: resize an existing node (spend; NOT authorized). Needed total RAM = existing services' peak + requirement.
resize = {k: {h: round(v["existingServicesPeakMiB"] + r["MiB"], 1) for h, v in hosts.items()} for k, r in req.items() if k != "idle_lower_bound_no_margin"}
out = {
    "inputs": {"inventoryTakenAt": inv["takenAt"], "livePrimaryCheckedAt": live["checkedAt"], "indexdPeakCgroupMiB": round(indexd_peak_cg, 1),
               "indexdVmHWM_MiB": round(indexd_hwm, 1), "indexdIdleRssMiB": round(indexd_idle_rss, 1), "postgresContainerNowMiB": pg_container_now,
               "postgresEarlierPeakMiB": pg_earlier_peak, "replicaStateBytes": state_bytes, "marginMiB": MARGIN},
    "requirementPerReplica": req,
    "hosts": hosts,
    "resizeNeededTotalRamMiB": resize,
    "notes": [
        "headroomAtPeak = MemTotal - system.slice memory.peak (the existing services' measured high-water, cgroup v2); no swap on any node",
        "Docker is absent on every node; the tested package runs PostgreSQL in Docker, so dockerd/containerd memory would come on top (not measured here)",
        "1 vCPU per node, shared with the regional services; indexd's CPU envelope (chain sync, host scans, integrity checks) is not measured",
        "idle_lower_bound is shown to make the impossibility independent of caps: even the idle floor leaves almost nothing at peak",
    ],
}
json.dump(out, open(os.path.join(HERE, "capacity-model.json"), "w"), indent=1)
for h, v in hosts.items():
    print(h, "headroomAtPeak", v["headroomAtPeakMiB"], {k: f["vsHeadroomAtPeak"] for k, f in v["slackMiB_per_requirement"].items()}, v["verdict"])
print("resize totals", json.dumps(resize))
