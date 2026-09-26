# B rollout (enclave-87's order, 09-26): 1 push B (CI: relay + site) -> 1b us-west relay.js+fleet.mjs (manual; Steven's key)
# -> 2 RELAY_HVNODE_OPERATORS=0x389c... -> 3 RELAY_REVERIFY=enforce. Each step: its script, then b-accept.sh <step>; stop on the
# first unhealthy step and roll back THAT step only. No env value is ever printed (key names, line counts and digests only).
B=${B_DIR:-$HOME/enclave-bench/b-rollout-20260926}; mkdir -p $B; LOG=$B/rollout.log; MAIN=/home/steven/Projects/enclave; H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"                # nan (api relay)
NR="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 root@46.62.128.36"   # nan-relay
US="ssh -o BatchMode=yes -o ConnectTimeout=15 us-west"                                                              # us-west (Steven's unlocked key)
BASE=e1c665fd6995504859c2626d3a7882d7353fabad   # main when B was cut (68e96b11); a moved main = re-cut B and re-pin
BC=af9a71751ba7156822aa26e7e77124f096de196e   # B's head (fc44db2f host-delegation.mjs + af9a7175 serving = 9df50309 minus the stray relay/node_modules symlink), bf GO
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
)
HVOP=0x389c3f030a209d04d026228d2d053feb75dbadca   # nucbox-k11's registry operator (step 2's one value)
IDS="0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e"
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG"; } 2>/dev/null || true; }
# the TRUSTED_OPERATORS line on nan, as a digest (87: record it before and after every step; B never changes it)
trusted_digest() { $NAN "grep -E '^TRUSTED_OPERATORS=' /etc/nan-relay/api-relay.env | sha256sum | cut -c1-16"; }
# the relay files on a host equal B's (host command, file list)
files_are_b() { local host=$1; shift; local f want got; for f in "$@"; do want=${SHA[$f]}; got=$($host "sha256sum < /opt/nan-relay/$f" | cut -c1-64); [ "$got" = "$want" ] || { echo "$f is ${got:0:12}, not B's ${want:0:12}"; return 1; }; done; }
canaries_dns() { local l r; for l in 0ddbd824 395bed3e 4e62e60d; do r=$(curl -sS -o /dev/null -w "%{http_code}/%{ssl_verify_result}" --max-time 20 https://$l.app.enclave.host/ 2>/dev/null); [ "$r" = "200/0" ] || { echo "$l: $r"; return 1; }; done; }
