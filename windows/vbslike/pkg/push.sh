#!/bin/sh
# push.sh <packed dir> [ssh host] -- copy a packed package (pkg.mjs pack) into the box's stage root, as
# C:\Users\claude\vbs-like\pkg\<id16>\, WITHOUT the files the manifest marks boxReuse: the box already holds those
# bytes (the 125 MB image, the monitor initrd, the WSL kernel, its own launcher) and stage.ps1 copies them there
# after they hash to the pin. One tar over scp, unpacked by the box's tar.exe: nothing is piped through PowerShell.
#
# Writes only that one directory on the box, and refuses if it exists (a package directory is written once). It runs
# nothing else there: staging and checking are stage.ps1 and check.ps1, run by whoever owns the box's next step.
set -eu
DIR=${1:?usage: push.sh <packed dir> [ssh host]}
HOST=${2:-minipc-zt}
DIR=$(cd "$DIR" && pwd)
ID16=$(basename "$DIR")
MAN="$DIR/MANIFEST.json"
[ -f "$MAN" ] || { echo "no MANIFEST.json in $DIR" >&2; exit 2; }
ID=$(sha256sum "$MAN" | cut -c1-64)
[ "$(echo "$ID" | cut -c1-16)" = "$ID16" ] || { echo "the directory is $ID16 but the manifest id is $ID" >&2; exit 2; }
REMOTE="C:/Users/claude/vbs-like/pkg/$ID16"
WIN_REMOTE=$(echo "$REMOTE" | tr / '\\')

LIST=$(mktemp); TAR=$(mktemp --suffix=.tar); trap 'rm -f "$LIST" "$TAR"' EXIT
node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const skip = new Set(m.files.filter((f) => f.boxReuse).map((f) => f.path));
  const out = ["MANIFEST.json", ...m.files.filter((f) => !skip.has(f.path) && !("box" in f.from)).map((f) => f.path)];
  console.log(out.join("\n"));' "$MAN" > "$LIST"
tar -C "$DIR" -cf "$TAR" -T "$LIST"
echo "sending $(wc -l < "$LIST") files ($(du -h "$TAR" | cut -f1)) to $HOST:$REMOTE; boxReuse files are staged on the box"

ps() { ssh -o ConnectTimeout=20 "$HOST" "powershell -NoProfile -EncodedCommand $(printf '%s' "$1" | iconv -f utf-8 -t utf-16le | base64 -w0)"; }
ps "if (Test-Path '$WIN_REMOTE') { Write-Output 'EXISTS'; exit 3 }; New-Item -ItemType Directory -Path '$WIN_REMOTE' | Out-Null; Write-Output 'CREATED'" 2>/dev/null \
  | tr -d '\r' | grep -qx CREATED || { echo "refusing: $WIN_REMOTE exists on the box (or could not be created)" >&2; exit 3; }
scp -q -o ConnectTimeout=20 "$TAR" "$HOST:$REMOTE/push.tar"
ps "Set-Location '$WIN_REMOTE'; tar.exe -xf push.tar; \$rc = \$LASTEXITCODE; Remove-Item push.tar; if (\$rc -ne 0) { Write-Output \"tar exit \$rc\"; exit 1 }; Write-Output 'UNPACKED'" 2>/dev/null \
  | tr -d '\r' | grep -qx UNPACKED || { echo "unpacking on the box failed" >&2; exit 1; }
echo "pushed $ID"
echo "next, on the box:"
echo "  powershell -NoProfile -ExecutionPolicy Bypass -File $WIN_REMOTE\\win\\stage.ps1 -ManifestSha256 $ID"
