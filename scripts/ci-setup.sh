#!/usr/bin/env bash
# Provision CI for explicitly selected relay targets. No hosts are discovered or defaulted.
# Required: RELAY_DEPLOY_ROLES, each selected RELAY_{API,DNS}_{TARGET,DIR},
# KEYFILE (dedicated SSH deployment key), DEPLOY_KNOWN_HOSTS_FILE (verified host keys).
# Targets must be reachable names/user@host on the CI runner, not local-only aliases.
# --check-config validates without generating keys, connecting or changing GitHub.
# Site publication uses its separate owner-authorized publication workflow.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
say() { printf '[ci-setup] %s\n' "$*"; }
die() { printf '[ci-setup] %s\n' "$*" >&2; exit 2; }
REPO_SLUG="${REPO_SLUG:-EnclaveHost/enclave}"
[[ "$REPO_SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'REPO_SLUG must be owner/repository'
[[ "${CONTRACTS_NETWORK:-base}" =~ ^[a-z][a-z0-9-]*$ ]] || die 'invalid CONTRACTS_NETWORK'
[ "$#" -le 1 ] && { [ "$#" -eq 0 ] || [ "$1" = --check-config ]; } || die 'usage: ci-setup.sh [--check-config]'
bash "$ROOT/relay/deploy.sh" --check-config
[ -n "${KEYFILE:-}" ] || die 'KEYFILE is required: name a dedicated CI deployment key'
[ -n "${DEPLOY_KNOWN_HOSTS_FILE:-}" ] || die 'DEPLOY_KNOWN_HOSTS_FILE is required: supply independently verified SSH host keys'
[ -f "$DEPLOY_KNOWN_HOSTS_FILE" ] && [ -s "$DEPLOY_KNOWN_HOSTS_FILE" ] || die 'DEPLOY_KNOWN_HOSTS_FILE must be a nonempty regular file'

declare -A SEEN=()
TARGETS=()
read -ra ROLES <<<"${RELAY_DEPLOY_ROLES//,/ }"
for role in "${ROLES[@]}"; do
  var="RELAY_${role^^}_TARGET"; target=${!var}
  if [ -z "${SEEN[$target]:-}" ]; then TARGETS+=("$target"); SEEN[$target]=1; fi
done
for target in "${TARGETS[@]}"; do
  ssh-keygen -F "${target##*@}" -f "$DEPLOY_KNOWN_HOSTS_FILE" >/dev/null ||
    die "verified host key missing for ${target##*@}; no SSH keys or GitHub settings were changed"
done
if [ "${1:-}" = --check-config ]; then
  say "configuration valid for $REPO_SLUG; no keys, servers or GitHub settings changed"
  exit 0
fi
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15
          -o "UserKnownHostsFile=$DEPLOY_KNOWN_HOSTS_FILE")
# Check every host before key generation, key installation or GitHub changes.
for target in "${TARGETS[@]}"; do
  ssh "${SSH_OPTS[@]}" "$target" true ||
    die "cannot reach $target using its verified host key; no keys or GitHub settings were changed"
done
REVIEWER_ID=$(gh api user --jq .id)
REVIEWER_LOGIN=$(gh api user --jq .login)
[[ "$REVIEWER_ID" =~ ^[1-9][0-9]*$ ]] || die 'GitHub did not return a valid reviewer user ID'

if [ ! -e "$KEYFILE" ]; then
  [ ! -e "$KEYFILE.pub" ] || die 'public key exists without its private key; choose an existing pair or a new KEYFILE'
  (umask 077; ssh-keygen -t ed25519 -N '' -C enclave-ci-deploy -f "$KEYFILE")
  say "generated dedicated key at $KEYFILE"
fi
[ -f "$KEYFILE" ] && [ -f "$KEYFILE.pub" ] || die 'KEYFILE and KEYFILE.pub must both be regular files'
PUB=$(cat "$KEYFILE.pub")
[[ "$PUB" != *$'\n'* && "$PUB" != *$'\r'* && "$PUB" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,2}(\ .*)?$ ]] ||
  die 'dedicated deployment public key must be one ssh-ed25519 line'
# Pass public key bytes through stdin, never interpolate them into remote shell code.
for target in "${TARGETS[@]}"; do
  ssh "${SSH_OPTS[@]}" "$target" 'set -eu
    IFS= read -r key
    umask 077
    mkdir -p ~/.ssh
    chmod 700 ~/.ssh
    touch ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
    grep -qxF -- "$key" ~/.ssh/authorized_keys || printf "%s\n" "$key" >> ~/.ssh/authorized_keys' <<<"$PUB" ||
      die "key installation failed on $target; earlier selected hosts may already have the key; GitHub settings were not changed"
  say "CI public key installed on $target"
done
gh secret set DEPLOY_SSH_KEY -R "$REPO_SLUG" < "$KEYFILE"
gh variable set RELAY_DEPLOY_ROLES -R "$REPO_SLUG" -b "$RELAY_DEPLOY_ROLES"
for role in "${ROLES[@]}"; do
  for field in TARGET DIR; do
    var="RELAY_${role^^}_$field"
    gh variable set "$var" -R "$REPO_SLUG" -b "${!var}"
  done
done
gh variable set DEPLOY_KNOWN_HOSTS -R "$REPO_SLUG" < "$DEPLOY_KNOWN_HOSTS_FILE"
gh variable set CONTRACTS_NETWORK -R "$REPO_SLUG" -b "${CONTRACTS_NETWORK:-base}"
# Retain the authenticated administrator's contract-deployment review gate.
gh api -X PUT "repos/$REPO_SLUG/environments/contract-deploy" --input - >/dev/null <<EOF
{"reviewers":[{"type":"User","id":$REVIEWER_ID}]}
EOF
say "configured selected relay roles and contract-deploy reviewer $REVIEWER_LOGIN"
say "No deployment was triggered. Existing unrelated repository variables were left untouched."
say "Still manual: configure DEPLOYER_PRIVATE_KEY in contract-deploy if using CI contract deployment,"
say "and grant the repository Actions write access to its GHCR packages."
