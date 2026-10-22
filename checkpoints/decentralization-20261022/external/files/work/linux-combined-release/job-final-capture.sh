#!/bin/sh
# Final read-only capture of main after all combined-release work. Nothing written in main.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/enclave; L=$W/linux-combined-release
(cd "$M" && find . \( -name node_modules -o -name .git -o -name __pycache__ \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum) > $L/main-final.sha256
cmp -s $L/main-capture-v2-after.sha256 $L/main-final.sha256 && echo "MAIN-FINAL == V2-CAPTURE (staged release B = main + overlay fix only)" || { echo "MAIN-MOVED-AFTER-V2-CAPTURE:"; diff $L/main-capture-v2-after.sha256 $L/main-final.sha256 | grep '^[<>]' | awk '{print $1, $3}' | sort -k2 | head -40; }
(cd "$M" && sha256sum -c $L/generated-after.sha256) && echo "GENERATED-OUTPUTS-STILL-AS-REGENERATED"
(cd "$L/overlay-fix" && for f in base/*; do b=$(basename $f); case $b in *.test.py) p=test/$b;; *) p=metal/$b;; esac; cmp -s $f $M/$p && echo "MAIN-$p == overlay-fix/base (fix NOT applied to main; root integrates)"; done)
git -C $M status --porcelain | wc -l | sed 's/^/MAIN-DIRTY-PATHS /'
echo FINAL-CAPTURE-OK
