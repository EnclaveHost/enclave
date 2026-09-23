#!/bin/bash
# Wait until no benchmark is running. `pgrep -c` prints 0 AND exits 1 when
# nothing matches, so `$(pgrep -xc X || echo 0)` yields "0\n0" and a string
# compare against "0" never succeeds -- a loop that cannot exit precisely when
# the box is free. Test the exit status instead of parsing a count.
while pgrep -x bench-spec2 >/dev/null; do sleep 10; done
