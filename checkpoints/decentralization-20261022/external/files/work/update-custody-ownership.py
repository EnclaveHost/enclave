from pathlib import Path
p=Path('work/enclave/contracts/EnclaveSecretVaultV2.sol');s=p.read_text()
s=s.replace('interface IVaultV2Factory', '''interface IVaultV2HostOwnership {
    function registry() external view returns (address);
    function authority(bytes32 hostId) external view returns (address owner, address pendingOwner, uint64 revision, bytes32 policyHash);
}
interface IVaultV2Factory''')
s=s.replace('    bytes32 private constant BOOK_REGISTRY = "registry";\n','')
s=s.replace('    address public immutable enclaveOwner;', '    address public immutable enclaveOwner;\n    IVaultV2HostOwnership public immutable hostOwnership;\n    address public immutable hostRegistry;')
s=s.replace('constructor(address book_, address enclaveOwner_) {','constructor(address book_, address enclaveOwner_, address hostOwnership_) {')
s=s.replace('        book = IVaultV2Book(book_);','''        if (hostOwnership_.code.length == 0) revert BadHost();
        hostOwnership = IVaultV2HostOwnership(hostOwnership_);
        address registry_ = IVaultV2HostOwnership(hostOwnership_).registry();
        if (registry_.code.length == 0) revert NoRegistry();
        hostRegistry = registry_;
        book = IVaultV2Book(book_);''')
a=s.index('    /// the host\'s registry entry, schema-4 prefix:');b=s.index('    /// shape checks',a)
s=s[:a]+'''    /// The ownership contract pins the registry. A mutable address-book entry
    /// cannot reclassify a host. Only operator and active from its stable prefix
    /// are read here; payout declarations never confer custody authority.
    function _hostOf(bytes32 registryId) private view returns (address operator, bool active) {
        (bool ok, bytes memory ret) = hostRegistry.staticcall(abi.encodeCall(IVaultV2Registry.get, (registryId)));
        if (!ok || ret.length < 32) revert BadHost();
        uint256 base;
        assembly ("memory-safe") { base := mload(add(ret, 32)) }
        if (base > ret.length || ret.length - base < 7 * 32) revert BadHost();
        uint256 wOp; uint256 wActive;
        assembly ("memory-safe") {
            let p := add(add(ret, 32), base)
            wOp := mload(add(p, 96))
            wActive := mload(add(p, 192))
        }
        if (wOp >> 160 != 0 || wActive > 1) revert BadHost();
        return (address(uint160(wOp)), wActive == 1);
    }

'''+s[b:]
s=s.replace('(address operator, bool active, address payout) = _hostOf(m.registryId);','(address operator, bool active) = _hostOf(m.registryId);')
s=s.replace('        return payout == enclaveOwner;','        (address owner,,,) = hostOwnership.authority(m.registryId);\n        if (owner == address(0)) revert BadHost();\n        return owner == enclaveOwner;')
p.write_text(s)
p=Path('work/enclave/custody/v2/chain.mjs');s=p.read_text()
s=s.replace('export const VAULT_V2_ABI = [','''const HOST_OWNERSHIP_ABI = [
  { type: "function", name: "authority", stateMutability: "view", inputs: [{type:"bytes32"}], outputs: [{type:"address"},{type:"address"},{type:"uint64"},{type:"bytes32"}] },
];
export const VAULT_V2_ABI = [
  { type: "function", name: "hostOwnership", stateMutability: "view", inputs: [], outputs: [{type:"address"}] },
  { type: "function", name: "hostRegistry", stateMutability: "view", inputs: [], outputs: [{type:"address"}] },''')
