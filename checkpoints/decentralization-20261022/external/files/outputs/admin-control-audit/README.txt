Admin-control restoration — 2026-10-20

Production contract ownership was never removed. Agreeing read-only Base RPC checks confirmed the admin wallet 0x0b2d009c0c9af05b12100d77f3c815fea822ee61 owns the ledger, app catalog, proof verifier, pay and key-attestation contracts. An administrative operation on each succeeded in eth_call while an unauthorized caller reverted. A separate simulation verified rejection of a live catalog version. Nothing was signed or sent for these checks.

A moderation bypass WAS active in the Windows host. Restored mandatory catalog rejection/delisting/yank checks, preserved private-development visibility, and retained additional host-wallet denials. Patched only three installed files from their exact preflight hashes and restarted only the node. All 10 guest identities and statuses were unchanged. Subsequent health checks showed nine running application records and all nine network routes ready without fallback. Dashboard, EyesOff and adapter returned HTTP 200; adapter was ready with no missing files.

The public website has no All releases bypass tab and retains the original moderation UI. The bypass existed in unreleased client source; that source is corrected. Actual browser component checks verified that ordinary visitors cannot see rejected/yanked/delisted releases, the admin retains review access, and the Deploy button is disabled for those releases. CLI integration checks verified refusal before spending, private pending development, and approved chain-only deployment.

Source commits on PR 9:
7e1336e7 Restore platform moderation alongside host wallet policy
eb977420 Restore catalog moderation in release selection and public listings

The unexecuted ledger plan would have permanently removed admin powers. It is archived and superseded. Current plan2/replay require retained admin ownership and operations; calldata checks reject ownership transfers away from the admin, renunciation and missing acceptance. Three focused tests pass. A full revised fork rehearsal timed out fetching historical RPC state, so no new migration plan is approved or represented as fully rehearsed.

Evidence files in this directory:
live.json — five production ownership/operation checks
catalog-rejection-simulation.json — actual admin catalog rejection simulation
windows-before.json / windows-after.json — installed hashes and guest inventory
windows-activation.json — bounded node activation
runtime-preflight.json — current running deployments pass restored policy
windows-health.json / post-activation-http.json — post-activation service checks
catalog-browser-tests.json — actual browser component behavior
public-catalog-ui.json — public site has no bypass tab

Full decentralization is not complete. Platform-wide malicious-host enforcement, the complete admin-retaining migration rehearsal, and the previously recorded architecture/feature-parity work remain. These findings do not claim every admin workflow has been verified.
