"""Pure guard logic of the hs2 activation helper (no I/O): every decision the root helper takes from a remote probe or a
remote result is made here, so the fixture tests exercise exactly the production decisions.

Phases (root-hs2-activate.py):
  dry-run   read-only: report what the next phase would do
  transfer  copy the verified public snapshot objects (only the manifest's .bin/.car) to a new staging dir on minipc
  fill      fill-data artifacts --from-dir <staging> (the stage tool re-verifies every sha256) + fill-data policy
  start     start.ps1 (task start + stage-1 health), then loopback-only listener proof; on any failure stop.ps1
  cleanup   remove the staging copy (only the marked dir this helper created) once the artifacts are complete
  stop      stop.ps1 (back to INSTALLED_NOT_STARTED, data kept)
  rollback  rollback.ps1 (the package's own, W9-tested): pre-install state
"""
import re

# ---- immutable pins (evidence: work/resume-20261021 install/verify results; probe-minipc.json 13:31Z) ----
PINS = {
    "archiveSha256": "d0218596f243ca3480f1c76438f5821d8630008fcef156a86b5e369cbcad8c54",
    "manifestSha256": "62c4ed1b40f2731be1d6124f81b0dd65c13a4b1626afaa47910e8801ee8d73ca",
    "receiptSha256": "d828b3b888ccf7c2a062c58eda7980531d6344592e4ce3eeea5dc86c46b13508",
    "hostServicesJson": "bef2446a14750871e3a696fe9c317ac930b8f0f8c7246efd393a8f0206946124",
    "supervisorJson": "5d39135353a9dc465e412a85ff9ac5ad133cd1d6dff0c816e05e884564043445",
    "receiptFiles": 24,
    "objects": 936,
}
STAGE_DIR = r"C:\ProgramData\Enclave\staging\host-services-hs2-20261021-r3\enclave-host-services-hs2-windows"
STAGING = r"C:\ProgramData\Enclave\staging\hs2-artifacts-20261021"           # created by `transfer`, removed by `cleanup`
MARKER = ".hs2-artifacts-snapshot"                                            # its content: the manifest sha256
PORTS = (18188, 18189, 18153, 18154, 18190)
OPT = r"C:\Program Files\Enclave\host-services\hs2"
TASK_EXE = OPT + r"\bin\hostsvc-supervisor.exe"
# Embedded (not read from local files at run time, so an emergency stop needs no local stage or snapshot). Equal to
# STAGE-SHA256SUMS of archive d0218596... (test_hs2 and the changing phases re-check that equality).
SCRIPT_PINS = {
    "windows/common.ps1": "779498ac137d417c472f324c2f1e5ed3789792d4e62b9bfcb60b88ddd76feb2b",
    "windows/fill-data.ps1": "c327e2f1a272f3b0d2a84bdfd0c4d57ee669bbee37c8252657c71ffb89ac947d",
    "windows/start.ps1": "21167adf3ee4a8b7a25697f3d71ba8c0154f3fadddf998ee607d42d6a86e84bd",
    "windows/health.ps1": "e203ce1cd52d923d8d7492305c9851dea53b4c14af3d195d3c0ba37180333d93",
    "windows/stop.ps1": "4efd8647e134b6663681bf274be8b39056b725798aba673f6608882446f9376e",
    "windows/rollback.ps1": "75e9536392085bc3e502df14132f2bc4057cbc35c38729c1d1a1c8dff2daa8d3",
}
BIN_PINS = {"bin/stage-tool.mjs": "9edddf920c36d8a2a8330258869655e2041c84e531138e36f20793ea49e6cf23",
            "bin/hostsvc-supervisor.exe": "42be59ff5fef8bbc35654ac4240b09fbb71ed0c735ae0bd4da1154c170da37b1"}
# what each remote action executes: verified IN THE SAME SESSION right before it runs (staged scripts + installed binaries)
RUNS = {"fill": ("windows/common.ps1", "windows/fill-data.ps1", "bin/stage-tool.mjs"),
        "start": ("windows/common.ps1", "windows/start.ps1", "windows/health.ps1", "bin/stage-tool.mjs", "bin/hostsvc-supervisor.exe"),
        "stop": ("windows/common.ps1", "windows/stop.ps1", "bin/hostsvc-supervisor.exe"),
        "rollback": ("windows/common.ps1", "windows/rollback.ps1", "windows/stop.ps1", "bin/hostsvc-supervisor.exe")}
