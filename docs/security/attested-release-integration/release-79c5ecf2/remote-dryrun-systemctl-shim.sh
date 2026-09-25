#!/bin/bash
# shim: the api-relay unit, for the rs-4 dry run
case "$*" in
  "is-active --quiet enclave-api-relay") [ -f /tmp/down ] && exit 3; exit 0 ;;
  "restart enclave-api-relay") echo "inv-$(date +%s%N)" > /tmp/inv; echo "restart" >> /tmp/restarts; exit 0 ;;
  "show enclave-api-relay -p InvocationID --value") cat /tmp/inv 2>/dev/null || echo inv-initial ;;
  "show enclave-api-relay -p NRestarts --value") echo 0 ;;
  "show enclave-api-relay -p MemoryMax --value") echo 1610612736 ;;
  *) echo "shim: unexpected systemctl $*" >&2; exit 99 ;;
esac
