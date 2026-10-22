#!/usr/bin/env bash
# Site release, with no host baked in (docs/site-release.md, work/site-release-interface.txt).
#
#   site/deploy.sh prepare --out DIR (--base RELEASE_DIR | --no-base-i-accept-dropping-old-chunks) [--base-built-at ISO]
#       build site/dist, then make ONE content-addressed release from it: the hashed chunks and inline-script CSP hashes
#       of the base stay for 48h after their last build (cached tabs keep working), the installers ride in the tree,
#       and the security headers are derived from the release ledger. Prints the review and the CID to approve.
#   site/deploy.sh fetch --cid CID --gateway URL[,URL] --out DIR [--as-base]
#       the same release (or a base) from any gateway; the bytes must verify to the CID.
#   site/deploy.sh mirror|activate --release DIR --targets FILE --approve CID
#       copy the verified release to every target the operator's targets file names (local roots, kubo nodes), then
#       switch the served link atomically per target, each a fenced, journalled operation (--journal DIR).
#   site/deploy.sh deliver --release DIR --targets FILE --approve CID [--publish FILE --plan-out DIR]
#       mirror to EVERY target (local roots, kubo nodes, ssh hosts running `agent`), then a journalled rollout (a failure
#       is compensated by fenced undo; an unknown outcome is reported PENDING, exit 5, until `resolve`), then optionally
#       publish (a vault session where the protocol allows it, otherwise the owner's exact plan).
#   site/deploy.sh resolve --targets FILE --journal DIR --rollout ID   (after any interrupted rollout)
#   site/deploy.sh rollback --targets FILE --to CID --approve CID   |   prune --targets FILE
#   site/deploy.sh publish-plan --release DIR --publisher-config FILE --deployment ID [--owner ADDR] --out DIR
#       the owner-authorized change of the ipns-publisher's value to /ipfs/<CID> (the same signing identity), as an
#       exact `enclave config set` to sign. Nothing here signs or sends it.
#
# Nothing in this script opens a connection on its own: every destination comes from the operator's arguments.
set -euo pipefail
cd "$(dirname "$0")/.."    # paths below are relative to the repository root

cmd="${1:-}"
[ -n "$cmd" ] || { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
shift

case "$cmd" in
  prepare)
    npm run -s build:site
    commit="$(git rev-parse --short=8 HEAD)"
    dirty=()
    [ -z "$(git status --porcelain -- site cli/install.sh cli/install.ps1 cli/host.ps1)" ] || dirty=(--dirty)
    exec node scripts/site-release/cli.mjs prepare --dist site/dist --installers cli --commit "$commit" "${dirty[@]}" "$@"
    ;;
  fetch|review|verify|mirror|activate|rollback|resolve|prune|publish-plan|deliver|publish|agent)
    exec node scripts/site-release/cli.mjs "$cmd" "$@"
    ;;
  *)
    echo "site/deploy.sh: unknown command '$cmd' (prepare, fetch, review, verify, mirror, activate, deliver, rollback, resolve, prune, publish, publish-plan, agent)" >&2
    exit 2
    ;;
esac
