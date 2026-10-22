#!/usr/bin/env bash
# run-tests.sh [unittest names...]: the mock tests inside an unprivileged user namespace (euid 0 as on the VM, no real
# root, no network use: fake systemctl/docker/pgrep/ssh; real gpg with a throwaway GNUPGHOME). Fixture dirs live under
# test/ (not /tmp, which is RAM) and are removed by each test.
set -uo pipefail
P=$(cd "$(dirname "$0")/.." && pwd); cd "$P/test" || exit 2
# runner tests: inside a user+net namespace (euid 0, no network). Local (workstation) tests: as the normal user - gpg-agent
# cannot start inside the namespace, and the workstation side never needs root; their fake-VM runner call enters a
# namespace itself. Neither uses the network (fake ssh).
unshare --user --map-root-user --net python3 -u -m unittest -v test_runner; a=$?
python3 -u -m unittest -v test_local; b=$?
echo "SUITES runner=$a local=$b"; [ $a -eq 0 ] && [ $b -eq 0 ]
