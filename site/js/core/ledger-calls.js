/* Decode the owner-gated EnclaveDeployments calls the deployments panel builds
   (js/core/sessions.js replays them as session actions for vault-held rows, and
   for rows the wallet holds once the owner has let its vault act for it).
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

/* A decoded call on a record the connected WALLET holds, replayed by this browser's session through the
   owner's ledger delegation (ledger rev 15d setDelegate + SessionVault v2). To a session such a record is
   always PRODUCTION: it may suspend/resume, resize, cancel (the refund pays the wallet) and LOWER the price
   cap - never change what it runs (version, config) and never move it. Returns the session actions in
   order (a multicall goes call by call), or null when the wallet must send the call itself: a version or
   config change, a transfer, a raised cap, a batch touching another deployment, anything unknown.
   `cap` is the record's current capOf (needed only when a setMaxRate is in the call). */
export function walletRecordPlan(call, cap){
  if (!call || !call.id) return null;
  const calls = call.fn === "multicall" ? call.calls : [call];
  if (!Array.isArray(calls) || !calls.length) return null;
  const id = String(call.id).toLowerCase();
  let ceiling = cap === undefined || cap === null ? null : BigInt(cap);
  const plan = [];
  for (const c of calls){
    if (!c || String(c.id || "").toLowerCase() !== id) return null;
    switch (c.fn){
      case "setActive": plan.push({ action: "deploy.setActive", args: { id: c.id, active: c.active } }); break;
      case "setShares": plan.push({ action: "deploy.setShares", args: { id: c.id, gpuMilli: c.gpuMilli, cpuMilli: c.cpuMilli } }); break;
      case "refund": plan.push({ action: "deploy.refund", args: { id: c.id } }); break;
      case "setMaxRate":
        // only ever lowered (or kept): each step against the cap the previous one left
        if (ceiling === null || c.maxRate6 > ceiling) return null;
        ceiling = c.maxRate6;
        plan.push({ action: "deploy.setMaxRate", args: { id: c.id, maxRate6: c.maxRate6 } });
        break;
      default: return null;
    }
  }
  return plan;
}

/** Whether walletRecordPlan needs the record's current cap for this call. */
export const needsCap = (call) => (call && call.fn === "multicall" ? call.calls || [] : [call]).some((c) => c && c.fn === "setMaxRate");
