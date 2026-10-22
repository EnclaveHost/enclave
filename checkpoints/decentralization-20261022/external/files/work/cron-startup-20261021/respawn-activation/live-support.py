#!/usr/bin/env python3
"""READ-ONLY: does the LIVE node code on minipc support the per-deployment respawn list? Booleans only (Select-String
-SimpleMatch -Quiet over the live files); no file content is returned."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, '..', 'probe.py')).read().split("LOGS = r")[0]
ns = {}; exec(compile(src, 'probe.py', 'exec'), ns)
D = r"C:\Program Files\Enclave\control\windows\node"
checks = {"agent.mjs": ["ENCLAVE_ISOLATION_RESPAWN_IDS", "ENCLAVE_ISOLATION_RESPAWN_DELAY_MS", "isolationRespawnIds"],
          "host.mjs": ["isolationRespawnIds?.includes(id)", "serviceRecovery", "automatic retry after", "waiting for the service's storage lease"]}
q = lambda x: x.replace("'", "''")
s = "$o=[ordered]@{};" + "".join("$o['%s|%s']=[bool](Select-String -LiteralPath '%s\\%s' -SimpleMatch -Quiet -Pattern '%s');" % (f, q(p), D, f, q(p))
                                  for f, ps_ in checks.items() for p in ps_) + "$o|ConvertTo-Json -Compress"
print(json.dumps(ns['ps'](s, 90), indent=1))
