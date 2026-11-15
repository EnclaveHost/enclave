# rememberVerified (network/owner-signature.mjs) carried onto a host's network agent bundle that is older than main.
#
#   python3 -I agent-bundle.py BASE SOURCE OUT
#
# BASE    the host's privacy-agent.mjs (the one-hop release's bundle on the NucBox)
# SOURCE  main's network/owner-signature.mjs
# OUT     BASE with two changes and nothing else: the function, placed before verifyOwnerSignature, and the one line
#         of the network host that makes the agent's verify, wrapped in it
# Each place must be the text this script expects, once, or it refuses.
import sys

base = open(sys.argv[1], encoding="utf-8", newline="").read().split("\n")
src = open(sys.argv[2], encoding="utf-8").read()


def refuse(why):
    sys.exit("refused: " + why)


def once(test, what):
    hits = [i for i, l in enumerate(base) if test(l)]
    if len(hits) != 1:
        refuse(f"{what}: expected exactly one line, found {len(hits)}")
    return hits[0]


if any("rememberVerified" in l for l in base):
    refuse("BASE already has rememberVerified")
start = src.index("export function rememberVerified(")
end = src.index("\n}\n", start) + 3
fn = src[start:end].replace("export function rememberVerified(", "function rememberVerified(", 1).rstrip("\n").split("\n")
if len(fn) < 8 or not fn[-1] == "}":
    refuse("the function could not be read from SOURCE")
# the agent's verify: the single-line arrow function that calls verifyOwnerSignature
v = once(lambda l: l.startswith("  const verify8 = async (owner, message3, signature) => verifyOwnerSignature({") and l.endswith("});"), "the agent's verify")
base[v] = base[v].replace("  const verify8 = async (", "  const verify8 = rememberVerified(async (", 1)[:-len("});")] + "}), { now });"
d = once(lambda l: l.startswith("async function verifyOwnerSignature("), "verifyOwnerSignature")
out = base[:d] + ["// (carried from main: network/owner-signature.mjs rememberVerified; ops/policy-check-20261115)"] + fn + base[d:]
open(sys.argv[3], "w", encoding="utf-8", newline="").write("\n".join(out))
print(f"written: {len(out) - len(base)} lines added, 1 changed")
