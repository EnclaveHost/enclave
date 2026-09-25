#!/bin/sh
# Build the PUBLICATION ARTIFACT of a domain release: rebuild the release from a clean worktree of its commit with
# isolation/m4/domain-release.sh, compare it with the release that is deployed (when given), and pack it as one
# deterministic tarball with a manifest (every file's sha256, the release id, the build commit, the inputs this host
# supplied, and the toolchain). Nothing is published by this script.
#
#   usage: make-artifact.sh <commit> <outdir> [--expect <deployed release dir>] [--firmware <rebuilt OVMF.amdsev.fd>]
#                           [--firmware-versions <versions.txt of that rebuild>] [--notices <dir>]
#   e.g.   make-artifact.sh 0181bce3 ~/enclave-bench/pub/art --expect ~/enclave-prod/release-0181bce3 \
#            --firmware ~/enclave-bench/pub/fw2/OVMF.amdsev.fd --firmware-versions ~/enclave-bench/pub/fw2/versions.txt
#
# --firmware makes the release's firmware.fd the one rebuilt from source (rebuild-firmware.sh) instead of the build
# host's cached file; domain-release.sh still refuses it unless its sha256 is pinned in m4/verifying-firmware.txt.
# --notices adds a directory's THIRD-PARTY-NOTICES.md, INVENTORY.md, SOURCES.md and licenses/ to the tarball (beside
# release/), so the notices travel with the binaries; the manifest lists their sha256 too.
# The worktree is <outdir>/src (a detached `git worktree` of this repository at <commit>); it is left for inspection.
set -e
umask 022   # the tarball records modes: the same on every builder
commit=${1:?usage: make-artifact.sh <commit> <outdir> [--expect dir] [--firmware fd] [--firmware-versions txt]}
out=${2:?usage: make-artifact.sh <commit> <outdir> [--expect dir] [--firmware fd] [--firmware-versions txt]}
shift 2
expect= fw= fwv= notices=
while [ $# -gt 0 ]; do
  case "$1" in
    --expect) expect=$(cd "$2" && pwd); shift 2 ;;
    --firmware) fw=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    --firmware-versions) fwv=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    --notices) notices=$(cd "$2" && pwd); shift 2 ;;
    *) echo "make-artifact.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
full=$(git -C "$repo" rev-parse --verify "$commit^{commit}")
[ ! -e "$out" ] || [ -z "$(ls -A "$out")" ] || { echo "make-artifact.sh: $out is not empty" >&2; exit 2; }
mkdir -p "$out"; out=$(cd "$out" && pwd)

echo "== clean worktree at $full"
git -C "$repo" worktree add -q --detach "$out/src" "$full"
[ -z "$(git -C "$out/src" status --porcelain)" ] || { echo "make-artifact.sh: the worktree is not clean" >&2; exit 1; }

echo "== domain-release.sh"
rel=$out/release-$(echo "$full" | cut -c1-8)
[ -z "$fw" ] || export OVMF="$fw"   # m1/domain.env takes OVMF from the environment when it is set
(cd "$out/src" && sh isolation/m4/domain-release.sh "$rel") | tee "$out/domain-release.out"
id=$(awk '/^release /{print $2}' "$out/domain-release.out")
python3 "$out/src/isolation/m4/release-manifest.py" verify "$rel" --expect "$id"

if [ -n "$expect" ]; then
  echo "== compare with the deployed release $expect"
  (cd "$expect" && find . -printf '%y %m %p\n' | sort -k3) > "$out/expected.tree"
  (cd "$rel" && find . -printf '%y %m %p\n' | sort -k3) > "$out/rebuilt.tree"
  (cd "$expect" && find . -type f | sort | xargs sha256sum) > "$out/expected.sha256"
  (cd "$rel" && find . -type f | sort | xargs sha256sum) > "$out/rebuilt.sha256"
  if diff "$out/expected.tree" "$out/rebuilt.tree" && diff "$out/expected.sha256" "$out/rebuilt.sha256"; then
    echo "IDENTICAL: $(wc -l < "$out/rebuilt.sha256") files, the same tree and modes as $expect"
  else
    echo "DIFFERENT from $expect (above)"; exit 1
  fi
fi

echo "== manifest and tarball"
epoch=$(git -C "$repo" log -1 --format=%ct "$full")
name=enclave-domain-release-$(echo "$id" | cut -c1-12)
python3 - "$rel" "$out/PUBLICATION-MANIFEST.json" "$full" "$id" "$epoch" "$fwv" "${fw:-}" "$notices" <<'EOF'
import hashlib, json, os, subprocess, sys
rel, dst, commit, rid, epoch, fwv, fw, notices = sys.argv[1:9]
def sh(*a):
    try: return subprocess.run(a, capture_output=True, text=True).stdout.strip()
    except FileNotFoundError: return None
