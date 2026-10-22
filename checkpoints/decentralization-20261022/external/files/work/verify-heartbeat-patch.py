"""Reproduce only the heartbeat patch closure on the current dirty checkout.

Never edits main. Run after the worker freezes its patch. A successful receipt
records exact current-main base bytes and candidate bytes for later integration.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

WORK = Path(__file__).resolve().parent
MAIN = WORK / "enclave"
CANDIDATE = WORK / "offchain-heartbeat/tree"
PATCHES = [
    WORK / "offchain-heartbeat/patches/prereq" / (name + ".patch")
    for name in ["supervisor", "dockerfile", "windows-agent"]
] + [WORK / "offchain-heartbeat/patches/offchain-heartbeat.patch"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


paths = set()
patch_hashes = {}
filtered = []
already_integrated = []
for patch in PATCHES:
    patch_hashes[str(patch.relative_to(WORK))] = digest(patch)
    contents = patch.read_text()
    for line in contents.splitlines():
        if line.startswith(("--- a/", "+++ b/")):
            name = line[6:].split("\t")[0]
            if Path(name).is_absolute() or ".." in Path(name).parts:
                raise RuntimeError("Unsafe patch path: " + name)
            paths.add(name)
    kept = []
    for part in re.split(r"(?=^--- )", contents, flags=re.MULTILINE):
        if not part:
            continue
        lines = part.splitlines()
        if lines[0] == "--- /dev/null" and len(lines) > 1 and lines[1].startswith("+++ b/"):
            name = lines[1][6:].split("\t")[0]
            if (MAIN / name).exists():
                if digest(MAIN / name) != digest(CANDIDATE / name):
                    raise RuntimeError("Existing new path differs from candidate: " + name)
                already_integrated.append(name)
                continue
        kept.append(part)
    filtered.append("".join(kept))

base = {name: digest(MAIN / name) for name in sorted(paths)}
with tempfile.TemporaryDirectory(prefix="heartbeat-review-", dir=WORK) as temp:
    root = Path(temp)
    for name in sorted(paths):
        source = MAIN / name
        if source.exists():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    for contents in filtered:
        if not contents:
            continue
        result = subprocess.run(
            ["patch", "--batch", "--forward", "--fuzz=0", "-p1"],
            cwd=root, input=contents, capture_output=True, text=True,
        )
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
    final = {name: digest(root / name) for name in sorted(paths)}
    mismatched = [name for name in sorted(paths) if final[name] != digest(CANDIDATE / name)]
    if mismatched:
        raise RuntimeError("Patch differs from candidate: " + ", ".join(mismatched))

assert base == {name: digest(MAIN / name) for name in sorted(paths)}, "Main changed during verification"
assert all(digest(WORK / name) == value for name, value in patch_hashes.items()), "Patch changed during verification"
integration = WORK / "offchain-heartbeat/root-integration.patch"
integration.write_text("".join(filtered))
receipt = {
    "patches": patch_hashes, "base": base, "final": final,
    "alreadyIntegratedIdentically": already_integrated,
    "integrationPatch": str(integration), "integrationPatchSha256": digest(integration),
    "mainModified": False, "productionActivated": False,
}
out = WORK / "offchain-heartbeat/root-patch-reproduction.json"
out.write_text(json.dumps(receipt, indent=2) + "\n")
print(f"Exact patch reproduction verified for {len(paths)} files; main unchanged.")
