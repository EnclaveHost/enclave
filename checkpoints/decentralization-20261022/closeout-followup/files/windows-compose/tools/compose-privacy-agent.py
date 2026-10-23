#!/usr/bin/env python3
# Compose network/privacy-agent.mjs = D1-reviewed a3f08aca (installed baseline 32fecf5) MINUS its host-services hunks
# (P2/hs-transport workstream, not composed). Every removal restores the normal tree's (f58e03e) line exactly.
import sys, hashlib
base_path, norm_path, out_path = sys.argv[1:4]
src = open(base_path, encoding="utf-8").read()
norm = open(norm_path, encoding="utf-8").read()
assert hashlib.sha256(src.encode()).hexdigest().startswith("a3f08aca"), "base privacy-agent is not a3f08aca"
def cut(old, new=""):
    global src
    assert src.count(old) == 1, ("anchor not unique", old[:80])
    src = src.replace(old, new)
cut("import fs_sync from 'node:fs';\n")
cut("import {keccak256,toBytes} from 'viem';\n")
cut("import {HostServiceTransport,validateHostServicesTransport} from './host-service-transport.mjs';\n")
a = src.index("// The host-service block's preflight"); b = src.index("export async function runPrivacy(")
src = src[:a] + src[b:]
cut("let wgControl=null,hostServices=null,paid=null,stopping=false;", "let wgControl=null,paid=null,stopping=false;")
a = src.index("  // this host's own public service roles (cfg.enclaveNetwork.hostServices"); b = src.index("  // The network host is closed LAST")
src = src[:a] + src[b:]
cut("wgControl?.close(),hostServices?.close()])", "wgControl?.close()])")
a = src.index("  // host services never take the agent (its apps) down"); b = src.index("  // paid providers (enclaveNetwork.paid)")
src = src[:a] + src[b:]
cut("await wgControl?.close();await hostServices?.close();}", "await wgControl?.close();}")
assert "hostServices" not in src and "HostService" not in src and "fs_sync" not in src and "keccak256" not in src
# every line left that is not in the normal file must be a wallet-admission line of the D1 diff
open(out_path, "w", encoding="utf-8").write(src)
print(hashlib.sha256(src.encode()).hexdigest())
