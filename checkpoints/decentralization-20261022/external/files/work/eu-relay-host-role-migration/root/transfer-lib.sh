# transfer-lib.sh - ONE opaque, create-only, remote-to-remote file copy (sourced by transfer-relay-files.sh,
# transfer-journal-back.sh and the transport probe). No stdin pipe into PowerShell: the bytes move by standard SFTP
# (`scp -3`: source -> this workstation's memory -> destination). No file is ever written on this workstation, and no file
# content or hash is printed. The only output about a file is its name and "intact" / "MISMATCH" / a refusal.
#   copy_create_only <src alias> <src kind linux|windows> <src path> <dst alias> <dst kind> <dst dir> <final name> [timeout s] [limit Kbit/s]
# (the bandwidth limit exists for the transport probe's interrupted-transfer case; production callers never pass it)
# Steps, each verified:
#   1. the source file exists and is non-empty, the destination directory exists, and NEITHER the final name nor the
#      temporary name exists there (an existing key or journal is never overwritten, and nothing is copied at all);
#   2. scp -3 into a UNIQUE hidden temporary name in that same (protected) directory, bounded by a timeout;
#   3. on any failure the temporary file is removed (retried: Windows can briefly hold the handle) and no final exists;
#   4. the sha256 of the source and of the temporary copy are computed ON EACH HOST and only compared here;
#      a mismatch removes the temporary copy;
#   5. a CREATE-ONLY rename to the final name (Windows [IO.File]::Move, which refuses an existing target; Linux `ln` then
#      `rm`, where ln refuses an existing target), then the final file's sha256 is compared again.
# Paths are fixed by the callers (no user input): Linux absolute paths without spaces or quotes, Windows drive paths
# without quotes. Windows SFTP addresses them as /C:/... with forward slashes.
set -euo pipefail
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3)
# PowerShell commands go as -EncodedCommand (base64 UTF-16LE): Win32-OpenSSH hands the remote command line to cmd.exe, which
# would otherwise act on | & > in it. This is argument passing only; no data is piped into PowerShell's stdin (-n).
_ps() { local enc; enc=$(printf '%s' "\$ErrorActionPreference='Stop'; \$ProgressPreference='SilentlyContinue'; $2" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
  ssh -n "${SSHOPT[@]}" "$1" powershell -NoProfile -NonInteractive -EncodedCommand "$enc" | tr -d '\r'; }
_lx() { ssh -n "${SSHOPT[@]}" "$1" "$2"; }
_check_path() {   # kind path: refuse anything that is not a plain fixed path
  case "$1" in
    linux) [[ "$2" =~ ^/[A-Za-z0-9_./-]+$ ]] ;;
    windows) [[ "$2" =~ ^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$ ]] ;;
    *) return 1 ;;
  esac || { echo "refused: unsupported $1 path"; return 2; }
}
_join() { if [ "$1" = windows ]; then printf '%s\\%s' "$2" "$3"; else printf '%s/%s' "$2" "$3"; fi; }
_sftp() { if [ "$1" = windows ]; then printf '/%s' "$(printf '%s' "$2" | tr '\\' '/')"; else printf '%s' "$2"; fi; }
_exists() { if [ "$2" = windows ]; then [ "$(_ps "$1" "Test-Path -LiteralPath '$3'")" = True ]; else _lx "$1" "test -e '$3' || test -L '$3'"; fi; }
_isdir() { if [ "$2" = windows ]; then [ "$(_ps "$1" "Test-Path -LiteralPath '$3' -PathType Container")" = True ]; else _lx "$1" "test -d '$3'"; fi; }
_nonempty() { if [ "$2" = windows ]; then [ "$(_ps "$1" "if ((Test-Path -LiteralPath '$3' -PathType Leaf) -and (Get-Item -LiteralPath '$3').Length -gt 0) { 'yes' }")" = yes ]; else _lx "$1" "test -f '$3' && test -s '$3'"; fi; }
_sha() { if [ "$2" = windows ]; then _ps "$1" "(Get-FileHash -LiteralPath '$3' -Algorithm SHA256).Hash.ToLower()"; else _lx "$1" "sha256sum '$3' | cut -c1-64"; fi; }
_rm() {   # remove OUR temporary file only; retried while a closing SFTP server still holds it
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if [ "$2" = windows ]; then _ps "$1" "if (Test-Path -LiteralPath '$3') { Remove-Item -LiteralPath '$3' -Force }; Test-Path -LiteralPath '$3'" | grep -qx False && return 0
    else _lx "$1" "rm -f '$3'; ! test -e '$3'" && return 0; fi
    sleep 2
  done
  echo "WARNING: the temporary copy $3 on $1 could not be removed: remove it by hand (it holds a copy of the file)"; return 1
}
_commit() {   # create-only rename tmp -> final
  if [ "$2" = windows ]; then _ps "$1" "[IO.File]::Move('$3', '$4'); 'moved'" | grep -qx moved
  else _lx "$1" "chmod 0600 '$3' && ln '$3' '$4' && rm -f '$3'"; fi
}
copy_create_only() {
  local sa=$1 sk=$2 sp=$3 da=$4 dk=$5 dd=$6 name=$7 to=${8:-300} lim=${9:-}
  local limit=(); [ -n "$lim" ] && limit=(-l "$lim")
  _check_path "$sk" "$sp" && _check_path "$dk" "$dd" || return 2
  [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "refused: bad file name"; return 2; }
  local final tmp a b
  final=$(_join "$dk" "$dd" "$name")
  tmp=$(_join "$dk" "$dd" ".incoming-$name-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')")
  _nonempty "$sa" "$sk" "$sp" || { echo "$name: refused: the source file is absent or empty"; return 2; }
  _isdir "$da" "$dk" "$dd" || { echo "$name: refused: the destination directory does not exist"; return 2; }
  if _exists "$da" "$dk" "$final"; then echo "$name: refused: it already exists at the destination (never overwritten; nothing was copied)"; return 2; fi
  if _exists "$da" "$dk" "$tmp"; then echo "$name: refused: the temporary name exists"; return 2; fi
  if ! timeout --signal=TERM --kill-after=10 "$to" scp -3 -q "${limit[@]}" "${SSHOPT[@]}" "$sa:$(_sftp "$sk" "$sp")" "$da:$(_sftp "$dk" "$tmp")" 2>/dev/null; then
    _rm "$da" "$dk" "$tmp" || true
    _exists "$da" "$dk" "$final" && echo "$name: WARNING: a final file exists after a failed transfer" && return 1
    echo "$name: transfer FAILED (interrupted or refused); no final file; the temporary copy was removed"; return 1
  fi
  a=$(_sha "$sa" "$sk" "$sp"); b=$(_sha "$da" "$dk" "$tmp")
  if [ ${#a} -ne 64 ] || [ "$a" != "$b" ]; then _rm "$da" "$dk" "$tmp" || true; echo "$name: MISMATCH (the temporary copy was removed; no final file)"; return 1; fi
  if ! _commit "$da" "$dk" "$tmp" "$final"; then
    _rm "$da" "$dk" "$tmp" || true; echo "$name: refused at the create-only rename (a final appeared meanwhile?): the existing file was not touched"; return 1
  fi
  [ "$(_sha "$da" "$dk" "$final")" = "$a" ] || { echo "$name: MISMATCH after the rename (the final copy is kept for inspection; do not start)"; return 1; }
  _exists "$da" "$dk" "$tmp" && _rm "$da" "$dk" "$tmp" || true
  echo "$name: intact"
}