def owner(p): return (sh("pacman", "-Qo", p) or "").split(" is owned by ")[-1] or None
def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()
files = {}
for dp, dns, fns in os.walk(rel):
    for f in fns:
        p = os.path.join(dp, f); r = os.path.relpath(p, rel)
        files[r] = {"sha256": sha(p), "size": os.path.getsize(p), "mode": oct(os.stat(p).st_mode & 0o777)}
# where each host-supplied file came from: the installed file it equals, and the package that owns that file
kernel = sh("sh", "-c", "for v in /usr/lib/modules/*/vmlinuz; do cmp -s $v /boot/vmlinuz-linux && echo $v; done")
host = {"kernel": {"copiedFrom": "/boot/vmlinuz-linux", "equals": kernel, "package": owner(kernel) if kernel else None}}
# the modules come from the GUEST kernel's tree (m1/domain.env), never another installed kernel's: the one whose
# vmlinuz the release's kernel equals, and each module must equal the file it is attributed to
krel = os.path.basename(os.path.dirname(kernel)) if kernel else None
for k in sorted(files):
    if k.endswith(".ko.zst"):
        src = sh("sh", "-c", f"find /usr/lib/modules/{krel}/kernel -name {os.path.basename(k)}") if krel else ""
        same = bool(src) and "\n" not in src and sha(src) == files[k]["sha256"]
        host[k] = {"copiedFrom": src if same else None, "package": owner(src) if same else None}
        if not same: sys.exit(f"make-artifact: {k} does not equal a file in /usr/lib/modules/{krel}")
wt = os.path.realpath(sh("sh", "-c", "command -v wasmtime"))
host["template/rt/wasmtime"] = {"copiedFrom": wt, "package": owner(wt)}
for lib in ["libc.so.6", "libm.so.6", "libgcc_s.so.1", "ld-linux-x86-64.so.2"]:
    src = os.path.realpath("/usr/lib/" + lib)
    host["template/rt/" + lib] = {"copiedFrom": src, "package": owner(src)}
m = {
  "format": "enclave-domain-release-publication/1",
  "release": {"id": rid, "manifest": "release/release.json", "commit": commit, "commitTime": int(epoch)},
  "files": {("release/" + k): v for k, v in sorted(files.items())},
  "hostInputs": host,
  "toolchain": {
    "packages": {p: sh("pacman", "-Q", p) for p in ["linux", "glibc", "gcc", "gcc-libs", "libgcc", "go", "wasmtime", "grub", "dosfstools", "zstd", "python"]},
    "gcc": sh("gcc", "--version").splitlines()[0],
    "go": sh("go", "version"), "goExperiment": sh("go", "env", "GOEXPERIMENT"),
    "python3": sh("python3", "--version"),
  },
  "notices": ({r: sha(os.path.join(notices, r)) for r in sorted(
      [x for x in ("THIRD-PARTY-NOTICES.md", "INVENTORY.md", "SOURCES.md") if os.path.exists(os.path.join(notices, x))] +
      [os.path.relpath(os.path.join(dp, f), notices) for dp, _, fs in os.walk(os.path.join(notices, "licenses")) for f in fs])}
      if notices else {}),
  "firmware": {"source": "rebuilt from source (rebuild-firmware.sh)" if fw else "the build host's cached OVMF.amdsev.fd",
               **({"rebuildVersions": open(fwv).read().splitlines()} if fwv else {})},
}
json.dump(m, open(dst, "w"), indent=1, sort_keys=True); open(dst, "a").write("\n")
EOF
mkdir -p "$out/pack/$name"
cp -a "$rel" "$out/pack/$name/release"
cp "$out/PUBLICATION-MANIFEST.json" "$out/pack/$name/"
if [ -n "$notices" ]; then
  for f in THIRD-PARTY-NOTICES.md INVENTORY.md SOURCES.md; do [ ! -f "$notices/$f" ] || cp "$notices/$f" "$out/pack/$name/"; done
  cp -r "$notices/licenses" "$out/pack/$name/licenses"
  chmod -R u=rwX,go=rX "$out/pack/$name/licenses"
fi
(cd "$out/pack" && tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --format=posix \
   --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime -cf - "$name") | xz -9 -T1 > "$out/$name.tar.xz"
rm -rf "$out/pack"
(cd "$out" && sha256sum "$name.tar.xz" > "$name.tar.xz.sha256" && cat "$name.tar.xz.sha256")
echo "== rebuild: sh isolation/release-publication/make-artifact.sh $full <outdir>${expect:+ --expect <deployed release dir>}${fw:+ --firmware <rebuilt OVMF.amdsev.fd> --firmware-versions <its versions.txt>}${notices:+ --notices <notices dir>}"
