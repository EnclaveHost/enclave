// net-child.mjs -- the Enclave network (network/privacy-agent.mjs) as standalone.mjs's child on the phone (STANDALONE.md).
// It must not outlive the agent that started it: if the agent dies hard (a crash, a kill), Android does not end its children,
// and the agent that AgentService starts next would start a second network beside the orphan. So the parent is watched: when
// it is gone (the parent pid changes), the network shuts down the way a SIGTERM shuts it down (its circuits and their
// processes closed), and the process ends within 15 s whatever happens.
//   node net-child.mjs --config <network.json>
import { runPrivacy } from "../../../../network/privacy-agent.mjs";

const parent = process.ppid;
setInterval(() => {
  if (process.ppid === parent) return;
  console.error(`[net-child] the agent (pid ${parent}) is gone: stopping`);
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => process.exit(0), 15_000).unref();
}, 5_000).unref();

const i = process.argv.indexOf("--config");
if (i < 0 || !process.argv[i + 1]) { console.error("usage: net-child.mjs --config <network.json>"); process.exit(2); }
runPrivacy(process.argv[i + 1]).catch((e) => { console.error(e.message); process.exitCode = 1; });
