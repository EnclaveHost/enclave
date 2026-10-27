# base-state-readonly-stage/r8 namespace hardening (sourced by jobs/build.sh and the ns tests; PREPARED by Claude 1839, NOT run by Claude).
# Call ONLY inside a private `unshare -Urnm` mount namespace. FIRST every mount of this namespace is made private (nothing propagates to
# or from the host), THEN each given directory is bind-mounted read-only over itself IN THIS NAMESPACE ONLY. This is SPECIFIC enforcement
# for the listed paths (r8 build: /home/steven and /tmp); the root filesystem as a whole is NOT made immutable (/var etc. stay writable).
ns_harden() { # DIR...
  mount --make-rprivate / || { echo "## ns_harden: make-rprivate failed"; return 1; }
  local d
  for d in "$@"; do
    mount --bind "$d" "$d" && mount -o remount,bind,ro "$d" || { echo "## ns_harden: read-only bind of $d failed"; return 1; }
  done
}
