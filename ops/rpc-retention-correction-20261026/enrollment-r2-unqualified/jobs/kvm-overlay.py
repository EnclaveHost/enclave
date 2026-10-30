# accepted-image-enrollment-stage/r2 helper (kvm-check mode): copy a FROZEN KVM closure into the private repo.
#   python3 -I kvm-overlay.py KVM_DIR REPO -> JSON {overlaid, tests}; exit 1 (and nothing more copied) on any refusal
# Only files listed in KVM_DIR/SHA256SUMS under tree/<repo path> (the caller has already verified the SUMS and their pinned
# sha256), only KVM-owned paths, no "..", no symlink. Deletions are not supported: a closure that removes a file must say so.
import json, os, re, shutil, sys

kd, repo = sys.argv[1], sys.argv[2]
OWNED = re.compile(r"^(network/derived-reader/[A-Za-z0-9._/-]+|network/(deployment-lifecycle-journal|lifecycle-finality-bridge|runtime-lock|lease-release-journal)\.mjs"
                   r"|test/(derived-reader|lifecycle-finality-bridge|deployment-lifecycle-journal)[A-Za-z0-9._-]*\.test\.mjs)$")
plan = []
for line in open(os.path.join(kd, "SHA256SUMS")):
    if not line.strip():
        continue
    _, rel = line.split(None, 1)
    rel = rel.strip().removeprefix("./")
    if not rel.startswith("tree/"):
        continue
    r = rel[5:]
    src = os.path.join(kd, rel)
    if ".." in r.split("/") or not OWNED.match(r) or os.path.islink(src) or not os.path.isfile(src):
        print(json.dumps({"refused": r}))
        sys.exit(1)
    plan.append((src, r))
if not plan:
    print(json.dumps({"refused": "no tree/ files"}))
    sys.exit(1)
for src, r in plan:
    dst = os.path.join(repo, r)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
files = sorted(r for _, r in plan)
print(json.dumps({"overlaid": files, "tests": [f for f in files if f.startswith("test/")]}))
