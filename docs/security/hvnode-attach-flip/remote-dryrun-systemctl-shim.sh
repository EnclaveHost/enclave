#!/bin/bash
case "$*" in
  "is-active --quiet enclave-api-relay") [ -f /tmp/crash ] && [ -f /tmp/restarted ] && exit 3; exit 0 ;;
  "is-active enclave-api-relay") [ -f /tmp/crash ] && [ -f /tmp/restarted ] && { echo failed; exit 3; }; echo active ;;
  "restart enclave-api-relay") echo "inv-$(date +%s%N)" > /tmp/inv; echo x >> /tmp/restarts; if [ -f /tmp/restarted ]; then rm -f /tmp/crash; fi; touch /tmp/restarted ;;
  "show enclave-api-relay -p InvocationID --value") cat /tmp/inv 2>/dev/null || echo inv-initial ;;
  "show enclave-api-relay -p NRestarts --value") echo 0 ;;
  "show -p MainPID --value enclave-api-relay") cat /tmp/pid ;;
  *) echo "shim: unexpected systemctl $*" >&2; exit 99 ;;
esac
