#!/usr/bin/env python3
# Compose windows/node/network-enroll.mjs = normal f58e03e (2d97a0e1) + ONLY the D1 walletAdmission block of the installed
# baseline a9729786 (D1 package 6bd0a858 "P2 + walletAdmission"). hostServices (P2) and challengeReplica (G4) are NOT composed.
import sys, hashlib
norm_path, out_path = sys.argv[1:3]
src = open(norm_path, encoding="utf-8").read()
assert hashlib.sha256(src.encode()).hexdigest().startswith("2d97a0e1"), "normal network-enroll is not 2d97a0e1"
def sub(old, new):
    global src
    assert src.count(old) == 1, ("anchor not unique", old[:80])
    src = src.replace(old, new)
# lines below are the baseline's (a9729786) own text for walletAdmission, verbatim
sub("""    const want = { ...networkConfig({ binDir, nodeBinary: config.nodeBinary, relayBase, ...config.enclaveNetwork, directories }), ...(hostEgress ? { hostEgress } : {}), ...(paceMbps ? { paceMbps } : {}) };
""", """    const walletAdmission = config.walletAdmission?.file && path.isAbsolute(config.walletAdmission.file) ? { file: config.walletAdmission.file } : null;
    const want = { ...networkConfig({ binDir, nodeBinary: config.nodeBinary, relayBase, ...config.enclaveNetwork, directories }), ...(hostEgress ? { hostEgress } : {}), ...(paceMbps ? { paceMbps } : {}),
      // the node's wallet hold channel (host.mjs walletChannelStart), only while the node runs one: the agent then admits an
      // app only on a fresh allow there; dropped (one restart) when the node stops writing it, so nothing waits on a dead file
      ...(walletAdmission ? { walletAdmission } : {}) };
""")
open(out_path, "w", encoding="utf-8").write(src)
print(hashlib.sha256(src.encode()).hexdigest())
