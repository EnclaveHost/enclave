/* Decode the owner-gated EnclaveDeployments calls the deployments panel builds
   (js/core/sessions.js replays them as session actions for vault-held rows).
   Pure: no DOM, no network - test/site-ledger-calls.test.mjs pins it against viem. */
export const SEL = { setAppRef: "4d506615", setShares: "00bc2be4", setConfig: "df6e40ba", setActive: "6485d678",
  setMaxRate: "2d3e461f", refund: "7249fbb6", multicall: "ac9650d8", transferDeployment: "dd68b480" };
const word = (h, i) => h.slice(i * 64, (i + 1) * 64);
const bytesAt = (h, offBytes) => { const o = offBytes * 2; const len = parseInt(h.slice(o, o + 64), 16); return h.slice(o + 64, o + 64 + len * 2); };
const hexToStr = (h) => new TextDecoder().decode(Uint8Array.from((h.match(/../g) || []).map((b) => parseInt(b, 16))));

/** Decode one owner-gated ledger call the panel built. */
export function decodeLedgerCall(data){
  const d = String(data).replace(/^0x/, "").toLowerCase();
  const sel = d.slice(0, 8), a = d.slice(8);
  const id = "0x" + word(a, 0);
  switch (sel){
    case SEL.setActive: return { fn: "setActive", id, active: BigInt("0x" + word(a, 1)) !== 0n };
    case SEL.setShares: return { fn: "setShares", id, gpuMilli: Number(BigInt("0x" + word(a, 1))), cpuMilli: Number(BigInt("0x" + word(a, 2))) };
    case SEL.setMaxRate: return { fn: "setMaxRate", id, maxRate6: BigInt("0x" + word(a, 1)) };
    case SEL.refund: return { fn: "refund", id };
    case SEL.setAppRef: return { fn: "setAppRef", id, appRef: hexToStr(bytesAt(a, Number(BigInt("0x" + word(a, 1))))) };
    case SEL.setConfig: return { fn: "setConfig", id, configCid: hexToStr(bytesAt(a, Number(BigInt("0x" + word(a, 1))))) };
    case SEL.transferDeployment: return { fn: "transferDeployment", id, to: "0x" + word(a, 1).slice(24) };
    case SEL.multicall: {
      const arr = Number(BigInt("0x" + word(a, 0))) * 2;            // offset of the bytes[] (in hex chars)
      const body = a.slice(arr);
      const n = Number(BigInt("0x" + body.slice(0, 64)));
      const heads = body.slice(64);
      const calls = [];
      for (let i = 0; i < n; i++){
        const off = Number(BigInt("0x" + word(heads, i))) * 2;
        const len = Number(BigInt("0x" + heads.slice(off, off + 64)));
        calls.push(decodeLedgerCall("0x" + heads.slice(off + 64, off + 64 + len * 2)));
      }
      return { fn: "multicall", id: calls[0] && calls[0].id, calls };
    }
  }
  return { fn: "unknown", id };
}

