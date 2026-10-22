#!/usr/bin/env bash
timeout 40 ssh -o BatchMode=yes -o ConnectTimeout=8 ap-southeast 'for u in enclave-route-dns enclave-public-directory enclave-dns-front enclave-network-provider; do echo "--- $u"; journalctl -u $u --since "-75 min" --no-pager -o short-iso 2>/dev/null | cut -c1-240 | tail -40; done'
