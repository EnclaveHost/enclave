#!/bin/bash
# read-only: the live options envelope of the publisher deployment (empty HOME, no key)
cd "$(dirname "$0")"
H=$(mktemp -d); env -i PATH="$PATH" HOME="$H" XDG_CONFIG_HOME="$H/.config" node /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/cli/enclave.mjs --json --unsigned --from 0x0b2d009c0c9Af05b12100D77F3c815fea822eE61 config show 0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a > live-envelope.json; rc=$?; rm -rf "$H"; echo rc=$rc
