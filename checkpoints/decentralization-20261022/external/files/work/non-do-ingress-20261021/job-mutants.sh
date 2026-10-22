#!/bin/bash
# mutants of inbound_probe.py; each must FAIL the fixture tests (the real file is never modified)
D=/home/steven/Documents/Codex/2026-10-18/wo/work/non-do-ingress-20261021; M=$D/mutant
for m in ${MUTANTS:-no-preflight-714 no-desc-check no-start-identity no-finally-cleanup child-first post-kill-ppid absence-unproven cleanup-status-ignored temp-only-if-listener}; do
  rm -rf $M && mkdir -p $M && cp $D/inbound_probe.py $D/test_inbound_probe.py $M/
  python3 - "$m" <<'PY'
import sys; m=sys.argv[1]; p='/home/steven/Documents/Codex/2026-10-18/wo/work/non-do-ingress-20261021/mutant/inbound_probe.py'; s=open(p).read()
R={'no-preflight-714':[("        if soap_fault(text) != 714: raise Refused(","        if False: raise Refused(")],
   'no-desc-check':[("\n                and soap_field(text, 'NewPortMappingDescription') == self.desc)",")")],
   'no-start-identity':[("        if not (now and now['start'] == par['start'] and self.script in now['cmdline']):","        if not (now and self.script in now['cmdline']):"),
                        ("        if now and now['start'] == par['start'] and self.script in now['cmdline']:\n            self.io.adb('shell', f\"kill {par['pid']}\")","        if now and self.script in now['cmdline']:\n            self.io.adb('shell', f\"kill {par['pid']}\")")],
   'no-finally-cleanup':[("        finally:\n            self.cleanup()","        else:\n            self.cleanup()")],
   'child-first':[("        now = self.identity(par['pid'])\n        if now and now['start'] == par['start'] and self.script in now['cmdline']:\n            self.io.adb('shell', f\"kill {par['pid']}\"); c['parentKillSent'] = True\n        sent = []",
                   "        sent = []"),
                  ("        c['childKillsSent'] = sent\n","        c['childKillsSent'] = sent\n        for _ in range(3):\n            self.io.sleep(1)\n        now = self.identity(par['pid'])\n        if now and now['start'] == par['start'] and self.script in now['cmdline']:\n            self.io.adb('shell', f\"kill {par['pid']}\"); c['parentKillSent'] = True\n")],
   'post-kill-ppid':[("        sent = []\n        for x in reversed(snap):","        snap = [self.identity(k) for k, v in self.procs().items() if v['ppid'] == par['pid']]   # MUTANT: children found AFTER the parent kill\n        sent = []\n        for x in reversed(snap):")],
   'absence-unproven':[("                    pids, listening = self.owned_alive()","                    pids, listening = [], False")],
   'cleanup-status-ignored':[("            if self.r['cleanup'].get('status') != 'ok': status = 4","            pass")],
   'temp-only-if-listener':[("        if self.push_attempted:","        if self.listener:")]}[m]
for a,b in R:
    assert s.count(a)==1, (m,a[:60]); s=s.replace(a,b)
open(p,'w').write(s)
PY
  (cd $M && timeout 120 python3 test_inbound_probe.py > out.txt 2>&1); rc=$?
  echo "mutant $m rc=$rc $(tail -1 $M/out.txt) failing: $(grep -E '^(FAIL|ERROR):' $M/out.txt | sed -E 's/^(FAIL|ERROR): (test_[a-z0-9_]+).*/\2/' | tr '\n' ' ')"
done
rm -rf $M
