#!/bin/sh
# Read-only: grep a file as committed at HEAD (stable line numbers while other workstreams edit the tree).
# usage: hgrep.sh REPO PATH PATTERN [grep opts]
repo=$1; p=$2; pat=$3; shift 3
git -C "$repo" show "HEAD:$p" | grep -n -E "$@" -- "$pat"
