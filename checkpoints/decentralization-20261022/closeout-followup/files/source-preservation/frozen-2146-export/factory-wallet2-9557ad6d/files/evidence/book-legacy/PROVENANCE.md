# The deployed original EnclaveAddressBook (0xab214342…): actual ABI

- Root's live read-check (`custody-v2-live-20261023/evidence/book-abi-readcheck.json`, block 52,999,644, both providers):
  - code hash `0xe4f570e9…`;
  - `owner()` (0x8da5cb5b) is present and answers the administrator;
  - `pendingOwner()` (0xe30c3978) is NOT in the code, and the call reverts.
- Source: `EnclaveAddressBook.sol` as committed at `/home/steven/Projects/enclave` 6c1135b0f (2026-07-07), sha256
  `124aa407863e2213d8ef700e6e9492e9112b7a8e1ce50fc10f324b781173ac9a`. It has a single-step `setOwner`: no pending owner, no
  two-step handoff. The later source (two-step `pendingOwner`/`acceptOwnership`, 2026-07-14) is NOT what is deployed.
- Reproduced offline (`reproduce.cjs`, that commit's deploy settings: solc 0.8.35, optimizer runs 200, no viaIR):
  - runtime = `runtime.hex`, 1809 bytes, keccak `0xe4f570e99f2ac708b35539fe5906889d8cb99189e6c9075f5e46d3b6921ac152`,
    equal to the deployed code hash pinned from live evidence;
  - ABI = `EnclaveAddressBook.abi.json` (that commit's committed ABI).
- Functions: `owner()`, `addr(bytes32)`, `set(bytes32,address)`, `setMany(bytes32[],address[])`, `all()`, `count()`,
  `setOwner(address)`. Events: `AddressSet(bytes32 indexed key, address value)`, `OwnerChanged(address)`.
