# user-transfer-lib.sh - ONE opaque, create-only file copy between the eu-central source (ssh as its authorized root alias)
# and THIS machine's user target (sourced). The same discipline as the established transfer-lib.sh copy_create_only, with
# a local end instead of a second remote: standard SFTP (scp), a unique hidden temporary name in the protected directory,
# sha256 computed on each side and only compared here, a create-only rename (`ln`, which refuses an existing target), and
# the final file's sha256 checked again. No file content or hash is printed: only "intact" / "MISMATCH" / a refusal.
# Paths are fixed by the callers. SSH uses the operator's existing configuration and keys; nothing is asked for or shown.
#   copy_from_source <alias> <remote file> <local dir> <final name> [timeout s]     source -> this user's target
#   copy_to_source   <alias> <local file> <remote dir> <final name> [timeout s]     this user's target -> source
set -euo pipefail
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3)
_rx() { ssh -n "${SSHOPT[@]}" "$1" "$2"; }
_plain() { [[ "$1" =~ ^/[A-Za-z0-9_./-]+$ ]] && [[ "$1" != *..* ]]; }
_rand() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
copy_from_source() {
  local sa=$1 sp=$2 dd=$3 name=$4 to=${5:-300} final tmp a b
  _plain "$sp" && _plain "$dd" && [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "$name: refused: unsupported path"; return 2; }
  final=$dd/$name; tmp=$dd/.incoming-$name-$(_rand)
  owned_dir "$dd" || { echo "$name: refused: $dd is not this user's 0700 directory"; return 2; }
  [ ! -e "$final" ] && [ ! -L "$final" ] || { echo "$name: refused: it already exists here (never overwritten; nothing was copied)"; return 2; }
  _rx "$sa" "test -f '$sp' && test -s '$sp' && ! test -L '$sp'" || { echo "$name: refused: the source file is absent, empty or a link"; return 2; }
  if ! ( umask 077; timeout --signal=TERM --kill-after=10 "$to" scp -q "${SSHOPT[@]}" "$sa:$sp" "$tmp" ) 2>/dev/null; then
    rm -f "$tmp"; [ ! -e "$final" ] || { echo "$name: WARNING: a final file exists after a failed transfer"; return 1; }
    echo "$name: transfer FAILED (interrupted or refused); no final file; the temporary copy was removed"; return 1
  fi
  a=$(_rx "$sa" "sha256sum '$sp' | cut -c1-64"); b=$(sha "$tmp")
  if [ ${#a} -ne 64 ] || [ "$a" != "$b" ]; then rm -f "$tmp"; echo "$name: MISMATCH (the temporary copy was removed; no final file)"; return 1; fi
  chmod 0600 "$tmp"
  if ! ln "$tmp" "$final"; then rm -f "$tmp"; echo "$name: refused at the create-only rename (a final appeared meanwhile?): the existing file was not touched"; return 1; fi
  rm -f "$tmp"
  [ "$(sha "$final")" = "$a" ] && owned_file "$final" || { echo "$name: MISMATCH after the rename (the final copy is kept for inspection; do not start)"; return 1; }
  echo "$name: intact"
}
copy_to_source() {
  local sa=$1 lf=$2 rd=$3 name=$4 to=${5:-300} final tmp a b
  _plain "$lf" && _plain "$rd" && [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "$name: refused: unsupported path"; return 2; }
  final=$rd/$name; tmp=$rd/.incoming-$name-$(_rand)
  [ -f "$lf" ] && [ ! -L "$lf" ] && [ -s "$lf" ] || { echo "$name: refused: the local file is absent, empty or a link"; return 2; }
  _rx "$sa" "test -d '$rd' && ! test -L '$rd' && ! test -e '$final' && ! test -L '$final' && ! test -e '$tmp'" || { echo "$name: refused: the source directory is absent or the name exists there (never overwritten)"; return 2; }
  if ! timeout --signal=TERM --kill-after=10 "$to" scp -q "${SSHOPT[@]}" "$lf" "$sa:$tmp" 2>/dev/null; then
    _rx "$sa" "rm -f '$tmp'" || true; echo "$name: transfer FAILED; no final file; the temporary copy was removed"; return 1
  fi
  a=$(sha "$lf"); b=$(_rx "$sa" "sha256sum '$tmp' | cut -c1-64")
  if [ "$a" != "$b" ]; then _rx "$sa" "rm -f '$tmp'" || true; echo "$name: MISMATCH (the temporary copy was removed; no final file)"; return 1; fi
  _rx "$sa" "chmod 0600 '$tmp' && ln '$tmp' '$final' && rm -f '$tmp'" || { _rx "$sa" "rm -f '$tmp'" || true; echo "$name: refused at the create-only rename: the existing file was not touched"; return 1; }
  [ "$(_rx "$sa" "sha256sum '$final' | cut -c1-64")" = "$a" ] || { echo "$name: MISMATCH after the rename (kept for inspection; do not restore)"; return 1; }
  echo "$name: intact"
}
