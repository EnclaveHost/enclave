# _ntfs.sh -- shared NTFS mount helper.  Source, do not execute.
#
# Windows has been hard-reset repeatedly here, so the volume's dirty flag is
# set and $LogFile holds unreplayed entries.  ntfs3 refuses read-write in that
# state, which is correct: writing over an unreplayed journal risks the replay
# undoing the write, or worse.  Read-only is unaffected, which is why the
# diagnostics worked and the first write attempt did not.
#
# Order of attempts, least invasive first:
#   1. ntfs3 rw                 -- works if the volume is clean
#   2. ntfs-3g rw               -- FUSE driver, slightly more tolerant
#   3. ntfs-3g remove_hiberfile -- only if Fast Startup left a hiberfil.sys
#   4. ntfsfix, then retry      -- replays and resets $LogFile, clears the
#                                  dirty flag, and schedules a chkdsk on the
#                                  next Windows boot.  Announced, never silent.

ntfs_mount() {
  local dev="$1" mnt="$2" mode="${3:-ro}" fixdirty="${4:-0}" err

  if [ "$mode" = ro ]; then
    mount -t ntfs3 -o ro "$dev" "$mnt" 2>/dev/null && { echo "  mounted $dev ro (ntfs3)"; return 0; }
    mount -t ntfs-3g -o ro "$dev" "$mnt" 2>/dev/null && { echo "  mounted $dev ro (ntfs-3g)"; return 0; }
    echo "  could not mount $dev read-only" >&2
    return 1
  fi

  err=$(mount -t ntfs3 -o rw "$dev" "$mnt" 2>&1) && { echo "  mounted $dev rw (ntfs3)"; return 0; }
  echo "  ntfs3 rw refused: $err"
  err=$(mount -t ntfs-3g -o rw "$dev" "$mnt" 2>&1) && { echo "  mounted $dev rw (ntfs-3g)"; return 0; }
  echo "  ntfs-3g rw refused: $err"

  if [ -n "$(ls "$mnt" 2>/dev/null)" ]; then :; fi
  err=$(mount -t ntfs-3g -o rw,remove_hiberfile "$dev" "$mnt" 2>&1) \
    && { echo "  mounted $dev rw (ntfs-3g, hiberfile removed)"; return 0; }
  echo "  ntfs-3g remove_hiberfile refused: $err"

  if [ "$fixdirty" != 1 ]; then
    cat >&2 <<MSG

  The volume is dirty and every read-write mount was refused.

  The standard remedy is ntfsfix, which replays and resets \$LogFile, clears
  the dirty flag, and schedules a chkdsk the next time Windows boots.  It is
  designed for exactly this, but it does modify the filesystem, so it is not
  run without being asked for:

      re-run this command with  --fix-dirty

MSG
    return 1
  fi

  echo "  ==> running ntfsfix (resets \$LogFile, clears the dirty flag,"
  echo "      and schedules a chkdsk on the next Windows boot)"
  ntfsfix "$dev" 2>&1 | sed 's/^/      /'
  err=$(mount -t ntfs3 -o rw "$dev" "$mnt" 2>&1) && { echo "  mounted $dev rw (ntfs3, after ntfsfix)"; return 0; }
  err=$(mount -t ntfs-3g -o rw "$dev" "$mnt" 2>&1) && { echo "  mounted $dev rw (ntfs-3g, after ntfsfix)"; return 0; }
  echo "  still refused after ntfsfix: $err" >&2
  return 1
}
