Fresh root evidence 2026-10-22 23:12UTC:
- Source exact error is Linux isolationClaimVerdict, releaseListedFor 5s fetch to https://api.enclave.host/v1/secrets/release-status.
- Running host is local systemd user enclave-metal.service (launcher3480942, QEMU3483499). Do not restart/probe it yourself.
- Actual service is enclave-api-relay on minipc enclave-control VM, PID191173, started2026-10-21T19:24:17Z; /opt/nan-relay/api-relay.js, port8100. Source-only copies retrieved by root in sibling relay-release-live/installed-api-relay.js and installed-secrets-release.mjs. Root remote transport via32423; no worker live actions.
- Effective BASE_RPC is https://base-rpc.publicnode.com. Public settings whitelist in relay-release-live/backend-public-settings.json; explicitlist contains adapter/api-mcp/ipns/jot/risc/eyesoff etc but excludes EnclaveDNS, cron, sia-s3, c13d.
- Public GET23:09: adapter200listedtrue; EnclaveDNS timeout15sec, sameEU IP134.209.248.172.
- Direct backendGET23:12: adapter7ms200true, api-mcp7ms200true, EnclaveDNS652ms200false. No static failure; seems intermittent fullledger read/delivery. Need distinguish backend RPC fullscan bottleneck vs publictransport. Do not infer all10 have samecause.
- Linux journal also has repeated claim refusals for eyesoff and da09d: 422Unaffordable appreserve/caps; transient quorum errors too. Ten other app reserves underfunded in priorfresh3RPC root snapshot; root rechecks separately. Fixing release-status alone does not fund apps.
- Preserve release policy and secret/config isolation. Do not wildcardlist or turn release off. No grant based on failed reads (fleet-auth rowOf catches and returnsnull, potential existingfalse-unlisted nuance).
Root awaits INITIAL/source findings; please use installed modules above as relevant baseline for candidate.