def remote_path(rel):
    """windows/* run from the extracted stage; bin/* are the INSTALLED binaries those scripts call."""
    return (STAGE_DIR + "\\" + rel.replace("/", "\\")) if rel.startswith("windows/") else (OPT + "\\" + rel.replace("/", "\\"))
def pins_for(action):
    return [(remote_path(r), {**SCRIPT_PINS, **BIN_PINS}[r]) for r in RUNS[action]]
# stage-1 health (stage-tool health, sample mode) for this exact configuration: zone app.enclave.host, 4 static labels,
# 936 manifest objects. Each must appear exactly once, as PASS; nothing else may appear.
EXPECTED_HEALTH = (
    "gate: platform host policy admits this host now",
    "directory-replica /health",
    "bootstrap-replica serves the manifest (1 verified by sha256, 936 by HEAD size)",
    "route-dns answers SOA and NS for app.enclave.host (authoritative, NOERROR)",
    "route-dns answers 4 static platform label(s) with their configured addresses",
    "policy-mirror /health (agrees with the book's anchor; serves the anchored document)",
)
SCRIPTS = ("windows/common.ps1", "windows/fill-data.ps1", "windows/start.ps1", "windows/health.ps1", "windows/stop.ps1", "windows/rollback.ps1")
GiB = 1 << 30
DISK_FLOOR = 16 * GiB          # the installer's own headroom rule, kept after this phase's writes
RAM_FLOOR_MIB = 17920          # the installer's RAM rule (start adds <= 1024 MiB job commit)
PHASES = ("dry-run", "transfer", "fill", "start", "cleanup", "stop", "rollback")


def staging_path_ok(p=STAGING):
    """The staging dir is a fixed, canonical child of the staging root and overlaps no production stage path."""
    low = p.lower()
    return (bool(re.fullmatch(r"c:\\programdata\\enclave\\staging\\hs2-artifacts-\d{8}", low))
            and not low.startswith(r"c:\programdata\enclave\host-services") and not low.startswith(r"c:\program files"))


def expected_files(manifest):
    """manifest -> {name: size or None} of the 2 x 936 objects (.car sizes are not in the manifest: None = any size)."""
    out = {}
    for e in manifest["verifiedObjects"]:
        out[e["cid"] + ".bin"] = int(e["bytes"]); out[e["cid"] + ".car"] = None
    return out


def plan_transfer(local_sizes, remote_listing, marker):
    """Which files to (re)send. local_sizes {name: size} (the verified local snapshot); remote_listing {name: size} of the
    staging dir (None = absent). Refuses a staging dir it did not create, and any file that is not one of ours.
    -> (to_send[], refusals[])"""
    refusals = []
    if remote_listing is None:
        return sorted(local_sizes), []
    if marker != PINS["manifestSha256"]:
        refusals.append(f"staging dir {STAGING} exists but is not this helper's (marker {marker!r}); refused, nothing sent")
        return [], refusals
    extra = sorted(set(remote_listing) - set(local_sizes) - {MARKER})
    if extra:
        refusals.append(f"staging dir holds {len(extra)} file(s) that are not snapshot objects (e.g. {extra[0]}); refused")
        return [], refusals
    return sorted(n for n, s in local_sizes.items() if remote_listing.get(n) != s), []


def staging_complete(local_sizes, remote_listing, marker):
    return (remote_listing is not None and marker == PINS["manifestSha256"]
            and all(remote_listing.get(n) == s for n, s in local_sizes.items())
            and not (set(remote_listing) - set(local_sizes) - {MARKER}))


