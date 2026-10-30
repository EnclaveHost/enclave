# Actual L1 trial: pre-freeze root review

Status: preparation only. No trial client started and no production consumer changed.

Root independently compared the proposed Reth TOML to the exact observed 2611-byte file. Exactly 23 allowlisted stage/buffer assignments change; pruning, static-file, network and other settings remain unchanged. Native parsing and database startup remain unqualified. The wrapper diff against the reviewed low-memory candidate changes only four private configuration/JWT path assignments; its existing writable-subtree validation is retained.

Root found an actual stale-state cleanup defect in the draft: start_client persisted a launch intent, then main saved its older state and erased that intent. Cleanup would refuse before stopping clients. The author corrected main to refresh state after start_client before recording the returned invocation. Final combined-program and manifest checks are still required.

Review also required separating NBD lifetime from the attachment controller, independent watchdog failure cleanup, nonce-bound transient unit ownership for ambiguous starts, and a shared 128 MiB cap for guardian/cleanup helpers. Draft now implements separate NBD service under the same 128 MiB attachment ancestor, a watchdog ExecStopPost, and explicit launch intents. These are source observations, not executed failure qualification.

Admission must preserve: existing fixed 8 GiB VM and seven service caps; 2304 MiB combined EL/CL + 128 MiB attachment + 128 MiB guardian; no swap; CPU1 trial discipline; continuous 1536 MiB guest residual after remaining existing-service and trial cap growth. Warden exporter/tunnel have a separate 512 MiB limit and 27648 MiB host available floor. Preserve original image identity, OFD locks and 300000000000-byte NVMe free floor. Use a new private persistent COW; never modify the original.

Require final concrete runner, manifests and content/external pins; exact fresh root admission; actual process/unit identities; terminal result and independent remote cleanup; retained COW/evidence even on failure. A successful bounded startup is not sustained memory fit, synchronized canonical/finalized L1, custody/blob/history/proof qualification, Base readiness, or production cutover.
