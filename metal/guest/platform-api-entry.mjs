// Bundle entry of the platform API role (scripts/build-platform-api-guest-bundle.mjs): the argv guard, then the role. Inside
// the ONE bundle every module's import.meta.url is the bundle's, so a bundled library's "am I the main script?" check (the
// Windows host-identity CLI inside relay/network-runtime.bundle.mjs) ran that CLI and exited instead of the role, in BOTH the
// role and its --relay-child (found by the artifact smoke, 2026-10-21). The same guard the host-role packages use.
import '../../network/host-services/argv-guard.mjs';
import { main } from './platform-api-role.mjs';
main(process.argv).catch((e) => { console.error(`[platform-api] ${e.message}`); process.exit(1); });