a=s.index('    // the host entry a machine names:');s=s[:a]+'''    // Membership is only supported on the wallet-authority vault release.
    // No fallback to payoutWallet or a mutable book registry. Old vaults must
    // keep their old measured membership runtime until a controlled handover.
    readRegistryEntry: ({ registryId }) => agreed(withBlock(async (c, n) => {
      const rd = rdOf(c, n);
      const [reg, ownership] = await Promise.all([rd(vault, VAULT_V2_ABI, "hostRegistry"), rd(vault, VAULT_V2_ABI, "hostOwnership")]);
      if (reg === ZERO || ownership === ZERO) throw err("host_authority_missing", "wallet host authority required");
      const [e, authority] = await Promise.all([rd(reg, REGISTRY_V4_ABI, "get", [registryId]), rd(ownership, HOST_OWNERSHIP_ABI, "authority", [registryId])]);
      return { entry: { endpoint: e.endpoint, active: e.active, operator: lc(e.operator), payoutWallet: lc(e.payoutWallet), owner: lc(authority[0]) } };
    })).then(fresh),
  };
}
'''
p.write_text(s)
p=Path('work/enclave/custody/v2/member.mjs');s=p.read_text().replace('r.entry.payoutWallet === lc(enclaveOwner)','r.entry.owner === lc(enclaveOwner)').replace('reg.entry.payoutWallet === lc(enclaveOwner)','reg.entry.owner === lc(enclaveOwner)')
s=s.replace('    st.hostSig = sig; save();','    if (!r.entry.owner || /^0x0{40}$/.test(r.entry.owner)) throw new Error("host wallet ownership has not been accepted");\n    st.hostSig = sig; save();')
s=s.replace('    const enclave = reg.entry.owner', '    if (!reg.entry.owner || /^0x0{40}$/.test(reg.entry.owner)) return { ok: false, reason: "host wallet ownership has not been accepted" };\n    const enclave = reg.entry.owner')
p.write_text(s)
p=Path('work/enclave/contracts/foundry/test/EnclaveSecretVaultV2.t.sol');s=p.read_text().replace('import { EnclaveRegistry }', 'import { EnclaveHostOwnership } from "../../EnclaveHostOwnership.sol";\nimport { EnclaveRegistry }')
s=s.replace('    EnclaveRegistry registry;','    EnclaveRegistry registry;\n    EnclaveHostOwnership ownership;')
s=s.replace('        vault = new EnclaveSecretVaultV2(address(book), enclaveOwner);','        ownership = new EnclaveHostOwnership(address(registry));\n        vault = new EnclaveSecretVaultV2(address(book), enclaveOwner, address(ownership));')
s=s.replace('        if (payout != address(0)) { vm.prank(payout); registry.setPayoutWallet(rid); }','''        if (payout != address(0)) {
            vm.prank(payout); registry.setPayoutWallet(rid);
            vm.prank(vm.addr(k)); ownership.proposeOwner(rid,payout);
            vm.prank(payout); ownership.acceptOwner(rid);
        }''')
s=s.replace('// no payout wallet declared at all','// no accepted ownership at all').replace('        vm.expectRevert(EnclaveSecretVaultV2.NotEnclave.selector);\n        vault.createCommittee("salt", b,', '        vm.expectRevert(EnclaveSecretVaultV2.BadHost.selector);\n        vault.createCommittee("salt", b,')
s=s.replace('// the Enclave wallet clears its declaration: no longer Enclave-owned','// ownership transfers: the former owner no longer classifies this host')
s=s.replace('        vm.prank(enclaveOwner); registry.clearPayoutWallet(e.registryId);','        vm.prank(enclaveOwner); ownership.proposeOwner(e.registryId,otherWallet);\n        vm.prank(otherWallet); ownership.acceptOwner(e.registryId);')
s=s.replace('// no registry in the book','// an address-book edit cannot change the pinned host registry').replace('        vm.expectRevert(EnclaveSecretVaultV2.NoRegistry.selector);\n        vault.createCommittee("salt", u,','        vm.expectRevert(EnclaveSecretVaultV2.BadHost.selector);\n        vault.createCommittee("salt", u,')
s=s.replace('new EnclaveSecretVaultV2(address(0), enclaveOwner);','new EnclaveSecretVaultV2(address(0), enclaveOwner, address(ownership));').replace('new EnclaveSecretVaultV2(address(book), address(0));','new EnclaveSecretVaultV2(address(book), address(0), address(ownership));')
s=s.replace('    function test_constructorAndImmutables() public {','''    function testPayoutSpoofDoesNotGrantEnclaveSeat() public {
        EnclaveSecretVaultV2.Machine memory m = _machine(51,false);
        vm.prank(enclaveOwner); registry.setPayoutWallet(m.registryId);
        bytes32[] memory cs = _codeSet();
        bytes memory sig = _psign(idKey[m.identity],_genesisDigest(_cid("salt"),m,cs));
        bytes memory hs = _hostSig(m);
        vm.expectRevert(EnclaveSecretVaultV2.NotEnclave.selector);
        vault.createCommittee("salt",m,Y,cs,sig,hs);
    }
    function testPayoutChangeAndBookEditCannotRemoveAcceptedOwnership() public {
        EnclaveSecretVaultV2.Machine memory m = _machine(52,true);
        vm.prank(stranger); registry.setPayoutWallet(m.registryId);
        book.set("registry",address(0));
        bytes32 cid = _genesis(m);
        (,bool[] memory enc) = vault.machinesOf(cid,1);
        assertTrue(enc[0]);
    }
    function test_constructorAndImmutables() public {
        assertEq(address(vault.hostOwnership()), address(ownership));
        assertEq(vault.hostRegistry(), address(registry));''')
p.write_text(s)
