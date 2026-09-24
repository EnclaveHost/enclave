#!/usr/bin/env bash
# pp-watch.sh <pid>: while <pid> lives, answer the two dialogs a harness reinstall can raise on the phone, and log each tap.
#   Play Protect "Send app for a security check?" -> "Don't send" (nothing leaves the phone; no setting changes)
#   "Android App Compatibility" (16 KB ELF alignment notice for a debuggable app) -> "OK"
set -u
A=~/Projects/optee-anchor-spike/bin/platform-tools/adb
tap_text() {   # tap the centre of the node whose text is exactly $1 in the current UI dump
  local b; b=$($A shell "grep -o 'text=\"$1\"[^>]*bounds=\"[^\"]*\"' /data/local/tmp/ppw.xml" </dev/null | grep -o 'bounds="[^"]*"' | head -1 | tr -dc '0-9,[]')
  [[ $b =~ \[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\] ]] || return 1
  $A shell "input tap $(( (BASH_REMATCH[1]+BASH_REMATCH[3])/2 )) $(( (BASH_REMATCH[2]+BASH_REMATCH[4])/2 ))" </dev/null
}
while kill -0 "$1" 2>/dev/null; do
  f=$($A shell "dumpsys window | grep -m1 mCurrentFocus" </dev/null 2>/dev/null)
  if grep -q "PlayProtectDialogsActivity\|u0 android}" <<<"$f"; then
    $A shell "uiautomator dump /data/local/tmp/ppw.xml" </dev/null >/dev/null 2>&1
    if $A shell "grep -q 'Send app for a security check' /data/local/tmp/ppw.xml" </dev/null; then
      tap_text "Don.t send" && echo "$(date +%T) Play Protect: tapped Don't send"
    elif $A shell "grep -q 'Android App Compatibility' /data/local/tmp/ppw.xml" </dev/null; then
      tap_text "OK" && echo "$(date +%T) App Compatibility notice: tapped OK"
    fi
  fi
  sleep 5
done
echo "$(date +%T) pp-watch end"
