#!/usr/bin/env bash
# tab.sh <results dir>: one line per run -- build, rate, acceptance, self-check, verification, CPU window, text hash
cd "$1" || exit 1
for l in $(awk -F'\t' '!/^#/{print $1}' RUNS.tsv); do
  c=$(awk -F'\t' -v l=$l '$1==l{print $2" rc="$5" apk="substr($6,1,8)}' RUNS.tsv)
  [ -f $l.log ] || { echo "$l $c | NO LOG"; continue; }
  echo "$l $c | $(grep -o 'built [^)]*' $l.log | head -1) | $(grep -o 'decode_tok_s=[0-9.]*\|steps=[0-9]*\|tokens_per_step=[0-9.]*' $l.log | head -3 | tr '\n' ' ')| $(grep -o 'checked against serial on [0-9]* exchanges, [0-9]* differed' $l.log) | $(grep -o 'verify n=[0-9]* bad=[0-9]* max=[0-9]*' $l.log | head -1) out $(grep -o 'paired samples: max [0-9.]*' $l.log | head -1 | grep -o '[0-9.]*$') | $(grep -o 'COMPLETE[^|]*core-ms per decoded token\|INCOMPLETE[^|]*\|UNMEASURED[^|]*' $l.cpu 2>/dev/null | head -1 | grep -o 'COMPLETE\|INCOMPLETE\|UNMEASURED\|[0-9.]* cores busy\|[0-9]* core-ms' | tr '\n' ' ')| text $(grep -h 'turn 1 A:' $l.log | sha256sum | cut -c1-8)"
done
