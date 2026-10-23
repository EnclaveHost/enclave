// Bundle entry of the privacy agent (network/build.mjs, scripts/network/build-consumers.mjs): the main guard FIRST (no
// bundled library's command line can run inside the agent), then the agent - its exports for embedders, and its daemon
// (`node privacy-agent.mjs --config FILE`) only when the bundle itself is the main script.
import { mainScript } from '../main-guard.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPrivacy } from '../privacy-agent.mjs';
export * from '../privacy-agent.mjs';
if (mainScript() && import.meta.url === pathToFileURL(path.resolve(mainScript())).href) {
  const i = process.argv.indexOf('--config'); runPrivacy(process.argv[i + 1]).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
