#!/bin/bash
# 30-upgrade-v27.sh - final recipe §C1: upgrade 26 -> 27 (stock 2d7a637e -> fence-enclave c67ffa4d) with controller 1543577f
# (ROOT ONLY; prepared, never run by its author). Requires 20-layout.sh PASS and integration r4 PASS.
# ONE command. The controller stops indexd, takes and VERIFIES a fresh backup, switches, starts and checks the digest.
# There is no automatic retry and no rollback here: a failure goes to the final recipe §R.
source "$(dirname "$0")/lib.sh"
source "$P/upgrade-common.sh"
marker 20.PASS
run_step 27 upgrade "$H_FENCE" "$H_STOCK" 26
