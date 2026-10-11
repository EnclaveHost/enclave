/* ============================================================
   /payout?id=<enclave id> - a box owner names their own wallet
   as the box's payout wallet. Opened from the hosting tray
   (windows/tray), which passes the box's registry id.

   The wallet declares ITSELF: EnclaveRegistry.setPayoutWallet(id)
   records msg.sender, so the page can only ever name the wallet
   that signs. That alone proves nothing about who owns the box
   (any wallet may declare itself for any box), so the box pays
   out only after its owner confirms the same address in the tray
   (windows/node/payout.mjs). This page says so rather than
   implying the declaration is the whole job.
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
  if (!isId(id)){ body.innerHTML = card("<p class=\"co-note\">This link names no box. Open it from <b>Payout wallet</b> in the Enclave tray on the box you host on.</p>"); return; }
  box = { id, name: new URLSearchParams(location.search).get("box") || "", payoutWallet: undefined, endpoint: "" };   // undefined: not read
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
    const hash = await sendTx(REGISTRY_ADDRESS, SET_PAYOUT + encBytes32(box.id));
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
  if (sent && same(sent.wallet, me)){
    act = "<h3>Declared. Now confirm it on the box.</h3>" +
      "<p>Open the Enclave tray on " + label + ", choose <b>Payout wallet</b>, and press <b>Confirm</b> next to <code>" + esc(me) + "</code>. " +
      "Until then nothing is paid to it.</p><p class=\"co-note\">Transaction <code>" + esc(sent.hash) + "</code></p>";
  } else if (!me){
    act = "<h3>Connect the wallet you want paid</h3><p>WalletConnect works with mobile wallets and Trezor Suite; a browser extension works too.</p>" +
      "<button class=\"btn btn-primary\" data-act=\"connect\">Connect a wallet</button>";
  } else if (same(box.payoutWallet, me)){
    act = "<h3>This wallet is already declared for " + label + "</h3><p>If the tray does not show it as confirmed yet, open <b>Payout wallet</b> there and press <b>Confirm</b>.</p>";
  } else {
    act = "<h3>Declare <code>" + esc(me) + "</code></h3>" +
      "<p>One transaction on Base from this wallet (a few cents of gas). It names the wallet that signs it, nothing else.</p>" +
      "<ul class=\"ss-lines\"><li>The box pays its earnings to this wallet only after you also confirm it in the tray on the box.</li>" +
      "<li>Apps this wallet deploys run on " + label + " without hosting charges.</li>" +
      "<li>Anyone can declare a wallet for any box; that is why the box asks its owner too. If the tray ever shows a wallet you do not recognise, do not confirm it.</li></ul>" +
      "<button class=\"btn btn-primary\" data-act=\"declare\"" + (busy ? " disabled" : "") + ">" + (busy ? "Waiting for your wallet…" : "Declare this wallet") + "</button>";
  }
  body.innerHTML = "<div class=\"ss-card\">" + facts + "</div><div class=\"ss-card\">" + act + "</div>";
}

const card = (inner) => "<div class=\"ss-card\">" + inner + "</div>";

export function boot(){ mount(); }
