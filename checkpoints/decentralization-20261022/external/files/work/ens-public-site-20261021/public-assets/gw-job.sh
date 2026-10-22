#!/usr/bin/env bash
cd "$(dirname "$0")"; unshare -rn bash -c "ip link set lo up && bash run-gw.sh"; echo "gw-rc=$?"
