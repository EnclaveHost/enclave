import {getAddress, parseAbi, stringToHex} from "viem";
import {readSessionFactoryIdentity, checkSessionFactoryIdentity} from "./session-factories.mjs";

const ABI = parseAbi([
  "function implementation() view returns (address)",
  "function factory() view returns (address)",
  "function book() view returns (address)",
  "function usdc() view returns (address)",
  "function addr(bytes32) view returns (address)",
]);
const address = (value, what) => {
  const a = getAddress(value);
  if (/^0x0{40}$/i.test(a)) throw Error(`session ${what} is unset`);
  return a;
};

/**
 * Resolve both the production SessionVaultFactory and the optional fixed-binding
 * factory through their shared implementation/book interface. The caller must
 * supply one block and obtain quorum agreement over this entire result.
 * Selecting a factory also selects its book's administration. These are current
 * bindings, not a claim that the book can never change.
 */
export async function readSessionAuthority(client, blockNumber, {factory, deployments, appCatalog, usdc, reviewed = false}) {
  if (typeof blockNumber !== "bigint") throw Error("session authority requires an explicit block");
  factory = address(factory, "factory");
  const read = (target, functionName, args = []) =>
    client.readContract({address: target, abi: ABI, functionName, args, blockNumber});
  const implementation = address(await read(factory, "implementation"), "implementation");
  const [rawFactory, rawBook, rawToken] = await Promise.all([
    read(implementation, "factory"), read(implementation, "book"), read(implementation, "usdc"),
  ]);
  if (address(rawFactory, "implementation factory") !== factory)
    throw Error("session implementation belongs to another factory");
  const book = address(rawBook, "address book"), token = address(rawToken, "token");
  const [rawLedger, rawCatalog] = await Promise.all([
    read(book, "addr", [stringToHex("deployments", {size: 32})]),
    read(book, "addr", [stringToHex("appCatalog", {size: 32})]),
  ]);
  const ledger = address(rawLedger, "deployments"), catalog = address(rawCatalog, "catalog");
  for (const [key, actual, expected] of [
    ["deployments", ledger, deployments], ["appCatalog", catalog, appCatalog], ["usdc", token, usdc],
  ]) {
    if (expected !== undefined && actual !== address(expected, key))
      throw Error(`session factory ${key} differs from the reviewed selection; review updated platform bindings before signing`);
  }
  // reviewed: the factory and implementation runtimes and the implementation's book must be the reviewed ones for the
  // factory's kind (network/session-factories.mjs) at this same block - the production book-bound factory or the optional
  // pinned one; anything else is refused rather than trusted by its interface.
  const identity = reviewed ? checkSessionFactoryIdentity(factory, await readSessionFactoryIdentity(client, blockNumber, factory)) : null;
  return {factory, implementation, book, deployments: ledger, appCatalog: catalog, usdc: token, ...(identity ? {kind: identity.kind} : {})};
}
