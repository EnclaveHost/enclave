#!/bin/sh
# Point the NucBox's Shield manager at the approved native desktop release and restart it (see shield-svn18.ps1).
#   bash shield-svn18.sh           make the change (puts the previous file back by itself if the manager refuses)
#   bash shield-svn18.sh revert    put the previous run-shield.cmd back and restart the manager
set -eu
here=$(cd "$(dirname "$0")" && pwd)
script=shield-svn18.ps1
[ "${1:-}" = revert ] && script=shield-svn18-revert.ps1
exec ssh -o BatchMode=yes -o ConnectTimeout=10 minipc "powershell -NoProfile -ExecutionPolicy Bypass -Command -" < "$here/$script"
