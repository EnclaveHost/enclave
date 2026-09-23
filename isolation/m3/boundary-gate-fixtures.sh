#!/bin/sh
# Negative fixtures for boundary-gate.sh. A gate nobody has watched fail is not a gate, and the previous
# check (grep for "vmpl=$VMPL") would have passed most of the logs below - including the GRANTED one.
#
# Each fixture is a crafted serial log. `must_pass` and `must_fail` assert the gate's verdict, so every way
# of being wrong is pinned: GRANTED, a probe that never ran, mismatched levels, the downward-claim shape,
# missing fields, repeated fields, and zero or duplicate records.
#
# usage: boundary-gate-fixtures.sh [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
W=${1:-$(mktemp -d)}; mkdir -p "$W"
gate="$here/boundary-gate.sh"
fails=0
n=0

# write a fixture log, with the \r\n line endings a real guest console produces
mklog() { printf '%s\r\n' "some earlier guest chatter" "$1" "MON ready control_port=9000 snp=true" > "$W/f$n.serial"; }
check() { # check <want-verdict:pass|fail> <expected-vmpl> <description> <log line...>
  want=$1; vmpl=$2; desc=$3; shift 3
  n=$((n + 1))
  : > "$W/f$n.serial"
  printf '%s\r\n' "boot chatter" >> "$W/f$n.serial"
  for line in "$@"; do printf '%s\r\n' "$line" >> "$W/f$n.serial"; done
  printf '%s\r\n' "MON ready control_port=9000 snp=true" >> "$W/f$n.serial"
  if out=$("$gate" "$W/f$n.serial" "$vmpl" 2>&1); then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then
    printf 'PASS  gate says %-4s  %s\n' "$got" "$desc"
  else
    printf 'FAIL  gate says %-4s but must %s: %s\n      -> %s\n' "$got" "$want" "$desc" "$(echo "$out" | head -1)"
    fails=$((fails + 1))
  fi
}

echo "--- the two shapes that may pass"
check pass 2 'confined at VMPL2 with level 0 refused'   'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused'
check pass 0 'a plain SNP guest at VMPL0'               'MON boundary tier=t1 vmpl=0 vmpl_floor=0 vmpl0=n/a'
check pass 0 'a T0 guest, no hardware report'           'MON boundary tier=t0 vmpl=n/a vmpl_floor=n/a vmpl0=n/a'
check pass 3 'confined at VMPL3'                        'MON boundary tier=t1 vmpl=3 vmpl_floor=3 vmpl0=refused'

echo "--- GRANTED: we hold VMPL0, so nothing is above us. Fatal at any level"
check fail 2 'GRANTED while claiming VMPL2'             'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=GRANTED'
check fail 0 'GRANTED at VMPL0'                         'MON boundary tier=t1 vmpl=0 vmpl_floor=0 vmpl0=GRANTED'
check fail 3 'GRANTED with otherwise perfect fields'    'MON boundary tier=t1 vmpl=3 vmpl_floor=3 vmpl0=GRANTED'

echo "--- the probe never ran, so there is no evidence"
check fail 2 'confined-looking but vmpl0=n/a'           'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=n/a'
check fail 2 'vmpl0 empty'                              'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0='
check fail 2 'vmpl0 unrecognised'                       'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=ok'
check fail 2 'vmpl0 near-miss spelling'                 'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=Refused'

echo "--- the downward-claim forgery and level mismatches"
check fail 2 'floor 0 while the record claims VMPL2'    'MON boundary tier=t1 vmpl=2 vmpl_floor=0 vmpl0=refused'
check fail 2 'vmpl and floor disagree'                  'MON boundary tier=t1 vmpl=1 vmpl_floor=2 vmpl0=refused'
check fail 2 'the wrong level entirely'                 'MON boundary tier=t1 vmpl=1 vmpl_floor=1 vmpl0=refused'
check fail 0 'VMPL0 expected, record says VMPL2'        'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused'
check fail 2 'a T0 record cannot show confinement'      'MON boundary tier=t0 vmpl=n/a vmpl_floor=n/a vmpl0=n/a'

echo "--- malformed, missing and repeated fields"
check fail 2 'vmpl0 missing'                            'MON boundary tier=t1 vmpl=2 vmpl_floor=2'
check fail 2 'vmpl_floor missing'                       'MON boundary tier=t1 vmpl=2 vmpl0=refused'
check fail 2 'tier missing'                             'MON boundary vmpl=2 vmpl_floor=2 vmpl0=refused'
check fail 2 'a repeated field'                         'MON boundary tier=t1 vmpl=2 vmpl=0 vmpl_floor=2 vmpl0=refused'
check fail 2 'a repeated vmpl0, second one fatal'       'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused vmpl0=GRANTED'
check fail 2 'an unexpected extra field'                'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused confined=yes'

echo "--- zero records, and duplicates a checker cannot choose between"
check fail 2 'no record at all'                         'MON ready control_port=9000 snp=true'
check fail 2 'two records, the second contradicting'    'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused' 'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=GRANTED'
check fail 2 'two IDENTICAL records'                    'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused' 'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused'
check fail 2 'a host-injected record before the real one' 'MON boundary tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused' 'MON boundary tier=t1 vmpl=0 vmpl_floor=0 vmpl0=n/a'

printf '\n'
if [ "$fails" -eq 0 ]; then
  echo "boundary gate fixtures: ALL $n PASS (workdir $W)"
else
  echo "boundary gate fixtures: $fails of $n FAILED (workdir $W)"
  exit 1
fi
