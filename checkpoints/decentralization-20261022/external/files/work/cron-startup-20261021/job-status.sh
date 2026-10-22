#!/bin/bash
# read-only public status of the deployment (empty HOME: no key, no session)
cd "$(dirname "$0")"
H=$(mktemp -d); env -i PATH="$PATH" HOME="$H" XDG_CONFIG_HOME="$H/.config" timeout 120 node ../enclave/cli/enclave.mjs --json --unsigned --from 0x0b2d009c0c9Af05b12100D77F3c815fea822eE61 status 0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c > status.json 2> status.err; echo rc=$?; rm -rf "$H"
