# accepted-image-enrollment-stage/r3 helper: copy a FROZEN KVM closure (STAGE-ROOT layout, as journal-durability-r2 ships it:
# network/... and test/... next to its SHA256SUMS) into the private repo.
#   python3 -I kvm-overlay.py KVM_DIR REPO -> JSON {overlaid, changed, tests}; exit 1 (nothing copied) on any refusal
# The caller has verified KVM_DIR/SHA256SUMS and its pinned sha256. Rules:
#   * only network/... and test/... entries are considered (API.md, root-test.sh, results/ etc. are not source);
#   * no "..", no symlink, regular files only;
#   * a file OUTSIDE the KVM-owned set must be byte-identical to the repo's (a KVM stage carries unchanged copies of shared
#     modules; anything else would silently change e.g. the pinned shared relay runtime) - otherwise refuse.
import hashlib, json, os, re, shutil, sys

kd, repo = sys.argv[1], sys.argv[2]
OWNED = re.compile(r"^(network/derived-reader/[A-Za-z0-9._/-]+"
                   r"|network/(deployment-lifecycle-journal|deployment-journal-owner|journal-commit|lifecycle-finality-bridge|runtime-lock|lease-release-journal)\.mjs"
                   r"|test/(derived-reader/[A-Za-z0-9._-]+|journal-durability\.test\.mjs|deployment-journal-native\.mjs|deployment-lifecycle-journal\.test\.mjs|lifecycle-finality-bridge\.test\.mjs))$")
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
plan, changed = [], []
for line in open(os.path.join(kd, "SHA256SUMS")):
    if not line.strip():
        continue
    _, rel = line.split(None, 1)
    r = rel.strip().removeprefix("./")
    if not (r.startswith("network/") or r.startswith("test/")):
        continue
    src, dst = os.path.join(kd, r), os.path.join(repo, r)
    if ".." in r.split("/") or os.path.islink(src) or not os.path.isfile(src):
        print(json.dumps({"refused": r, "why": "not a regular in-tree file"})); sys.exit(1)
    same = os.path.isfile(dst) and sha(dst) == sha(src)
    if not OWNED.match(r) and not same:
        print(json.dumps({"refused": r, "why": "outside the KVM-owned set and different from the repo"})); sys.exit(1)
    plan.append((src, dst, r))
    if not same:
        changed.append(r)
if not plan:
    print(json.dumps({"refused": "no network/ or test/ files"})); sys.exit(1)
for src, dst, _ in plan:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
print(json.dumps({"overlaid": sorted(r for _, _, r in plan), "changed": sorted(changed)}))
