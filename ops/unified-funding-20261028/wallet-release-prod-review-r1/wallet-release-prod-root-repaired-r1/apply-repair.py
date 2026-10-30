from pathlib import Path
p=Path(__file__).resolve().parent/'candidate/enclave/site/js/core'
def edit(name,old,new):
 f=p/name;s=f.read_text();assert s.count(old)==1,(name,old[:70],s.count(old));f.write_text(s.replace(old,new))
edit('wallet-release-chain.js','  delegateSlot: 23n,','  catalog: "0x18419ca2b502d423a8de6269aeee171a378626e3",\n  catalogCodeHash: "0x3f3c4cc028abd3e117465362e196243cafaaffa7508dc6297d78a6b709dcc79f",\n  delegateSlot: 23n,')
edit('wallet-release-chain.js','    storageAt: async (address, slot, blockNumber) => (await pc.getStorageAt({ address, slot, blockNumber })) || ZERO32,','''    storageAt: async (address, slot, blockNumber) => {
      const value = await pc.getStorageAt({ address, slot, blockNumber });
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ReleaseBlocked("storage-word", "Missing or malformed delegation storage word.");
      return value;
    },''')
edit('wallet-release-chain.js','    const at = BigInt(snap.block.number), row = snap.pre.row, p = parseCatalogRef(row.appRef);','''    if (await reader.chainId() !== PINS.chainId) return { ok: false, reason: "Catalog endpoint is on another chain." };
    const at = BigInt(snap.block.number), row = snap.pre.row, p = parseCatalogRef(row.appRef);''')
edit('wallet-release-chain.js','    if (!isHex32(code) || code === EMPTY_CODE) return { ok: false, reason: "The app catalog has no code at the checked block." };','    if (cat !== PINS.catalog || code !== PINS.catalogCodeHash) return { ok: false, reason: "The app catalog is not the reviewed contract at the checked block." };')
edit('wallet-release-census.js','canon, evaluate, viemReader }','canon, evaluate, viemReader, readCatalog }')
edit('wallet-release-census.js','    wallet, vault, stats,','''    wallet, vault, stats,
    async readCatalog(snap){
      try {
        need(snap.identity.chainId === PINS.chainId && lower(snap.identity.vault) === vault && lower(snap.identity.wallet) === wallet && lower(snap.identity.ledger) === PINS.ledger, "catalog-identity", "Catalog check belongs to another deployment domain.");
        need(Math.abs(nowSec() - Number(snap.block.timestamp)) <= MAX_BLOCK_AGE_SEC, "catalog-stale", "Catalog snapshot is stale.");
        const { H } = pairs(), at = BigInt(snap.block.number);
        await pinBlock(H, at, snap.block.hash, "catalog-block", "the catalog snapshot");
        const value = await agree(H, "catalog", (r) => readCatalog(r, snap));
        await pinBlock(H, at, snap.block.hash, "catalog-reorg", "the catalog snapshot after reading");
        return value;
      } catch(e){ return { ok: false, reason: "Independent catalog verification failed: " + short(e) }; }
    },''')
for name in ['wallet-release-controller.js','wallet-release-promote.js']:
 f=p/name;s=f.read_text();assert 'await readCatalog(reader, snap)' in s;f.write_text(s.replace('await readCatalog(reader, snap)','await census.readCatalog(snap)'))
edit('wallet-release-store.js','  const parts = journalKey(identity).split(":").slice(1, 4).join(":") + ":";','  const parts = journalKey(identity).split(":")[1] + ":"; // scan all ledgers: owner nonces belong to the vault')
edit('wallet-release-store.js','export function fenceConflict(rows, rec){','''const sameOwnerDomain = (r, identity) => r && r.identity && Number(r.identity.chainId) === Number(identity.chainId) && lower(r.identity.vault) === lower(identity.vault) && lower(r.identity.owner) === lower(identity.owner);
export function fenceConflict(rows, rec){''')
edit('wallet-release-store.js','    if (!r || !r.identity || lower(r.identity.owner) !== owner || r.key === rec.key) continue;','    if (!sameOwnerDomain(r, rec.identity) || r.key === rec.key) continue;')
edit('wallet-release-store.js','rows.filter((r) => lower(r.identity && r.identity.owner) === lower(identity.owner))','rows.filter((r) => sameOwnerDomain(r, identity))')
edit('wallet-release-store.js','this._vault(identity).filter((r) => lower(r.identity.owner) === lower(identity.owner))','this._vault(identity).filter((r) => sameOwnerDomain(r, identity))')
edit('wallet-release-promote.js','  const c = decodePromoteCalldata(tx.input);','''  if (lower(tx.hash) !== txHash || lower(rc.transactionHash) !== txHash || tx.blockNumber == null || rc.blockNumber == null || BigInt(tx.blockNumber) !== BigInt(rc.blockNumber) || lower(tx.blockHash) !== lower(rc.blockHash))
    return { status: "conflict", txHash, reasons: ["transaction and receipt identity do not match the requested promotion"] };
  const c = decodePromoteCalldata(tx.input);''')
edit('wallet-release-promote.js','  const at = BigInt(rc.blockNumber);','''  const at = BigInt(rc.blockNumber);
  const membership = await reader.blockTxHashes(at);
  if (!membership || membership.number !== at || lower(membership.hash) !== lower(rc.blockHash) || !Array.isArray(membership.transactions) || membership.transactions.filter((h) => lower(h) === txHash).length !== 1)
    return { status: "pending", txHash, reasons: ["promotion transaction is not in the canonical receipt block"] };''')
edit('wallet-release-promote.js','  const final = fin && fin.number >= at;','''  const anchor = await reader.blockByNumber(at);
  if (!anchor || lower(anchor.hash) !== lower(rc.blockHash)) return { status: "pending", txHash, reasons: ["receipt block changed during promotion state verification"] };
  const final = fin && fin.number >= at;''')
