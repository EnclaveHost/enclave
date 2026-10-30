// Bundle entry of the credit-vault-submitter host role (scripts/build-host-service-packages.mjs): the argv guard (no bundled
// library's "main script" check may fire inside the role), then the submitter with the configuration file the runner wrote
// (network/host-services/runner.mjs: `node <role>.mjs <stateRoot>/credit-vault-submitter/config.json`, no inherited env).
import '../argv-guard.mjs';
import fs from 'node:fs';
import { startSubmitter } from '../../credit-vault-submitter.mjs';

const file = process.argv[2];
if (!file) { console.error('credit-vault-submitter: the runner passes the configuration file'); process.exit(2); }
startSubmitter(JSON.parse(fs.readFileSync(file, 'utf8'))).then((s) => {
  console.log(JSON.stringify({ submitter: s.url }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { s.stop().then(() => process.exit(0)); });
}, (e) => { console.error(e.message); process.exit(1); });
