#!/usr/bin/env python3
"""Parse the read-only node inventories (inventory/<host>.txt) into inventory.json: aggregate memory, cgroup peaks,
unit memory (current/peak/limit), executable identity, disk, docker presence, OOM counts. No secrets are present in
the inputs (no cmdline/environ/ExecStart was collected)."""
import json, re, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
MiB = 1024 * 1024
def num(v):
    try:
        return int(v)
    except Exception:
        return None
out = {"takenAt": open(os.path.join(HERE, "inventory", "TAKEN-AT.txt")).read().strip(), "readOnly": True, "hosts": {}}
for host in ["us-west", "eu-central", "ap-southeast", "ca-east"]:
    txt = open(os.path.join(HERE, "inventory", f"{host}.txt")).read()
    sec = {}
    cur = None
    for line in txt.splitlines():
        if line.startswith("### "):
            cur = line[4:]
            sec[cur] = []
        elif cur:
            sec[cur].append(line)
    mem = {}
    for l in sec.get("meminfo", []):
        k, v = l.split(":", 1)
        mem[k] = int(v.split()[0]) * 1024
    cg = {}
    for l in sec.get("cgroup_root", []):
        parts = l.split(" ", 1)
        cg[parts[0].split("/")[1]] = parts[1].strip() if len(parts) > 1 else ""
    units = []
    for l in sec.get("units", []):
        if not l.startswith("UNIT "):
            continue
        name, rest = l[5:].split("|", 1)
        exe = rest.split(" EXE=")[-1]
        props = dict(p.split("=", 1) for p in rest.split(" EXE=")[0].split("|") if "=" in p)
        units.append({
            "unit": name,
            "exe": exe,
            "memoryCurrentMiB": round(num(props.get("MemoryCurrent")) / MiB, 1) if num(props.get("MemoryCurrent")) else None,
            "memoryPeakMiB": round(num(props.get("MemoryPeak")) / MiB, 1) if num(props.get("MemoryPeak")) else None,
            "memoryMaxMiB": round(num(props.get("MemoryMax")) / MiB, 1) if num(props.get("MemoryMax")) else props.get("MemoryMax"),
            "nRestarts": num(props.get("NRestarts")),
        })
    units.sort(key=lambda u: -(u["memoryPeakMiB"] or 0))
    disk = [l.split() for l in sec.get("disk", []) if l.startswith("/") and not l.startswith("/dev")]
    host_info = sec.get("host", [])
    enclave_units = [u for u in units if u["unit"].startswith("enclave-") or u["unit"] == "caddy.service"]
    sum_peaks = sum(u["memoryPeakMiB"] or 0 for u in units)
    out["hosts"][host] = {
        "kernel": host_info[1] if len(host_info) > 1 else None,
        "vcpus": num(host_info[2]) if len(host_info) > 2 else None,
        "uptimeDays": round(float(host_info[3].split()[0]) / 86400, 1) if len(host_info) > 3 else None,
        "memTotalMiB": round(mem["MemTotal"] / MiB, 1),
        "memAvailableMiB": round(mem["MemAvailable"] / MiB, 1),
        "swapTotalMiB": round(mem["SwapTotal"] / MiB, 1),
        "committedASMiB": round(mem["Committed_AS"] / MiB, 1),
        "systemSliceCurrentMiB": round(int(cg["memory.current"]) / MiB, 1),
        "systemSlicePeakMiB": round(int(cg["memory.peak"]) / MiB, 1),
        "systemSliceEvents": cg.get("memory.events"),
        "headroomAtSystemSlicePeakMiB": round((mem["MemTotal"] - int(cg["memory.peak"])) / MiB, 1),
        "psiMemory": sec.get("psi_memory"),
        "rootDisk": {"sizeBytes": int(disk[0][1]), "usedBytes": int(disk[0][2]), "availBytes": int(disk[0][3])} if disk else None,
        "docker": sec.get("docker"),
        "oomKills30d": sec.get("oom_kills_30d"),
        "enclaveUnits": enclave_units,
        "enclaveUnitPeakSumMiB": round(sum(u["memoryPeakMiB"] or 0 for u in enclave_units), 1),
        "allRunningUnitPeakSumMiB": round(sum_peaks, 1),
        "otherUnits": [u for u in units if u not in enclave_units],
        "varLibSizes": sec.get("var_lib_sizes"),
    }
json.dump(out, open(os.path.join(HERE, "inventory.json"), "w"), indent=1)
for h, v in out["hosts"].items():
    print(f"{h:13s} vcpu={v['vcpus']} total={v['memTotalMiB']} avail={v['memAvailableMiB']} sysPeak={v['systemSlicePeakMiB']} headroomAtPeak={v['headroomAtSystemSlicePeakMiB']} enclavePeakSum={v['enclaveUnitPeakSumMiB']} diskAvailGB={v['rootDisk']['availBytes']/1e9:.2f} docker={v['docker'][0]} oom={v['oomKills30d'][0]}")
