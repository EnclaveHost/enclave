#!/usr/bin/env bash
# Repoint the running Tinfoil enclaves at a freshly published release tag —
# the automated replacement for clicking Update in the Tinfoil dashboard.
#
#   TINFOIL_API_KEY=admin_... scripts/tinfoil-update-fleet.sh vX.Y.Z[-cpu|-gpu8]
#
# The whole fleet lives under one Tinfoil repo deployment; flavor is encoded in
# each instance's tag suffix (plain = gpu, -cpu, -gpu8). Only instances whose
# CURRENT tag carries the new tag's suffix are updated, cross-checked against
# the instance's GPU count (gpu=1, cpu=0, gpu8=8) — a mismatch is skipped, not
# guessed at.
#
# Updates are Tinfoil blue-green rollouts with platform health checks;
# --staging false forces auto-promotion. CPU/single-GPU instances update with
# zero downtime; gpus>1 (gpu8) stop-then-start, so expect a gap. Secrets,
# variables, and domains carry over — but a release that introduces a NEW
# secret NAME still needs a manual bind + relaunch (Tinfoil binds secret names
# at container creation, not on update).
#
# Env: DRY_RUN=1 (print the plan, change nothing), TIMEOUT_SEC (default 2700),
#      ENCLAVE_TINFOIL_REPO (default EnclaveHost/enclave).
set -euo pipefail

TAG="${1:-}"
REPO="${ENCLAVE_TINFOIL_REPO:-EnclaveHost/enclave}"
TIMEOUT_SEC="${TIMEOUT_SEC:-2700}"
POLL_SEC="${POLL_SEC:-20}"
CLI_VERSION=0.14.7

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-cpu|-gpu8)?$ ]]; then
  echo "usage: $0 vX.Y.Z[-cpu|-gpu8]" >&2
  exit 2
fi
: "${TINFOIL_API_KEY:?TINFOIL_API_KEY (admin_...) is required}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

case "$TAG" in
  *-cpu)  FLAVOR=cpu;  WANT_GPUS=0 ;;
  *-gpu8) FLAVOR=gpu8; WANT_GPUS=8 ;;
  *)      FLAVOR=gpu;  WANT_GPUS=1 ;;
esac

# Pinned, checksum-verified CLI install — this script runs holding an admin
# key, so no `curl | sh` of a moving branch.
ensure_cli() {
  command -v tinfoil >/dev/null && return
  local os arch plat sum dir
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS $(uname -s)" >&2; exit 2 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 2 ;; esac
  plat="${os}_${arch}"
  case "$plat" in
    linux_amd64)  sum=5092dff20b5b34af7958d7dbebd5427566beda27e9a6d6a4fccbee31b8187b3b ;;
    linux_arm64)  sum=e1fb893c0d6392aee936a1fb046c15f6125e4d9dd6faad4fd7ed5a066235c281 ;;
    darwin_amd64) sum=1fd2de7d876d726cc0c5f46169f0d60a1f62ca420ed144eee433167edd106f03 ;;
    darwin_arm64) sum=9464bc2f4018e16f118d24d3e28688039be8aea63d3b8372fdbb7fbba8afa57a ;;
  esac
  dir=$(mktemp -d)
  curl -fsSL -o "$dir/cli.tar.gz" \
    "https://github.com/tinfoilsh/tinfoil-cli/releases/download/v${CLI_VERSION}/tinfoil-cli_${CLI_VERSION}_${plat}.tar.gz"
  if command -v sha256sum >/dev/null; then
    echo "$sum  $dir/cli.tar.gz" | sha256sum -c - >/dev/null
  else
    echo "$sum  $dir/cli.tar.gz" | shasum -a 256 -c - >/dev/null
  fi
  tar -xzf "$dir/cli.tar.gz" -C "$dir" tinfoil
  PATH="$dir:$PATH"
  echo "installed tinfoil-cli v${CLI_VERSION} (${plat}) to $dir"
}
ensure_cli

echo "== fleet update: $REPO -> $TAG (flavor=$FLAVOR, want gpus=$WANT_GPUS) =="
LIST=$(tinfoil container list -o json)

