/* ============================================================
   The owner's check of a pending session grant (pages/grant.js,
   independent mode): the EIP-712 SessionGrant that
   `enclave --independent session new --owner <wallet>` prints, turned
   back into a grant field for field from the sessions SDK's own type,
   and compared with the SDK's rebuild for the vault this wallet has on
   the pinned factory. Anything else - an extra or missing field, a
   different chain, vault, domain or type list - is refused before a
   signature is asked for. Pure: the SDK module is passed in.
   ============================================================ */
const json = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** Parse pasted typed data. -> { grant, typed }. Throws with a reason the page shows. */
export function parseTypedGrant(text, S, cfg){
  let td;
  try { td = JSON.parse(String(text || "").trim()); } catch { throw new Error("That is not JSON: paste the typed data exactly as the command printed it."); }
  if (!td || typeof td !== "object" || td.primaryType !== "SessionGrant" || !td.message || typeof td.message !== "object" || !td.domain || typeof td.domain !== "object")
    throw new Error("That is not a SessionGrant request.");
  const fields = S.TYPES.SessionGrant, m = td.message;
  if (Object.keys(m).length !== fields.length || fields.some((f) => !Object.hasOwn(m, f.name)))
    throw new Error("This SessionGrant has unexpected or missing fields. Do not approve it.");
  if (Number(td.domain.chainId) !== Number(cfg.chainId)) throw new Error("This request is for chain " + td.domain.chainId + ", not " + cfg.chainId + ".");
  const grant = {};
  for (const { name, type } of fields){
    const v = m[name];
    if (/^uint(256|64)$/.test(type)){ if (!/^\d+$/.test(String(v))) throw new Error("This SessionGrant has a malformed " + name + "."); grant[name] = BigInt(String(v)); }
    else if (type === "uint32"){ if (!Number.isSafeInteger(Number(v)) || Number(v) < 0 || Number(v) > 0xffffffff || String(Number(v)) !== String(v)) throw new Error("This SessionGrant has a malformed " + name + "."); grant[name] = Number(v); }
    else if (type === "string[]"){ if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error("This SessionGrant has a malformed " + name + "."); grant[name] = [...v]; }
    else if (type === "bytes32"){ if (!/^0x[0-9a-fA-F]{64}$/.test(String(v))) throw new Error("This SessionGrant has a malformed " + name + "."); grant[name] = String(v); }
    else { if (typeof v !== "string") throw new Error("This SessionGrant has a malformed " + name + "."); grant[name] = v; }
  }
  return { grant, typed: td };
}

/* field order from the SDK's type, so key order in the pasted text does not matter (only the values do) */
function normalize(t, S){
  const d = t.domain || {};
  return json({ primaryType: t.primaryType,
    domain: { name: d.name, version: d.version, chainId: Number(d.chainId), verifyingContract: String(d.verifyingContract || "").toLowerCase(),
              extra: Object.keys(d).filter((k) => !["name", "version", "chainId", "verifyingContract"].includes(k)) },
    types: t.types,
    message: Object.fromEntries(S.TYPES.SessionGrant.map((f) => [f.name, t.message[f.name]])) });
}

/** The pasted typed data must be exactly the SDK's SessionGrant for `vault` (this wallet's, on the pinned factory). */
export function checkTypedGrant(typed, grant, { S, chainId, vault }){
  if (String(typed.domain.verifyingContract || "").toLowerCase() !== String(vault).toLowerCase())
    throw new Error("This grant is for vault " + typed.domain.verifyingContract + ", not your wallet’s vault " + String(vault).toLowerCase()
      + " on the pinned factory. Connect the wallet the command named.");
  const expected = S.grantTypedData(chainId, vault, grant);
  if (normalize(typed, S) !== normalize(expected, S)) throw new Error("This typed data is not exactly the SDK’s SessionGrant for these values. Do not approve it.");
  return expected;
}