def evaluate(probe, phase, *, local_sizes=None, fill_done=False):
    """The remote preflight for `phase`. probe: the read-only probe result. -> refusals[] (empty = proceed)."""
    assert phase in PHASES, phase
    r = []
    need = lambda cond, msg: (None if cond else r.append(msg))
    need(probe.get("sessionElevated") is True, "the SSH session is not elevated (the stage scripts require Administrator)")
    if phase not in ("rollback", "stop"):          # stopping/rolling back must work even after drift
        need(probe.get("receiptLast") == "complete" and probe.get("receiptSha256") == PINS["receiptSha256"], "the install receipt is not the verified one")
        need(probe.get("receiptFilesMatch") == PINS["receiptFiles"] and not probe.get("receiptFilesBad"), "installed files do not match the receipt")
        need(probe.get("hostServicesJson") == PINS["hostServicesJson"] and probe.get("supervisorJson") == PINS["supervisorJson"], "the installed configuration changed")
        need(probe.get("manifestSha256") == PINS["manifestSha256"], "the installed bootstrap manifest is not the pinned one")
        need(probe.get("taskPrincipal") == "LOCAL SERVICE" and probe.get("taskRealTriggers") == 0, "the task is not the installed manual LOCAL SERVICE task")
        m = re.fullmatch(r"v(\d+)\.\d+\.\d+", str(probe.get("node", "")))
        need(bool(m) and int(m.group(1)) >= 22, "node >= 22 is required")
        for s in SCRIPTS:
            need((probe.get("scripts") or {}).get(s) == SCRIPT_PINS[s], f"the staged {s} is not the reviewed one")
    running = probe.get("taskState") == "Running"
    quiet = probe.get("taskState") == "Ready" and probe.get("hs2NodeProcesses") == 0 and probe.get("supervisorProcesses") == 0 and probe.get("stageToolProcesses", 0) == 0
    free_disk = int(probe.get("freeDiskMiB", 0)) * (1 << 20)
    total_bin = sum(s for s in (local_sizes or {}).values())
    if phase in ("dry-run", "transfer"):
        if phase == "transfer": need(quiet, "the stage must be stopped (task Ready, no hs2 process)")
        listing = probe.get("staging")
        to_send, refs = plan_transfer(local_sizes or {}, listing, probe.get("stagingMarker"))
        r.extend(refs)
        need(free_disk - sum((local_sizes or {})[n] for n in to_send) >= DISK_FLOOR, "not enough free disk for the staging copy plus the 16 GiB floor")
    if phase == "fill":
        need(quiet, "the stage must be stopped (task Ready, no hs2 process) while its data is filled")
        need(staging_complete(local_sizes or {}, probe.get("staging"), probe.get("stagingMarker")), "the staging copy is not complete: run transfer first")
        need(free_disk - max(0, total_bin - int(probe.get("artifactsBytes", 0))) >= DISK_FLOOR, "not enough free disk for the artifacts plus the 16 GiB floor")
    if phase == "start":
        need(quiet, "the stage is already running or has a process left; stop it first")
        need(probe.get("artifactsFiles") == 2 * PINS["objects"], f"artifacts not filled ({probe.get('artifactsFiles')} of {2 * PINS['objects']} files): run fill first")
        need(probe.get("artifactsOther") == 0, "the artifacts dir holds non-object files (an interrupted fill's temporaries?): re-run fill, or roll back")
        need(fill_done is True, "no successful fill receipt from this helper: run fill first")
        need(probe.get("tcpListenOnStagePorts") == 0 and probe.get("udpOnStagePorts") == 0, "a stage port is already in use")
        need(int(probe.get("freeRamMiB", 0)) >= RAM_FLOOR_MIB, "free RAM below the installer's floor")
    if phase == "cleanup":
        need(probe.get("artifactsFiles") == 2 * PINS["objects"], "the artifacts are not complete: the staging copy is still the source; refused")
        need(probe.get("stagingMarker") == PINS["manifestSha256"] or probe.get("staging") is None, "the staging dir is not this helper's; refused")
    if phase == "stop":
        pass                                        # stop.ps1 is safe in every state (it proves the ports are closed)
    return r


