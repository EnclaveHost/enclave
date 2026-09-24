// Harmless lab canaries for the installed client's activation tests (client/DESIGN.md "Activation"). A canary is a tiny ES
// module carrying the client's version line, so it can be signed, staged and activated like a real update. Whenever it
// executes it appends ONE line to a report file inside the test's own temporary directory -- its token, the command, argv,
// argv[1], import.meta.url, cwd, NODE_OPTIONS, HOME, XDG_CONFIG_HOME and the one-hop marker -- and nothing else:
// no network, no other file. The report says exactly which bytes ran and in what environment.
//   `version`: answers { client, version } (or a wrong version, or fails, for the start-check fixtures)
//   `run`: prints {"canary": token, "ran": version} and exits 0, or 7, or kills itself (SIGKILL), as told
import { VERSION_MARKER } from "../../shielded/anchor/avf/client/src/trust.js";

export function canary({ version, token, report, onRun = "exit0", answer = version, start = "ok" }) {
  const end = { exit0: "process.exit(0);", exit7: "process.exit(7);", sigkill: 'process.kill(process.pid, "SIGKILL");' }[onRun];
  if (!end) throw new Error(`unknown onRun ${onRun}`);
  return Buffer.from(`${VERSION_MARKER}${version} (LAB canary: a harmless test fixture) */
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({ token: ${JSON.stringify(token)}, version: ${JSON.stringify(version)}, cmd: argv[0] ?? null, argv,
  argv1: process.argv[1], url: import.meta.url, cwd: process.cwd(), nodeOptions: process.env.NODE_OPTIONS ?? null, home: process.env.HOME ?? null,
  xdg: process.env.XDG_CONFIG_HOME ?? null, delegated: process.env.ENCLAVE_PVM_CLIENT_DELEGATED ?? null }) + "\\n");
${start === "throw" ? 'throw new Error("canary: fails to start");' : ""}
if (argv[0] === "version") { process.stdout.write(JSON.stringify({ client: "enclave-pvm-client", version: ${JSON.stringify(answer)}, lab: "NOT PRODUCTION" }) + "\\n"); process.exit(${start === "exit3" ? 3 : 0}); }
if (argv[0] === "run") { process.stdout.write(JSON.stringify({ canary: ${JSON.stringify(token)}, ran: ${JSON.stringify(version)} }) + "\\n"); ${end} }
process.exit(64);
`);
}
