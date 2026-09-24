// verifier/web/collateral.mjs: the in-memory collateral adapter for the browser build (verifier/collateral.mjs's memoryCollateral
// without the node:fs neighbours). Bytes in, bytes out: a page that fetched the chain, the VCEK and the CRL itself, or holds
// them from the report's own certificate table, hands them here. Correctness never rests on the source (the chain and the
// VCEK's extensions decide), so this adapter says only where the bytes came from.
export function memoryCollateral({ chains = {}, vceks = {}, crls = {} } = {}, source = "memory") {
  return {
    kind: "memory",
    chain: (product) => { if (!chains[product]) throw new Error(`no AMD chain held for ${product}`); return { pem: chains[product], source }; },
    vcek: (product, chipIdHex, tcbHex) => { const d = vceks[`${product}-${chipIdHex}-${tcbHex}`] || vceks[product]; return d ? { der: d, source } : null; },
    crl: (product) => (crls[product] ? { der: crls[product], source } : null),
  };
}
