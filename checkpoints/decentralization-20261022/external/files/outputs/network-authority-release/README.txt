Network authority release — four providers and Windows host ACTIVE

The four provider services run source 8b37c37 with provider.mjs SHA-256 8b776d76faf784cacafbe95c5ff2a8b501093f28b3e45049eeeeabc528937164. Their WireGuard keys and peer counts were preserved, and twelve routes plus adapter health were checked after each restart. See provider-pins-rollout.json.

The Windows nucbox-k11-4 privacy agent runs the corrected standalone bundle from source 4d23aec, SHA-256 3883f67ce2414a1c328bd8ead7e46fea071e5e6e86c95a866070bb3241888cd6. It imported successfully using the installed Windows Node runtime before activation. Ten apps recovered with no fallback; the adapter returned ready with its unchanged 1,239-entry inventory. See windows-network-pins-rollout.json.

The first Windows attempt failed because the ESM artifact lacked the CommonJS compatibility wrapper needed by a dependency. Its process exited and routes expired; the original executable/configuration were restored and recovery verified. The fixed retry took 121 seconds to recover and also caused temporary connection failures. Do not describe either rollout as zero downtime. See windows-network-pins-first-attempt.json.

Use authority-pins.json as provider authorityPins or privacy-agent chain.authorityPins. Preserve keys, directory origins, state, runtime paths and the other operator settings. Conflicting registry settings refuse startup. The Windows enrollment regression verifies RPC refresh preserves authority pins.

Build future consumer artifacts with scripts/network/build-consumers.mjs. Test standalone imports outside the repository and with the destination's installed Node before replacing any service. Roll out one node at a time, retain executable/configuration rollback, and require a live process, fresh status, restored circuits, verified directory routes and actual guest health. Cached ready state is not sufficient.

These pins remove mutable address-book discovery in the activated consumers. Other host agents are pending. This does not activate host wallet admission or migrate custom domains, BYO credentials, custody, host control, DNS/certificates or the authoritative policy revision anchor. Nan is not retired.
