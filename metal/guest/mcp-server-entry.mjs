// Bundle entry of the hosted MCP adapter (scripts/build-mcp-guest-bundle.mjs): the argv guard, then mcp/server.mjs's main.
// Inside the ONE bundle every module's import.meta.url is the bundle's, so a bundled library's "am I the main script?" check
// (windows/node/host-identity.mjs and cli/independent-capacity.mjs, both loaded lazily by capacity and quorum tools) would run
// that library's command line and exit the adapter. The same guard as the platform API entry and the host-role packages.
// It makes mcp/server.mjs's own check false as well, so its main runs here, with the same arguments and failure exit.
import '../../network/host-services/argv-guard.mjs';
import { main } from '../../mcp/server.mjs';
main(process.argv.slice(2)).catch((e) => { process.stderr.write(`mcp/server: ${e.message}\n`); process.exit(1); });
