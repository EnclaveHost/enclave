// EIP-191 "personal_sign" hash of a text message: what a wallet signs, and what a passkey vault's assertion must use as
// its challenge for the vault's ERC-1271 check (docs/design/enclave-network.md).
import {keccak256Hex} from "./keccak.js";
const hex=bytes=>"0x"+[...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
export function eip191Hash(message){
  const body=new TextEncoder().encode(message),prefix=new TextEncoder().encode("\x19Ethereum Signed Message:\n"+body.length);
  const all=new Uint8Array(prefix.length+body.length);all.set(prefix);all.set(body,prefix.length);return keccak256Hex(hex(all));
}