# id|name|status|current_tag|update_tag|update_status|staging|gpus|domain
ROWS=$(jq -r --arg repo "$REPO" --arg flavor "$FLAVOR" '
  def flavor(t): if (t // "") == "" then ""
    elif (t|endswith("-cpu")) then "cpu"
    elif (t|endswith("-gpu8")) then "gpu8"
    else "gpu" end;
  .[]
  | select((.repo // "" | ascii_downcase) == ($repo | ascii_downcase))
  | select(flavor(.current_tag) == $flavor)
  | [.id, .name, (.status // "" | ascii_downcase), (.current_tag // ""),
     (.update_tag // ""), (.update_status // "" | ascii_downcase),
     (.staging // false | tostring), (.gpus // 0 | tostring), (.domain // "")]
  | join("|")' <<<"$LIST")

declare -A NAME=() DOMAIN=() STATE=()   # STATE: initiate|watch|uptodate
INITIATE=()
while IFS='|' read -r id name status cur utag ustat staging gpus domain; do
  [ -n "$id" ] || continue
  NAME[$id]=$name; DOMAIN[$id]=$domain
  if [ "$staging" = "true" ]; then
    echo "SKIP  $name: staging instance"
  elif [ "$gpus" != "$WANT_GPUS" ]; then
    echo "SKIP  $name: gpus=$gpus does not match flavor $FLAVOR (want $WANT_GPUS) — resolve in the dashboard"
  elif [ "$status" = "stopped" ] || [ "$status" = "stopping" ]; then
    echo "SKIP  $name: $status — start it on the new tag: tinfoil container start $name --tag $TAG"
  elif [ "$status" = "failed" ]; then
    echo "SKIP  $name: failed — relaunch it: tinfoil container relaunch $name --tag $TAG"
  elif [ "$cur" = "$TAG" ] && [ -z "$utag" ]; then
    echo "OK    $name: already on $TAG"
    STATE[$id]=uptodate
  elif [ "$utag" = "$TAG" ]; then
    echo "WATCH $name: update to $TAG already in progress ($ustat)"
    STATE[$id]=watch
  else
    if [ -n "$utag" ]; then
      echo "WARN  $name: another update in flight ($utag/$ustat); requesting $TAG anyway"
    fi
    echo "PLAN  $name: $cur -> $TAG"
    STATE[$id]=initiate
    INITIATE+=("$id")
  fi
done <<<"$ROWS"

PENDING=()
for id in "${!STATE[@]}"; do
  [ "${STATE[$id]}" != "uptodate" ] && PENDING+=("$id")
done

if [ ${#PENDING[@]} -eq 0 ] && [ ${#INITIATE[@]} -eq 0 ]; then
  echo "nothing to do: no $FLAVOR instances of $REPO need updating"
  exit 0
fi
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1 — no updates initiated"
  exit 0
fi

FAILED=()
if [ ${#INITIATE[@]} -gt 0 ]; then
  ARGS=()
  for id in "${INITIATE[@]}"; do ARGS+=(--instance "$id"); done
  set +e
  RESP=$(tinfoil deployment update "$REPO" --tag "$TAG" --staging false "${ARGS[@]}" -o json)
  RC=$?
  set -e
  if [ -z "$RESP" ]; then
    echo "deployment update returned nothing (rc=$RC)" >&2
    exit 1
  fi
  # per-instance verdicts; "failed"/"skipped" never started, everything else polls
  while IFS='|' read -r id status err; do
    [ -n "$id" ] || continue
    if [ "$status" = "failed" ] || [ "$status" = "skipped" ]; then
      echo "FAIL  ${NAME[$id]:-$id}: update not initiated ($status: $err)"
      FAILED+=("$id")
      unset "STATE[$id]"
    fi
  done < <(jq -r '.results[]? | [.container_id, (.status // ""), (.error // "")] | join("|")' <<<"$RESP")
fi

# Poll until every pending instance is promoted (current_tag flipped, no
# in-progress update) and its supervisor answers /v1/health through the shim.
declare -A HEALTHY=()
DEADLINE=$((SECONDS + TIMEOUT_SEC))
while :; do
  REMAINING=()
  for id in "${!STATE[@]}"; do
    [ "${STATE[$id]}" = "uptodate" ] && continue
    name=${NAME[$id]:-$id}
    if ! C=$(tinfoil container get "$id" -o json 2>/dev/null); then
      echo "…     $name: controlplane read failed (transient?), retrying"
      REMAINING+=("$id"); continue
    fi
    # err is last: it may contain spaces and read soaks the remainder there
    read -r cur utag ustat status domain err < <(jq -r \
      '[(.current_tag // "-"), (.update_tag // "-"), (.update_status // "-" | ascii_downcase),
        (.status // "-" | ascii_downcase), (.domain // "-"), (.error_message // "-")]
       | map(if . == "" then "-" else . end) | join(" ")' <<<"$C")
    if [ "$ustat" = "failed" ]; then
      echo "FAIL  $name: update failed — ${err} (old version keeps serving; see dashboard)"
      FAILED+=("$id"); unset "STATE[$id]"; continue
    fi
    if [ "$cur" = "$TAG" ] && [ "$utag" = "-" ]; then
      if [ "$status" = "failed" ]; then
        echo "FAIL  $name: promoted to $TAG but container status=failed — ${err}"
        FAILED+=("$id"); unset "STATE[$id]"; continue
      fi
      [ "$domain" != "-" ] || domain=${DOMAIN[$id]}
      if [ -n "$domain" ] && [ "$domain" != "-" ]; then
        if curl -fsS --max-time 10 "https://${domain}/v1/health" >/dev/null 2>&1; then
          echo "DONE  $name: $TAG live and healthy (https://${domain}/v1/health)"
          HEALTHY[$id]=1; unset "STATE[$id]"; continue
        fi
        echo "…     $name: promoted to $TAG, waiting for /v1/health on $domain"
        REMAINING+=("$id"); continue
      fi
      echo "DONE  $name: $TAG live (no domain to probe)"
      HEALTHY[$id]=1; unset "STATE[$id]"; continue
    fi
    echo "…     $name: status=$status current=$cur update=${utag}/${ustat}"
    REMAINING+=("$id")
  done
  [ ${#REMAINING[@]} -eq 0 ] && break
  if [ $SECONDS -ge $DEADLINE ]; then
    for id in "${REMAINING[@]}"; do
      echo "FAIL  ${NAME[$id]:-$id}: timed out after ${TIMEOUT_SEC}s"
      FAILED+=("$id")
    done
    break
  fi
  sleep "$POLL_SEC"
done

echo "== summary: ${#HEALTHY[@]} updated+healthy, ${#FAILED[@]} failed =="
[ ${#FAILED[@]} -eq 0 ] || exit 1
