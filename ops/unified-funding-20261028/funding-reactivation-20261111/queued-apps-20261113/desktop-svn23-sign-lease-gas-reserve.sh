#!/bin/bash
# Enable and fund the lease-gas reserve of KVM Box deployment 0xf9bb979a, from the owner wallet on the Trezor.
# Two transactions on Base to the reserve 0x12A3f873041Dec436DaA0085B766a399A6fA3639 (lease-gas-reserve-f9bb979a.json
# beside this file has them): configure with the policy the other NucBox apps have, then deposit 0.0003 ETH.
# Each is simulated from the owner first, signed with trezorctl as a legacy transaction (cast --trezor signs wrongly
# for this wallet), decoded and checked for its signer, and only then published. You confirm each on the device.
#
#   sign-lease-gas-reserve.sh           both, in order (one already on chain is skipped)
#   DEPOSIT_WEI=N sign-lease-gas-reserve.sh   another deposit amount (default 300000000000000 = 0.0003 ETH)
set -euo pipefail
ID=0xf9bb979ae685c7f16f6c49df3f35f76ff38aca86b5ce3e76e02b83115360dd58
R=0x12A3f873041Dec436DaA0085B766a399A6fA3639
OWN=0x0b2d009c0c9Af05b12100D77F3c815fea822eE61
RPC=${RPC:-https://mainnet.base.org}
PATH_BIP=${PATH_BIP:-m/44h/60h/0h/0/0}
DEPOSIT_WEI=${DEPOSIT_WEI:-300000000000000}
CFG=$(cast calldata 'configure(bytes32,(bool,uint8,bool,uint8,uint64,uint64,uint32,uint32,uint32,uint32,uint64))' $ID '(true,1,true,4,31092172031561,310921720315610,3600,300,600,1800,50000000)')
DEP=$(cast calldata 'deposit(bytes32)' $ID)
SIG='reserveOf(bytes32,address)((uint128,uint64,uint64,bool,uint8,bool,uint32,uint32,uint32,uint32,uint64,uint8,uint32,uint96,uint8,uint64,address))'
reserve() { cast call $R "$SIG" $ID $OWN --rpc-url "$RPC"; }
field() { reserve | tr -d '()' | cut -d, -f"$1" | awk '{print $1}'; }

send() {  # what, data, value-wei, gas-limit
  local what=$1 data=$2 value=$3 gas=$4 nonce price out raw from hash
  cast call $R "$data" --from $OWN --value "$value" --rpc-url "$RPC" >/dev/null || { echo "STOP: $what does not simulate from the owner; nothing signed"; exit 1; }
  nonce=$(cast nonce $OWN --rpc-url "$RPC"); price=$(( $(cast gas-price --rpc-url "$RPC") * 3 ))
  echo "$what: nonce $nonce, gas limit $gas, gas price $price wei, value $value wei. Confirm on the Trezor."
  out=$(trezorctl ethereum sign-tx -c 8453 -n "$PATH_BIP" -g "$gas" -G "$price" -i "$nonce" -d "$data" "$R" "$value")
  raw=$(printf '%s\n' "$out" | grep -oE '0x[0-9a-fA-F]{150,}' | tail -1)
  [ -n "$raw" ] || { echo "STOP: no signed transaction came back from trezorctl; nothing sent"; printf '%s\n' "$out" | tail -3; exit 1; }
  from=$(cast decode-transaction "$raw" | python3 -c 'import sys,json
d=json.load(sys.stdin)
if isinstance(d,str): d=json.loads(d)   # cast 1.7.1 prints the object as a JSON string
print(d.get("signer") or d.get("from") or "")')
  [ "${from,,}" = "${OWN,,}" ] || { echo "STOP: the signed transaction recovers to ${from:-nothing}, not the owner; nothing sent"; exit 1; }
  hash=$(cast publish "$raw" --rpc-url "$RPC")
  echo "$what: sent $hash; waiting for it"
  cast receipt "$hash" --rpc-url "$RPC" --confirmations 2 | grep -E '^(status|blockNumber|gasUsed)' || true
}

echo "reserve before: $(reserve)"
if [ "$(field 4)" = true ]; then echo "configure: already enabled, skipped"; else send configure "$CFG" 0 220000; fi
if [ "$(field 1)" != 0 ]; then echo "deposit: the reserve already holds $(field 1) wei, skipped"; else send "deposit" "$DEP" "$DEPOSIT_WEI" 130000; fi
echo "reserve after: $(reserve)"
