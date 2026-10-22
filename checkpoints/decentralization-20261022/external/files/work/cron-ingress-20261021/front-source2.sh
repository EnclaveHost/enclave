#!/usr/bin/env bash
timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=8 ap-southeast 'f=/opt/enclave-directory/runtime-cb9ff18/enclave-directory.mjs; grep -oE ".{0,420}no current passing verdict.{0,60}" "$f" | head -1; grep -oE "route state changed during verification.{0,10}" "$f" | head -1; grep -c "no_current_verified_route" "$f"'
