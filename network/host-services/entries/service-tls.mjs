// Bundle entry of the service-tls host role (scripts/build-host-service-packages.mjs): the argv guard (no bundled library's
// "main script" check may fire inside the role), then the role with the configuration file the runner wrote
// (network/host-services/runner.mjs: `node service-tls.mjs <stateRoot>/service-tls/config.json`, no inherited env).
import '../argv-guard.mjs';
import { main } from '../service-tls.mjs';

const file = process.argv[2];
if (!file) { console.error('service-tls: the runner passes the configuration file'); process.exit(2); }
main(file).catch((e) => { console.error(e.message); process.exit(1); });
