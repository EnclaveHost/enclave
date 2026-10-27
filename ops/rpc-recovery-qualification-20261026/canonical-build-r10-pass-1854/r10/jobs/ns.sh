# base-state-readonly-stage/r10 namespace hardening (sourced by jobs/build.sh and the ns tests; PREPARED by Claude 1839/1844, NOT run by Claude).
# Call ONLY inside a private `unshare -Urnm` mount namespace (or a nested private one). FIRST every mount of this namespace is made private
# (nothing propagates to or from the host); THEN each given directory is bound over itself RECURSIVELY and READ-ONLY RECURSIVELY (review
# 1841 PB1: mounts inherited into a user namespace are LOCKED, so a non-recursive bind of a dir with submounts is refused; util-linux 2.42
# `--rbind -o ro=recursive` clones the whole subtree and sets MOUNT_ATTR_RDONLY on every mount of it via mount_setattr(AT_RECURSIVE),
# leaving locked flags such as nosuid/nodev as they are); if that one-step form is refused, rbind + `remount,bind,ro=recursive`. Then the
# bound tree is made private again. jobs/bsro_gate.py (ro_tree_ok) VERIFIES the result: every visible mount at/under each dir must be ro.
# This is SPECIFIC enforcement for the listed dirs (the build, since r9: /home/steven and /tmp); the root filesystem as a whole is NOT made immutable.
ns_harden() { # DIR...
  mount --make-rprivate / || { echo "## ns_harden: make-rprivate failed"; return 1; }
  local d
  for d in "$@"; do
    if ! mount --rbind -o ro=recursive "$d" "$d" 2>/dev/null; then
      mount --rbind "$d" "$d" && mount -o remount,bind,ro=recursive "$d" || { echo "## ns_harden: recursive read-only bind of $d failed"; return 1; }
    fi
    mount --make-rprivate "$d" || { echo "## ns_harden: make-rprivate $d failed"; return 1; }
  done
}
