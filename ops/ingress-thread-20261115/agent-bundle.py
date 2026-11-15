# The ingress thread (network/ingress-thread-host.mjs) carried onto a host's network agent bundle that is older than main,
# and onto the native-startup overlay beside it.
#
#   python3 -I agent-bundle.py BASE_AGENT BASE_OVERLAY REPO OUT_DIR
#
# BASE_AGENT    the host's privacy-agent.mjs (on the NucBox: the bundle with the kept signature check, 01808234...)
# BASE_OVERLAY  the host's native-startup-overlay.mjs (cff1a042...)
# REPO          this checkout (network/ingress-thread-host.mjs and network/native-startup-overlay.mjs are read)
# OUT_DIR       receives privacy-agent.mjs and native-startup-overlay.mjs: the base files with these changes and nothing
#               else:
#   agent    - ingress-thread-host.mjs's text (without its import of app-broker.mjs, which the bundle already holds),
#              placed before createAppBroker
#            - the circuit runtime makes its broker with createIngressBroker and closes the circuit if the thread ends
#            - ShieldIngress gains plan(); open() and forward are that plan, opened
#   overlay  - nativeStartupForwarder's result gains plan(), main's text
# Each place must be the text this script expects, once, or it refuses. The thread's own file (ingress-thread.mjs) is
# built by scripts/network/build-ingress-thread.mjs and goes beside the two.
import os
import sys

agent = open(sys.argv[1], encoding="utf-8", newline="").read()
overlay = open(sys.argv[2], encoding="utf-8", newline="").read()
repo, out = sys.argv[3], sys.argv[4]
host = open(os.path.join(repo, "network/ingress-thread-host.mjs"), encoding="utf-8").read()
src_overlay = open(os.path.join(repo, "network/native-startup-overlay.mjs"), encoding="utf-8").read()


def refuse(why):
    sys.exit("refused: " + why)


def swap(text, old, new, what):
    if text.count(old) != 1:
        refuse(f"{what}: expected the text once, found it {text.count(old)} times")
    return text.replace(old, new)


for name in ("createIngressBroker", "ingressThreadFile", "sharedIngressThread", "IngressWorker", "ingressFs", "ingressFileURL", "function ingressThread"):
    if name in agent:
        refuse(f"BASE_AGENT already has {name}")
if "forward.plan" in overlay:
    refuse("BASE_OVERLAY already plans")

# the main thread's side, as main has it
imp = "import {createAppBroker} from './app-broker.mjs';\n"
body = swap(host, imp, "", "the host module's import of app-broker.mjs")
if body.count("export ") != 2 or "\nimport {Worker as IngressWorker} from 'node:worker_threads';\n" not in body:
    refuse("network/ingress-thread-host.mjs is not the text this script was written for")
body = body.replace("export function ingressThreadFile", "function ingressThreadFile").replace("export async function createIngressBroker", "async function createIngressBroker")
anchor = "\nasync function createAppBroker({ socketPath, tcpPort, token, deploymentId, authorize: authorize2, forward, log: log5 = () => {"
agent = swap(agent, anchor, "\n// (carried from main: network/ingress-thread-host.mjs; ops/ingress-thread-20261115)\n" + body.rstrip("\n") + anchor, "createAppBroker")
agent = swap(agent,
             "broker = await createAppBroker({ tcpPort: 0, token, deploymentId, authorize: authorize2, forward: this.forward, log: this.log });",
             "broker = await createIngressBroker({ tcpPort: 0, token, deploymentId, authorize: authorize2, forward: this.forward, log: this.log, onLost: (why) => void circuit.close(\"ingress thread ended: \" + why) });",
             "the circuit runtime's broker")
agent = swap(agent,
             "  async open(id) {\n    const expected = this.expected(id);\n    if (!expected || !/^0x[0-9a-f]{64}$/.test(id)) throw new Error(\"unknown deployment\");\n    const response = await this.transport.request(\"GET\", \"/vms\");",
             "  async plan(id) {\n    const expected = this.expected(id);\n    if (!expected || !/^0x[0-9a-f]{64}$/.test(id)) throw new Error(\"unknown deployment\");\n    const response = await this.transport.request(\"GET\", \"/vms\");",
             "ShieldIngress.open")
agent = swap(agent,
             "    if (key && route.key !== key) throw new Error(\"partition transport key changed\");\n    return this.openSplice(this.dataAddr, route);\n  }\n  forward = async (socket, id) => {\n    const guest = await this.open(id);",
             "    if (key && route.key !== key) throw new Error(\"partition transport key changed\");\n    return { dataAddr: this.dataAddr, route };\n  }\n  async open(id) {\n    const { dataAddr, route } = await this.plan(id);\n    return this.openSplice(dataAddr, route);\n  }\n  forward = Object.assign(async (socket, id) => {\n    const guest = await this.open(id);",
             "ShieldIngress.forward")
tail = "    guest.once(\"close\", close);\n    socket.pipe(guest).pipe(socket);\n    socket.resume();\n  };\n};\n"
start = agent.index("var ShieldIngress = class {")
if agent.count(tail, start, start + 4000) != 1:
    refuse("the end of ShieldIngress.forward")
at = agent.index(tail, start)
agent = agent[:at] + tail.replace("  };\n};\n", "  }, { plan: (id) => this.plan(id) });\n};\n") + agent[at + len(tail):]

# the overlay: main's plan, on the forwarder it returns
a = src_overlay.index("  // plan (ingress-thread-host.mjs)")
b = src_overlay.index("  return forward;\n}", a)
plan = src_overlay[a:b]
if "forward.plan=async id=>{" not in plan or plan.count("\n") < 8:
    refuse("main's nativeStartupForwarder plan could not be read")
overlay = swap(overlay,
               "function nativeStartupForwarder({ expected, proof, authorize, open, normal, now = Date.now }) {\n  return async (socket, id) => {\n",
               "function nativeStartupForwarder({ expected, proof, authorize, open, normal, now = Date.now }) {\n  const forward = async (socket, id) => {\n",
               "the overlay's nativeStartupForwarder")
overlay = swap(overlay,
               "      socket.pipe(guest).pipe(socket);\n      socket.resume();\n    } catch (error) {\n      close();\n      throw error;\n    }\n  };\n}\nexport {\n  nativeStartupForwarder,",
               "      socket.pipe(guest).pipe(socket);\n      socket.resume();\n    } catch (error) {\n      close();\n      throw error;\n    }\n  };\n  // (carried from main: network/native-startup-overlay.mjs; ops/ingress-thread-20261115)\n" + plan + "  return forward;\n}\nexport {\n  nativeStartupForwarder,",
               "the end of the overlay's nativeStartupForwarder")

os.makedirs(out, exist_ok=True)
open(os.path.join(out, "privacy-agent.mjs"), "w", encoding="utf-8", newline="").write(agent)
open(os.path.join(out, "native-startup-overlay.mjs"), "w", encoding="utf-8", newline="").write(overlay)
print("written: privacy-agent.mjs and native-startup-overlay.mjs")
