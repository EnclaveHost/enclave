#!/bin/sh
# The VMPL0-refusal gate, over a guest's serial log. One implementation, used by test-m3.sh check 3e and
# by m3b-verify.sh, so the rule that is tested by boundary-gate-fixtures.sh is the rule that runs.
#
# Why this exists: a signed report naming VMPL2 does NOT show confinement. A guest at VMPL0 holds every
# VMPCK and can request a report naming a lower privilege level, so "the report says VMPL2" is equally
# consistent with being confined beneath a VMPL0 monitor and with being VMPL0 and saying otherwise. The
# distinguishing fact is being REFUSED a report at level 0, which a guest holding VMPCK0 cannot honestly
# claim. Grepping for "vmpl=2" was therefore not a check at all: it matches a log that also says
# vmpl0=GRANTED.
#
# What this gate demands, and nothing less:
#   * EXACTLY ONE "MON boundary" record. Zero means the monitor never said; two or more means something
#     re-ran or wrote into the log, and a checker cannot know which record to believe.
#   * all four fields present, none repeated
#   * vmpl0 != GRANTED, always, at any level
#   * when the expected level is above 0: tier=t1, vmpl == vmpl_floor == expected, and vmpl0=refused.
#     "n/a" (the probe never ran) is a FAILURE, not a pass: silence is never evidence.
#   * when the expected level is 0: vmpl and vmpl_floor must both be 0, and no confinement is claimed.
#
# NOTE ON WHAT SERIAL TEXT IS WORTH: the console belongs to the HOST, which could write these lines. This
# gate is a test-harness check that our own measured code behaved, not evidence for a remote verifier. The
# verifier-visible path is doc.boundary over the domain's attested TLS, enforced by isolation/m2/judge.mjs
# checkBoundary, and even that is the measured monitor's own word rather than a hardware attestation.
#
# usage: boundary-gate.sh <serial-log> <expected-vmpl>
# exit:  0 the tuple is coherent and records what the expected level requires
#        1 anything else, with the reason on stdout
set -e
f=${1:?usage: boundary-gate.sh <serial-log> <expected-vmpl>}
want=${2:?usage: boundary-gate.sh <serial-log> <expected-vmpl>}
[ -r "$f" ] || { echo "no such serial log: $f"; exit 1; }

# the guest console ends lines \r\n; strip the \r before matching anything
recs=$(tr -d '\r' < "$f" | grep -a '^MON boundary ' || true)
n=$(printf '%s' "$recs" | grep -ac . || true)
if [ "$n" -ne 1 ]; then
  if [ "$n" -eq 0 ]; then
    echo "no MON boundary record: the monitor never stated what bounds it"
  else
    echo "$n MON boundary records, expected exactly 1 - a checker cannot know which to believe:"
    printf '%s\n' "$recs" | sed 's/^/    /'
  fi
  exit 1
fi

tuple=${recs#MON boundary }
tier= vmpl= floor= probe=
dup=
for kv in $tuple; do
  k=${kv%%=*}; v=${kv#*=}
  case "$k" in
    tier)       [ -n "$tier" ]  && dup="$dup $k"; tier=$v ;;
    vmpl)       [ -n "$vmpl" ]  && dup="$dup $k"; vmpl=$v ;;
    vmpl_floor) [ -n "$floor" ] && dup="$dup $k"; floor=$v ;;
    vmpl0)      [ -n "$probe" ] && dup="$dup $k"; probe=$v ;;
    *) echo "unexpected field '$k' in: $tuple"; exit 1 ;;
  esac
done
[ -n "$dup" ] && { echo "repeated field(s)$dup in: $tuple"; exit 1; }
for pair in "tier:$tier" "vmpl:$vmpl" "vmpl_floor:$floor" "vmpl0:$probe"; do
  [ -n "${pair#*:}" ] || { echo "missing ${pair%%:*} in: $tuple"; exit 1; }
done

# GRANTED is fatal at any level: we can obtain a VMPL0 report, so nothing is above us
[ "$probe" = GRANTED ] && { echo "vmpl0=GRANTED: this guest CAN get a report at VMPL0, so nothing more privileged is above it"; exit 1; }
case "$probe" in refused|n/a) ;; *) echo "vmpl0='$probe' is not one of refused, GRANTED, n/a"; exit 1 ;; esac

if [ "$want" = 0 ]; then
  [ "$tier" = t0 ] && { echo "OK t0: no hardware report and no confinement claimed ($tuple)"; exit 0; }
  { [ "$vmpl" = 0 ] && [ "$floor" = 0 ]; } || { echo "VMPL0 expected but the record reads vmpl=$vmpl vmpl_floor=$floor"; exit 1; }
  echo "OK at VMPL0: no confinement above the guest is claimed, and none is checked ($tuple)"
  exit 0
fi

[ "$tier" = t1 ] || { echo "confinement at VMPL$want demanded but tier=$tier"; exit 1; }
{ [ "$vmpl" = "$want" ] && [ "$floor" = "$want" ]; } \
  || { echo "VMPL$want demanded but the record reads vmpl=$vmpl vmpl_floor=$floor; both must equal $want"; exit 1; }
[ "$probe" = refused ] \
  || { echo "a report at VMPL0 must have been REFUSED to show confinement, but vmpl0=$probe"; exit 1; }
echo "OK confined: refused a report at VMPL0 while running at VMPL$want ($tuple)"
