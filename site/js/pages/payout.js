/* ============================================================
   /payout?id=<enclave id>#code=<one-time code> - a box owner
   changes the wallet their box pays its earnings to. Opened from
   the hosting tray (windows/tray), which asks the box's node for
   the code (windows/node/payout.mjs) and puts it in the fragment,
   so it never reaches a server.

   The wallet declares ITSELF: EnclaveRegistry.setPayoutWallet(id)
   records msg.sender, so the page can only name the wallet that
   signs. Any wallet may declare itself for any box, so the page
   appends the box's code after the arguments (the contract ignores
   trailing calldata); the node adopts the wallet on its own when
   the declaring transaction carries the code it issued. Without a
   code the page sends nothing: the box would not adopt it.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import { Enclave } from "../core/api.js";
import { connectWallet, ensureBaseChain, sendTx } from "../core/wallet.js";
import { encBytes32, waitReceipt } from "../core/chain.js";
import { REGISTRY_ADDRESS } from "../core/config.js";
import { $, esc, on, showToast } from "../core/util.js";

const SET_PAYOUT = "0xd6a60cad";                  // setPayoutWallet(bytes32)
const ZERO = "0x0000000000000000000000000000000000000000";
const isId = (s) => /^0x[0-9a-fA-F]{64}$/.test(s || "");
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

let box = null, busy = false, sent = null;

function mount(){
  const body = $("#poBody"); if (!body) return;
  const id = new URLSearchParams(location.search).get("id");
  const code = (/(?:^|[#&])code=(0x[0-9a-f]{64})(?:&|$)/.exec(location.hash) || [])[1] || null;
  if (!isId(id)){ body.innerHTML = card("<p class=\"co-note\">This link names no box. Open it from <b>Payout wallet</b> in the Enclave tray on the box you host on.</p>"); return; }
  box = { id, code, name: new URLSearchParams(location.search).get("box") || "", payoutWallet: undefined, endpoint: "" };   // undefined: not read
  load().finally(() => render(body));
  on("enclave:addresses", () => render(body));
  document.addEventListener("enclave:wallet", () => render(body));
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b || busy) return;
    (b.dataset.act === "connect" ? connectWallet() : declare()).then(() => render(body), (err) => { showToast(err.message || String(err)); render(body); });
  });
}

/** What the fleet says about this box today (name, current payout wallet). */
async function load(){
  try {
    const r = await Enclave.getEnclaves();
    const rows = Array.isArray(r) ? r : (r.enclaves || r.rows || []);
    const row = rows.find((x) => String(x.id || "").toLowerCase() === box.id.toLowerCase());
    if (row){ box.payoutWallet = row.payoutWallet && row.payoutWallet !== ZERO ? row.payoutWallet : null; box.endpoint = row.endpoint || ""; box.name = box.name || row.name || ""; }
    else box.payoutWallet = null;
  } catch(e){}                                    // left undefined: said as "could not be read", never as "nobody"
}

async function declare(){
  if (!/^0x[0-9a-fA-F]{40}$/.test(REGISTRY_ADDRESS)) throw new Error("The registry address has not loaded yet. Try again in a moment.");
  busy = true; render($("#poBody"));
  try {
    if (!Enclave.provider) await connectWallet();
    await ensureBaseChain();
    // setPayoutWallet(id), then the box's one-time code: ignored by the contract, read back by the box
    const hash = await sendTx(REGISTRY_ADDRESS, SET_PAYOUT + encBytes32(box.id) + encBytes32(box.code));
    showToast("Declared · " + hash.slice(0, 12) + "…");
    await waitReceipt(hash);
    sent = { hash, wallet: Enclave.address };
    box.payoutWallet = Enclave.address;
  } finally { busy = false; }
}

function render(body){
  if (!body || !box) return;
  const me = Enclave.address || null;
  const label = box.name ? esc(box.name) : "this box";
  const facts = "<dl class=\"ss-facts\"><dt>box</dt><dd>" + label + (box.endpoint ? " · " + esc(box.endpoint) : "") + "</dd>" +
    "<dt>registry id</dt><dd><code>" + esc(box.id) + "</code></dd>" +
    "<dt>declared now</dt><dd>" + (box.payoutWallet === undefined ? "could not be read right now"
      : box.payoutWallet ? "<code>" + esc(box.payoutWallet) + "</code>" + (same(box.payoutWallet, me) ? " (this wallet)" : "") : "nobody") + "</dd></dl>";
  let act;
  if (!box.code){
    act = "<h3>Start from the box</h3><p>Open the Enclave tray on the box and choose <b>Payout wallet…</b>. It opens this page with a one-time code " +
      "from the box, so the box can tell your change apart from anyone else's. A link without one changes nothing, so this page sends nothing.</p>";
  } else if (sent && same(sent.wallet, me)){
    act = "<h3>Done. " + label.charAt(0).toUpperCase() + label.slice(1) + " now pays this wallet.</h3>" +
      "<p>The box recognises its code in this transaction and switches its payouts to <code>" + esc(me) + "</code> on its own, within a minute. " +
      "The tray shows it.</p><p class=\"co-note\">Transaction <code>" + esc(sent.hash) + "</code></p>";
  } else if (!me){
    act = "<h3>Connect the wallet you want paid</h3><p>WalletConnect works with mobile wallets and Trezor Suite; a browser extension works too.</p>" +
      "<button class=\"btn btn-primary\" data-act=\"connect\">Connect a wallet</button>";
  } else {
    act = "<h3>Declare <code>" + esc(me) + "</code></h3>" +
      "<p>One transaction on Base from this wallet (a few cents of gas). It names the wallet that signs it" +
      (same(box.payoutWallet, me) ? " (already declared, but not with this code)" : "") + ".</p>" +
      "<ul class=\"ss-lines\"><li>The transaction carries the one-time code from your box, so the box switches its payouts to this wallet on its own. " +
      "The code works once and for 30 minutes; for another change, start again from the tray.</li>" +
      "<li>Apps this wallet deploys run on " + label + " without hosting charges.</li></ul>" +
      "<button class=\"btn btn-primary\" data-act=\"declare\"" + (busy ? " disabled" : "") + ">" + (busy ? "Waiting for your wallet…" : "Declare this wallet") + "</button>";
  }
  body.innerHTML = "<div class=\"ss-card\">" + facts + "</div><div class=\"ss-card\">" + act + "</div>";
}

const card = (inner) => "<div class=\"ss-card\">" + inner + "</div>";

export function boot(){ mount(); }
