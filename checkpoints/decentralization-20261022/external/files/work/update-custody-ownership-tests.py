from pathlib import Path
p=Path('work/enclave/scripts/deploy-secret-vault-v2.mjs');s=p.read_text()
s=s.replace('// Constructor (book, enclaveOwner):','// Constructor (book, enclaveOwner, hostOwnership):').replace('//   - enclaveOwner: the payout wallet that makes a host\'s machines Enclave-owned, i.e. the Enclave seat','//   - enclaveOwner: the accepted owning wallet that identifies the Enclave seat')
s=s.replace('//\n// NOT done here', '//   - hostOwnership: deployed EnclaveHostOwnership, pinning the host registry and accepted owners.\n//\n// NOT done here',1)
s=s.replace('export function compileSecretVaultV2() {','export const compileSecretVaultV2 = () => compileContract("EnclaveSecretVaultV2");\nexport const compileHostOwnership = () => compileContract("EnclaveHostOwnership");\nfunction compileContract(name) {')
s=s.replace('sources: { "EnclaveSecretVaultV2.sol": { content: fs.readFileSync(SOURCE, "utf8") } },','sources: { [name+".sol"]: { content: fs.readFileSync(path.join(REPO,"contracts",name+".sol"), "utf8") } },')
s=s.replace('const c = out.contracts["EnclaveSecretVaultV2.sol"].EnclaveSecretVaultV2;','const c = out.contracts[name+".sol"][name];')
s=s.replace('privateKey, book, enclaveOwner, log','privateKey, book, enclaveOwner, hostOwnership, log').replace('ENCLAVE_OWNER (the Enclave seat\'s payout wallet)','ENCLAVE_OWNER (the Enclave seat\'s accepted owning wallet)')
s=s.replace('  const art = compileSecretVaultV2();','  if (!isAddress(hostOwnership || "") || /^0x0{40}$/i.test(hostOwnership)) die("HOST_OWNERSHIP (the deployed host ownership contract) is required");\n  const art = compileSecretVaultV2();')
s=s.replace('enclaveOwner = ${getAddress(enclaveOwner)})','enclaveOwner = ${getAddress(enclaveOwner)}, hostOwnership = ${getAddress(hostOwnership)})')
s=s.replace('args: [book, enclaveOwner]','args: [book, enclaveOwner, hostOwnership]')
s=s.replace('  log(`deployed ${vault}', '''  const gotOwnership = await readBack(pc, vault, art.abi, "hostOwnership");
  if (!gotOwnership || getAddress(gotOwnership) !== getAddress(hostOwnership)) die("hostOwnership read-back mismatch");
  log(`deployed ${vault}''')
s=s.replace('book: process.env.BOOK || net.book, enclaveOwner:', 'hostOwnership: process.env.HOST_OWNERSHIP, book: process.env.BOOK || net.book, enclaveOwner:')
p.write_text(s)
p=Path('work/enclave/test/custody-v2-e2e.test.mjs');s=p.read_text()
s=s.replace('  const key = createHash("sha256").update(src).update(MOCKS)', '  const ownershipSrc = fs.readFileSync(path.join(ROOT, "contracts/EnclaveHostOwnership.sol"), "utf8");\n  const key = createHash("sha256").update(src).update(ownershipSrc).update(MOCKS)')
s=s.replace('"Rig.sol": { content: MOCKS } },','"Rig.sol": { content: MOCKS }, "Ownership.sol": {content: ownershipSrc} },')
s=s.replace('const r = { vault:', 'const r = { ownership: pick("Ownership.sol", "EnclaveHostOwnership"), vault:')
s=s.replace('const deployer = await acct(), enclaveOwner = (await acct()).address;', 'const deployer = await acct(), enclaveWallet = await acct(), enclaveOwner = enclaveWallet.address;')
s=s.replace('const vault = (await deploy(deployer, C.vault, [book, enclaveOwner])).toLowerCase();','const ownership = await deploy(deployer, C.ownership, [registry]);\n    const vault = (await deploy(deployer, C.vault, [book, enclaveOwner, ownership])).toLowerCase();')
s=s.replace('// ---- hosts: two Enclave-owned (payout = enclaveOwner), two others, one app host ----','// ---- hosts: two accepted by Enclave wallet, two others, one app host ----')
s=s.replace('      hosts[name] = { op, endpoint, registryId: keccak256(toBytes(endpoint)) };','''      const registryId = keccak256(toBytes(endpoint)), owner = enclave ? enclaveWallet : op;
      await send(op, ownership, C.ownership.abi, "proposeOwner", [registryId, owner.address]);
      await send(owner, ownership, C.ownership.abi, "acceptOwner", [registryId]);
      hosts[name] = { op, endpoint, registryId };''')
p.write_text(s)
p=Path('work/enclave/test/custody-v2-deploy.test.mjs');s=p.read_text().replace('compileSecretVaultV2, EIP170','compileSecretVaultV2, compileHostOwnership, EIP170')
s=s.replace('enclaveOwner: NETWORKS.base.enclaveOwner, dryRun:', 'enclaveOwner: NETWORKS.base.enclaveOwner, hostOwnership: "0x"+"12".repeat(20), dryRun:')
s=s.replace('    const logs = [];\n    const r = await deploySecretVaultV2', '''    const registry = (await a.client.waitForTransactionReceipt({hash:await w.deployContract({abi:C.registry.abi,bytecode:C.registry.bytecode})})).contractAddress;
    const ownershipArtifact = compileHostOwnership();
    const hostOwnership = (await a.client.waitForTransactionReceipt({hash:await w.deployContract({abi:ownershipArtifact.abi,bytecode:ownershipArtifact.bytecode,args:[registry]})})).contractAddress;
    const logs = [];
    const r = await deploySecretVaultV2''')
s=s.replace('privateKey: key, book, enclaveOwner, log:', 'privateKey: key, book, enclaveOwner, hostOwnership, log:')
p.write_text(s)