def validate_fill(art_rc, art, pol_rc, pol, artifacts_files, artifacts_other=0):
    """fill-data artifacts + policy results -> refusals[]. art/pol: the tool's JSON (or None)."""
    r = []
    n = 2 * PINS["objects"]
    if art_rc != 0 or not isinstance(art, dict): r.append(f"fill-data artifacts failed (exit {art_rc})")
    else:
        if art.get("manifestSha256") != PINS["manifestSha256"]: r.append("fill used another manifest")
        if art.get("objects") != PINS["objects"]: r.append("fill saw another object count")
        if art.get("missing"): r.append(f"{len(art['missing'])} object file(s) missing, e.g. {art['missing'][0]}")
        if art.get("fetched", 0) != 0: r.append("fill fetched from a network origin (only the staging copy was allowed)")
        if art.get("kept", 0) + art.get("copied", 0) != n: r.append(f"kept+copied {art.get('kept', 0) + art.get('copied', 0)} != {n}")
    if artifacts_files != n: r.append(f"the artifacts dir holds {artifacts_files} object files, not {n}")
    if artifacts_other: r.append(f"the artifacts dir holds {artifacts_other} non-object file(s) (temporaries of an interrupted copy?)")
    if pol_rc != 0 or not isinstance(pol, dict): r.append(f"fill-data policy failed (exit {pol_rc})")
    elif pol.get("state") == "unanchored":
        if pol.get("wrote") is not None: r.append("an unanchored book must write nothing")
    elif pol.get("state") == "anchored":
        if not str(pol.get("wrote") or "").lower().startswith(r"c:\programdata\enclave\host-services\hs2\data\policy-import" + "\\"):
            r.append("the anchored policy was not written into the stage's policy-import dir")
    else: r.append(f"unexpected policy state {pol.get('state')!r}")
    return r


def check_health(lines):
    """health.ps1 output lines ('PASS|FAIL  <name>  <detail>') -> refusals[]: exactly EXPECTED_HEALTH, each once, all PASS."""
    r, seen = [], {}
    for l in lines:
        st, _, rest = l.partition("  ")
        name = rest.split("  ", 1)[0]
        if st not in ("PASS", "FAIL"): r.append(f"unparseable health line {l[:80]!r}"); continue
        if name not in EXPECTED_HEALTH: r.append(f"unexpected health check {name[:100]!r}"); continue
        if name in seen: r.append(f"duplicate health check {name!r}")
        seen[name] = st
        if st != "PASS": r.append(f"FAIL {name}: {rest[len(name):].strip()[:160]}")
    for name in EXPECTED_HEALTH:
        if name not in seen: r.append(f"missing health check {name!r}")
    return r


def validate_start(start_rc, health_rc, health_lines, listeners, task_state):
    """start.ps1 exit, the re-run health.ps1 exit and lines, the stage-port listeners [(proto, address, port)] and the
    task state -> refusals[]. Loopback-only is a hard guard: stage 1 must not be reachable from the network."""
    r = []
    if start_rc != 0: r.append(f"start.ps1 exit {start_rc} (stage-1 health did not pass in time)")
    if health_rc != 0: r.append(f"health.ps1 exit {health_rc}")
    if task_state != "Running": r.append(f"the task is {task_state}, not Running")
    r.extend(check_health(health_lines or []))
    seen = {(p, port) for p, _, port in listeners}
    for need in [("tcp", 18188), ("tcp", 18189), ("udp", 18153), ("tcp", 18153), ("tcp", 18154), ("tcp", 18190)]:
        if need not in seen: r.append(f"{need[0]}/{need[1]} is not listening")
    exposed = [f"{p}/{a}:{port}" for p, a, port in listeners if a not in ("127.0.0.1",)]
    if exposed: r.append("NOT LOOPBACK-ONLY: " + ", ".join(exposed))
    return r


def quiet(probe):
    """The stage is provably stopped: task not Running, no stage port listening, no hs2 node / supervisor / stage tool."""
    return (probe is not None and probe.get("taskState") in ("Ready", "Disabled", "absent") and not probe.get("listeners")
            and probe.get("tcpListenOnStagePorts", 0) == 0 and probe.get("udpOnStagePorts", 0) == 0
            and probe.get("hs2NodeProcesses") == 0 and probe.get("supervisorProcesses") == 0 and probe.get("stageToolProcesses", 0) == 0)


def parse_tool_json(text):
    """The stage tool prints its result as indented JSON after any progress lines: the LAST top-level object."""
    import json
    lines = text.replace("\r\n", "\n").split("\n")
    for i in range(len(lines) - 1, -1, -1):
        if lines[i] == "{":
            try: return json.loads("\n".join(lines[i:]).strip())
            except ValueError: continue
    return None
