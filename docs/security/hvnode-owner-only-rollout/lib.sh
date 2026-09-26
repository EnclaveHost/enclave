# B rollout (enclave-87's order, 09-26): 1 push B (CI: relay + site) -> 1b us-west relay.js+fleet.mjs (manual; Steven's key)
# -> 2 RELAY_HVNODE_OPERATORS=0x389c... -> 3 RELAY_REVERIFY=enforce. Each step: its script, then b-accept.sh <step>; stop on the
# first unhealthy step and roll back THAT step only. No env value is ever printed (key names, line counts and digests only).
B=${B_DIR:-$HOME/enclave-bench/b-rollout-20260926}; mkdir -p $B; LOG=$B/rollout.log; MAIN=/home/steven/Projects/enclave; H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"                # nan (api relay)
NR="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 root@46.62.128.36"   # nan-relay
US="ssh -o BatchMode=yes -o ConnectTimeout=15 us-west"                                                              # us-west (Steven's unlocked key)
# BASE = B's base = the parent of B's two commits; b-1-push.sh requires it to BE main at push time (b-recut.sh re-cuts
# onto a moved main: B's files must stay byte-identical to the reviewed ones, so no re-review is needed)
BC=407f0936eec636dfc95de4ecfc8829b604f32112   # B's head after the re-cut (fc44db2f + af9a7175 content, bf GO); b-recut.sh updates this line
BASE=$(git -C $MAIN rev-parse "$BC~2" 2>/dev/null || echo unknown)
# every relay file B deploys, as B has it (sha256): nan (api relay) gets all; nan-relay relay.js/fleet.mjs/dns-relay.js; us-west relay.js/fleet.mjs
declare -A SHA=(
  [api-relay.js]=d40442cc3c32c72cbe3b64096384b1dfa0e2fc3b0a1e5a3c64b920ad3c5769fd
  [tunnel.js]=6331955b6c5c6875fc9ef4e210d68adfa1798d5f8bed0cd0918b683fd0d722d9
  [host-delegation.mjs]=153f9aa731014a7aabdf9c221970b085577de80bdae738bc782d35deb777888c
  [certs.js]=f34a175db3d97f160e9c0756497682a1c24c1284db403237586855b98a68db2b
  [secrets.js]=3c7ed954d8744f5ca76a26195c85ee533cfe981b0b7243bec03cda2cd34b3bd3
  [fleet.mjs]=0441e47decd6bb065a03b0f56fcc3327ebbbbd4e6dfcb57a64b0f81e1555c3db
  [relay.js]=68cd3b938f374a65a6014c51ea9c6b99237cec394f360ece4a0142ef5bced973
  [dns-relay.js]=3360ae772787015bdf38eac57984af62b2df085b64f194b79a45a73eef594cbd
  # relay.js + fleet.mjs's import closure on us-west (1b; unchanged since pre-B 2144fcb3 and on main c6347dd2)
  [connlog.mjs]=1ea6002bd044bffec7c508a920e4f5b1441247353bffefc8544fa257b343aeb9
  [net-guard.mjs]=f319fa3754b8991cb2a71a9c9d7a7637edee1803721109fb78273a2be39931a8
)
# the RELAY CONTEXT B was reviewed in (enclave-bf): main at the review. A main that has since changed ANY relay/ file (e.g.
# secrets-release.mjs beside B), or anything under site/ or scripts/, is a new context: refused until re-reviewed, never re-cut silently
REVIEW_BASE=68e96b115
context_moved() { git -C "$1" diff --name-only $REVIEW_BASE origin/main -- relay/ site/ scripts/; }   # 87: relay/, site/, scripts/ (all the deploy ships)
# EVERY file B changes, with its reviewed sha256 (the exact list: a re-cut or a push that differs in any file is refused)
declare -A BFILE=(
  [relay/api-relay.js]=d40442cc3c32c72cbe3b64096384b1dfa0e2fc3b0a1e5a3c64b920ad3c5769fd
  [relay/certs.js]=f34a175db3d97f160e9c0756497682a1c24c1284db403237586855b98a68db2b
  [relay/deploy.sh]=2a0e8df677745390b7f9880580ca28bb9e0052d8d859eec607ea999c0cdb476e
  [relay/dns-relay.js]=3360ae772787015bdf38eac57984af62b2df085b64f194b79a45a73eef594cbd
  [relay/fleet.mjs]=0441e47decd6bb065a03b0f56fcc3327ebbbbd4e6dfcb57a64b0f81e1555c3db
  [relay/host-delegation.mjs]=153f9aa731014a7aabdf9c221970b085577de80bdae738bc782d35deb777888c
  [relay/relay.js]=68cd3b938f374a65a6014c51ea9c6b99237cec394f360ece4a0142ef5bced973
  [relay/tunnel.js]=6331955b6c5c6875fc9ef4e210d68adfa1798d5f8bed0cd0918b683fd0d722d9
  [scripts/host-delegation.mjs]=f495f9943e604933b0399c64d02b1e6dd0033b3686be1dc4e9c00c39508c5d13
  [site/js/core/pricing.js]=9c247543000c11b8211f0e834ab7737adc1cb7c1591bb41224d7c087087dbc56
  [test/certs.test.mjs]=b17f026c2f614696a7b208189df6a82926644a282430e7df670f306e17d93d35
  [test/dns-relay-u7.test.mjs]=05d2fb52132264b5c74b2b0f24212538d1efcdeefd2bd018c5b7d59fdc64dccc
  [test/host-delegation.test.mjs]=6a714c52fe364e4648331d3ba284d222328957f50306cc583d2af6faaa4612c3
  [test/relay-hvnode-owner-only-fleet.test.mjs]=9f9a44acf3cbd7499c258328fb6c21c7365db756fe2e99cce40e641acb53d1ab
  [test/relay-hvnode-owner-only.test.mjs]=4406f62bac6d3576d10db4f2d052c3f03a68324b21c27f5c0582f439dd231a77
)
HVOP=0x389c3f030a209d04d026228d2d053feb75dbadca   # nucbox-k11's registry operator (step 2's one value)
IDS="0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e"
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG"; } 2>/dev/null || true; }
# the TRUSTED_OPERATORS line on nan, as a digest (87: record it before and after every step; B never changes it)
trusted_digest() { $NAN "grep -E '^TRUSTED_OPERATORS=' /etc/nan-relay/api-relay.env | sha256sum | cut -c1-16"; }
# the relay files on a host equal B's (host command, file list)
files_are_b() { local host=$1; shift; local f want got; for f in "$@"; do want=${SHA[$f]}; got=$($host "sha256sum < /opt/nan-relay/$f" | cut -c1-64); [ "$got" = "$want" ] || { echo "$f is ${got:0:12}, not B's ${want:0:12}"; return 1; }; done; }
canaries_dns() { local l r; for l in 0ddbd824 395bed3e 4e62e60d; do r=$(curl -sS -o /dev/null -w "%{http_code}/%{ssl_verify_result}" --max-time 20 https://$l.app.enclave.host/ 2>/dev/null); [ "$r" = "200/0" ] || { echo "$l: $r"; return 1; }; done; }
# 1b's acceptance (enclave-87, 09-26): test 1 on its public hostname, on the partition's key; an unleased hostname refused
TEST1=0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3
TEST1_SPKI=${TEST1_SPKI:-}   # sha256 of test 1's SPKI DER (d1's R4 key 4d80b956...): pinned before 1b runs; empty = the accept FAILS
UNLEASED="0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77 0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a 0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371"
# GET https://<label>.app.enclave.host/ -> "<http code> <sha256 of the handshake SPKI DER, or ->"; "000 -" when refused
public_get() {
  node -e '
const https = require("node:https"), { createHash, X509Certificate } = require("node:crypto");
const req = https.get({ host: process.argv[1] + ".app.enclave.host", path: "/", timeout: 20000, agent: false }, (res) => {
  const spki = new X509Certificate(res.socket.getPeerCertificate(false).raw).publicKey.export({ type: "spki", format: "der" });
  res.resume(); res.on("end", () => console.log(res.statusCode, createHash("sha256").update(spki).digest("hex")));
});
req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", () => console.log("000 -"));' "$1"
}
# the attestation document on that hostname: its transportKey equals THIS handshake's SPKI (the TLS ends in the attested partition)
public_doc_binds() {
  node -e '
const https = require("node:https"), { randomBytes, X509Certificate } = require("node:crypto");
const req = https.get({ host: process.argv[1] + ".app.enclave.host", path: "/.well-known/enclave-attestation?nonce=" + randomBytes(32).toString("hex"), timeout: 20000, agent: false }, (res) => {
  const spki = new X509Certificate(res.socket.getPeerCertificate(false).raw).publicKey.export({ type: "spki", format: "der" });
  let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let d = {}; try { d = JSON.parse(b); } catch {}
    console.log(res.statusCode === 200 && d.transportKey && Buffer.from(d.transportKey, "base64").equals(spki) ? "bound" : `not bound (${res.statusCode})`); });
});
req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", (e) => console.log("refused " + e.message));' "$1"
}
